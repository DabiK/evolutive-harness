// OpenCode écrit ; un processus Claude séparé juge l'état enregistré avant les contrôles de la boucle.
//
// Une tentative est une session OpenCode (`opencode run --standalone`, agent `ticket-opencode`) que la boucle reprend
// par `--session` : après un refus de fin de `.claude/hooks/stop-gate.mjs` (OpenCode n'a pas de fin de tour bloquante),
// puis après chaque relecture à corriger. Chaque invocation doit laisser le témoin de démarrage écrit par le plugin
// `.opencode/plugins/harness.js` : sans lui, les garde-fous n'ont pas tourné et la tentative est refusée.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { reviewAndCorrect } from "./claude-review.mjs";
import { invocationState, MAX_DIAGNOSTIC_LENGTH, streamOpencode } from "./opencode-stream.mjs";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const OPENCODE_SKILL = ".agents/skills/ticket-opencode/SKILL.md";
const OPENCODE_AGENT = "ticket-opencode";
const STOP_GATE_TIMEOUT_MS = 300 * MS_PER_SECOND;
const EXPORT_TIMEOUT_MS = 120 * MS_PER_SECOND;
const MAX_EXPORT_OUTPUT = 256 * 1024 * 1024;

/**
 * Dossier de configuration globale d'OpenCode pour la boucle, vide : ni serveurs MCP, ni plugins, ni agents, ni consignes
 * de la configuration personnelle. Les identifiants des fournisseurs restent dans le dossier de données d'OpenCode.
 */
export const isolatedConfigDir = (root) => path.join(root, ".harness-state", "opencode", "config");

function sessionEnv(root, ticket) {
  return {
    ...process.env,
    HARNESS_LOOP: "1",
    HARNESS_ENGINE: "opencode",
    HARNESS_TICKET: ticket.id,
    HARNESS_TICKET_FILE: ticket.file,
    HARNESS_EDIT: ticket.harnais ? "1" : "0",
    HARNESS_ALLOW_INSTALL: ticket.installe ? "1" : "0",
    OPENCODE_CONFIG_DIR: isolatedConfigDir(root),
  };
}

/** Arguments de `opencode run` : une session neuve porte un titre, une reprise l'identifiant de sa session. */
export function opencodeArgs(step, { session = null, title = "" } = {}) {
  const model = step.effort ? `${step.modele}#${step.effort}` : step.modele;
  return [
    "run", "--standalone", "--format", "json", "--agent", OPENCODE_AGENT,
    ...(session ? ["--session", session] : ["--title", title]),
    ...(model ? ["-m", model] : []),
  ];
}

function readMarker(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // Un témoin absent ou illisible ne prouve pas le chargement du plugin.
    return null;
  }
}

const MISSING_PLUGIN = "plugin OpenCode non chargé : aucun témoin de démarrage valide pour cette session et ce lancement." +
  " Cause probable : .opencode/plugins/harness.js absent ou en erreur, node introuvable pour ses hooks, ou session hors du dépôt.";

/** Une invocation : un processus `opencode run`, son témoin de démarrage et son compte rendu. */
async function invoke(root, run, request) {
  const { dir, env, file, step, title, timeoutMs, started, event, ticket } = run;
  const marker = path.join(dir, "hooks-started.json");
  fs.rmSync(marker, { force: true });
  fs.rmSync(env.OPENCODE_CONFIG_DIR, { recursive: true, force: true });
  fs.mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
  const invocation = randomUUID();
  const state = invocationState();
  const launched = Date.now();
  const args = opencodeArgs(step, { session: request.session, title });
  const code = await streamOpencode(root, args, {
    env: { ...env, HARNESS_HOOK_RUN: invocation }, prompt: request.prompt, file, state, timeoutMs, started,
  });
  const witness = readMarker(marker);
  if (request.session && state.session && state.session !== request.session) {
    state.problem = `OpenCode : session changée lors de la reprise : ${request.session} attendue, ${state.session} reçue. ${state.problem || ""}`.trim();
  } else if (state.session && (witness?.session !== state.session || witness?.run !== invocation)) {
    // Une session tombée avant son premier message n'a pas pu écrire de témoin : sa propre erreur passe d'abord.
    state.problem = [state.problem, MISSING_PLUGIN].filter(Boolean).join(" ");
  }
  state.problem = state.problem?.slice(0, MAX_DIAGNOSTIC_LENGTH) ?? null;
  const report = {
    invocation, session: state.session, reprise: Boolean(request.session), code: state.problem ? 1 : code, etapes: state.steps,
    cout_flux_usd: state.cost, erreurs_outils: state.toolErrors, duree_ms: Date.now() - launched, problem: state.problem,
  };
  run.invocations.push(report);
  event("invocation-terminee", { ticket: ticket.id, attempt: run.attempt, ...report });
  return { ...report, started: state.steps > 0 };
}

