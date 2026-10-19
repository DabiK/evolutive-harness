// Le superviseur garde la commande et ses descripteurs ; seul son enfant admis traite les tickets.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Chargé avant les modules de travail : même leur erreur d'évaluation doit rejoindre le journal du superviseur.
if (process.send) {
  process.on("uncaughtExceptionMonitor", (error) => {
    if (!process.connected) return;
    process.send({ type: "loop-worker-failed", reason: error.message, code: error.code ?? "LOOP_MODULE_FAILED" }, () => {
      // Le processus va sortir : un canal déjà fermé ne peut plus recevoir son diagnostic.
    });
  });
}

const lockPath = (root) => path.join(root, ".harness-state/loop/lock");

/** Un canal IPC direct est requis : aucun fichier ni argument de commande n'autorise une relève. */
export function receiveLaunch() {
  if (!process.send) return null;
  return new Promise((resolve, reject) => {
    process.once("message", (message) => {
      if (message.type !== "loop-start") reject(new Error("Protocole de démarrage de la boucle invalide."));
      else resolve(message.state);
    });
    process.once("disconnect", () => {
      // Le superviseur disparu, cet enfant ne peut plus conserver l'exclusivité du lancement.
      process.exit(1);
    });
  });
}

function exchange(type, reply, data = {}) {
  return new Promise((resolve) => {
    const received = (message) => {
      if (message.type !== reply) return;
      process.off("message", received);
      resolve();
    };
    process.on("message", received);
    process.send({ type, ...data });
  });
}

export const admitWorker = () => exchange("loop-ready", "loop-admitted");
export const retireWorker = (state) => exchange("loop-restart", "loop-retired", { state });

/** Le renommage ne libère jamais le verrou ; son instant d'origine reste l'identité lue par les vues. */
function transferLock(root, from, to) {
  const file = lockPath(root);
  if (fs.readFileSync(file, "utf8") !== String(from)) throw new Error("Le propriétaire du verrou de boucle a changé.");
  const stat = fs.statSync(file);
  const temporary = `${file}.${process.pid}`;
  try {
    fs.writeFileSync(temporary, String(to), { flag: "wx" });
    fs.utimesSync(temporary, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function runWorker(root, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, path.join(root, "scripts/loop/run.mjs"), ...process.argv.slice(2)], {
      cwd: root, env: process.env, stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    let restart = null;
    let problem = null;
    let failure = null;
    let admitted = false;
    const interrupt = (signal) => child.kill(signal);
    const terminate = () => interrupt("SIGTERM");
    const cancel = () => interrupt("SIGINT");
    process.on("SIGTERM", terminate);
    process.on("SIGINT", cancel);
    const fail = (error) => {
      problem = error;
      child.kill("SIGTERM");
    };
    child.on("error", fail);
    child.on("message", (message) => {
      try {
        if (message.type === "loop-ready") {
          transferLock(root, process.pid, child.pid);
          admitted = true;
          child.send({ type: "loop-admitted" }, (error) => { if (error) fail(error); });
        } else if (message.type === "loop-restart") {
          transferLock(root, child.pid, process.pid);
          restart = message.state;
          child.send({ type: "loop-retired" }, (error) => { if (error) fail(error); });
        } else if (message.type === "loop-worker-failed") {
          failure = Object.assign(new Error(message.reason), { code: message.code });
        }
      } catch (error) {
        fail(error);
      }
    });
    child.on("close", (code, signal) => {
      process.off("SIGTERM", terminate);
      process.off("SIGINT", cancel);
      if (problem) reject(problem);
      else resolve({ code: code ?? 1, signal, restart: code === 0 ? restart : null, admitted, failure });
    });
    child.send({ type: "loop-start", state }, (error) => { if (error) fail(error); });
  });
}

/** Attend la sortie de chaque instance avant de charger la suivante ; le superviseur ne traite aucun ticket. */
export async function supervise(root, state, { event, say }) {
  try {
    const result = await runWorker(root, state);
    if (!result.restart) {
      if ((state.done > 0 || state.quotaResume) && !result.admitted && (result.code !== 0 || result.signal)) {
        if (result.failure) throw result.failure;
        const reason = result.signal ? `signal ${result.signal}` : `code ${result.code}`;
        throw new Error(`La nouvelle instance de boucle a échoué (${reason}).`);
      }
      // Les relais sont retirés : conserver le signal natif sans atteindre stop() et son code de sortie.
      if (result.signal) return new Promise(() => process.kill(process.pid, result.signal));
      return result.code;
    }
    const next = { ...state, ...result.restart };
    event("relance", { termines: next.done, integres: next.integrated });
    // Ce propriétaire peut lui-même avoir été intégré ; son graphe ne contient que des builtins.
    const owner = await import(`${pathToFileURL(path.join(root, "scripts/loop/restart.mjs")).href}?generation=${next.done}`);
    return owner.supervise(root, next, { event, say });
  } catch (error) {
    event("relance-echouee", { raison: error.message, cause: error.code ?? "LOOP_WORKER_FAILED" });
    say(`La relève de la boucle a échoué : ${error.message} Aucun ticket suivant n'est lancé.`);
    return 1;
  }
}

/** Sans détection des renommages, Git donne les deux côtés d'un déplacement et les suppressions. */
export function integratedModules(git, before) {
  const changed = git("diff", "--name-only", "--no-renames", "-z", before, "HEAD", "--", "scripts/loop/", "scripts/quality/");
  if (changed.code !== 0) throw new Error(`Lecture des chemins intégrés impossible : ${changed.out}`);
  return changed.stdout.split("\0").filter((file) => /\.(?:mjs|cjs)$/.test(file));
}