/** Refus de fin de session par stop-gate.mjs, comme le hook Stop de Claude et de Codex : sa raison, ou null. */
function stopRefusal(root, env, session) {
  const input = JSON.stringify({ session_id: session, cwd: root, hook_event_name: "Stop" });
  const result = spawnSync(process.execPath, [path.join(root, ".claude/hooks/stop-gate.mjs")], {
    cwd: root, env: { ...env, CLAUDE_PROJECT_DIR: root }, input, encoding: "utf8", timeout: STOP_GATE_TIMEOUT_MS,
  });
  try {
    const output = JSON.parse(result.stdout || "null");
    return output?.decision === "block" ? String(output.reason || "Fin de session refusée.") : null;
  } catch (error) {
    // Une porte de fin muette ou illisible laisse aux contrôles de la boucle le dernier mot.
    return null;
  }
}

/**
 * Une consigne jusqu'à une fin de session acceptée : reprise de la session tant que stop-gate refuse sa fin, et repli sur
 * une session neuve si une reprise échoue avant tout travail. Rend le code de la dernière invocation.
 */
async function session(root, run, prompt, resume) {
  let result = await invoke(root, run, { prompt, session: resume });
  if (resume && result.code !== 0 && !result.started) {
    run.event("reprise-impossible", { ticket: run.ticket.id, attempt: run.attempt, session: resume, raison: result.problem });
    result = await invoke(root, run, { prompt: `${prompt}\n\nLa reprise de ta session a échoué : relis aussi ${OPENCODE_SKILL}.` });
  }
  run.session = result.session || run.session;
  run.problem = result.problem;
  if (result.code !== 0) return result.code;
  // stop-gate.mjs compte ses refus par session et n'en oppose que deux : la reprise s'arrête d'elle-même.
  let refusal = stopRefusal(root, run.env, run.session);
  while (refusal) {
    const continued = await invoke(root, run, { prompt: `La boucle refuse la fin de ta session : ${refusal}`, session: run.session });
    run.problem = continued.problem;
    if (continued.code !== 0) return continued.code;
    refusal = stopRefusal(root, run.env, run.session);
  }
  return 0;
}

/** Compactions tracées par le plugin (hook record-compaction) dans le dossier du ticket. */
function compactions(dir) {
  const file = path.join(dir, "compactions.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

/** Coût et jetons de chaque session, lus dans son export ; null si un export manque ou ne se lit pas. */
function sessionUsage(root, env, sessions) {
  const usage = { cout_usd: 0, jetons: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 } };
  for (const id of sessions) {
    const result = spawnSync(env.HARNESS_OPENCODE_BIN || "opencode", ["session", "export", id, "--standalone"], {
      cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: EXPORT_TIMEOUT_MS, maxBuffer: MAX_EXPORT_OUTPUT,
    });
    let info;
    try {
      info = JSON.parse(result.stdout).info;
    } catch (error) {
      // Sans export lisible, le coût de la tentative reste inconnu plutôt que sous-estimé.
      info = null;
    }
    if (result.status !== 0 || !Number.isFinite(info?.cost)) return { cout_usd: null, jetons: null };
    usage.cout_usd += info.cost;
    const tokens = info.tokens || {};
    for (const field of ["input", "output", "reasoning"]) usage.jetons[field] += tokens[field] || 0;
    usage.jetons.cache_read += tokens.cache?.read || 0;
    usage.jetons.cache_write += tokens.cache?.write || 0;
  }
  return usage;
}

export async function runOpencode(root, ticket, attempt, dir, failureReport, step, { event, timeoutMin, project = "projet" }) {
  const started = Date.now();
  const timeoutMs = timeoutMin * SECONDS_PER_MINUTE * MS_PER_SECOND;
  const env = sessionEnv(root, ticket);
  const retry = failureReport ? ` Lis ${path.relative(root, failureReport)} et le journal, puis reprends le travail.` : "";
  const prompt = `Traite le ticket ${ticket.id} (${ticket.file}) en suivant ${OPENCODE_SKILL}.${retry}` +
    ` Avant de terminer, écris ton verdict dans .harness-state/tickets/${ticket.id}/verdict.json.`;
  event("session", { ticket: ticket.id, attempt, moteur: "opencode", ...step });
  const file = path.join(dir, `opencode-${attempt}.jsonl`);
  fs.writeFileSync(file, "");
  const title = `${project} ${ticket.id} tentative ${attempt}`;
  const run = { dir, env, file, step, title, timeoutMs, started, event, ticket, attempt, invocations: [], session: null, problem: null };
  const compactionsBefore = compactions(dir);
  const first = await session(root, run, prompt, null);
  const correct = (fix) => session(root, run, fix, run.session);
  const reviewed = await reviewAndCorrect({ root, ticket, dir, env, step, timeoutMs, skill: OPENCODE_SKILL, code: first, correct });
  const { code, relectures, reserves } = reviewed;
  const problem = reviewed.problem || (code === 0 ? null : run.problem);
  const sessions = [...new Set(run.invocations.map((entry) => entry.session).filter(Boolean))];
  const report = {
    moteur: "opencode", session: run.session, sessions, invocations: run.invocations,
    tours: run.invocations.reduce((sum, entry) => sum + entry.etapes, 0), ...sessionUsage(root, env, sessions),
    duree_s: Math.round((Date.now() - started) / MS_PER_SECOND), relectures, compactions: compactions(dir) - compactionsBefore,
  };
  event("session-terminee", { ticket: ticket.id, attempt, code, ...report });
  return { code, report, problem, reserves };
}
