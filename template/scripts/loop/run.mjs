#!/usr/bin/env node
// Boucle de tickets : une session Claude Code fraîche par ticket, puis des contrôles que la session
// ne peut pas contourner, puis un commit et un push. La session propose ; ce script décide.
//
//   node scripts/loop/run.mjs                 traite le prochain ticket prêt
//   node scripts/loop/run.mjs --max 5         jusqu'à cinq tickets à la suite
//   node scripts/loop/run.mjs --ticket T003   ce ticket précisément
//   node scripts/loop/run.mjs --dry-run       montre ce qui serait fait, sans rien lancer
//   --attempts <n> (sessions par ticket ; par défaut, de quoi monter jusqu'en haut de l'échelle des modèles)
//   --model <m> (fige le modèle, sans escalade)   --effort <e>   --no-push   --no-retro
//   --permission-mode auto   --budget-usd <n>   --timeout-min 120
//   --compact-window 200000 (plafond de contexte d'une session, en tokens ; 0 pour ne pas le fixer)
//
// Codes de sortie : 0 terminé, 1 refus au démarrage, 2 ticket bloqué, 3 push refusé.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../quality/config.mjs";
import { directions, isTest, measure } from "../quality/metrics.mjs";
import { readBaseline, tighten, writeBaseline } from "../quality/ratchet.mjs";
import { isHarnessFile } from "./harness-files.mjs";
import { attemptsToTop, displayName, levelOf, modelSettings, plan } from "./models.mjs";
import { RETRO_MODEL, runRetro } from "./retro.mjs";
import { ticketDir, unacceptedReview, unreviewedChange, untrackedPaths, writeUntrackedBefore } from "./reviewed-state.mjs";
import { awaitingDecision, describe, list, next, setStatus, spec, validate } from "./tickets.mjs";

const root = process.cwd();
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const options = {
  max: Number(option("--max", 1)),
  attempts: argv.includes("--attempts") ? Number(option("--attempts")) : null,
  ticket: option("--ticket", null),
  dryRun: flag("--dry-run"),
  push: !flag("--no-push"),
  retro: !flag("--no-retro"),
  model: option("--model", null),
  effort: option("--effort", null),
  permissionMode: option("--permission-mode", "auto"),
  budgetUsd: option("--budget-usd", null),
  timeoutMin: Number(option("--timeout-min", 120)),
  compactWindow: Number(option("--compact-window", 200000)),
};
// Configuration du projet : nom, mesures du cliquet, échelle de modèles. Illisible, la boucle refuse de démarrer.
let config = null;
let configError = "";
try {
  config = await loadConfig(root);
} catch (error) {
  configError = error.message;
}
const models = modelSettings(config?.models);
const stateDir = path.join(root, ".harness-state");
const loopDir = path.join(stateDir, "loop");
const lockFile = path.join(loopDir, "lock");

function sh(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...extra });
  return { code: result.status ?? 1, out: (result.stdout || "") + (result.stderr || ""), stdout: result.stdout || "", stderr: result.stderr || "" };
}
const git = (...args) => sh("git", args);
const say = (message) => console.log(`[boucle] ${message}`);

function machineLoad() {
  const load = { uptime: sh("uptime", []).stdout.trim() };
  if (process.platform === "darwin") load.swap = sh("sysctl", ["-n", "vm.swapusage"]).stdout.trim();
  return load;
}

function event(phase, data = {}) {
  fs.mkdirSync(loopDir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), phase, ...data, charge: machineLoad() });
  fs.appendFileSync(path.join(loopDir, "events.jsonl"), line + "\n");
}

function stop(code, message) {
  if (message) say(message);
  if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile);
  process.exit(code);
}

/** Entrées de `git status` : état sur deux lettres et chemins (deux pour un renommage). */
function statusEntries() {
  const entries = [];
  for (const line of git("status", "--porcelain", "--untracked-files=all").stdout.split("\n")) {
    if (!line.trim()) continue;
    const paths = line.slice(3).split(" -> ").map((p) => p.replace(/^"|"$/g, ""));
    entries.push({ status: line.slice(0, 2), paths });
  }
  return entries;
}

function preflight() {
  if (!fs.existsSync(path.join(root, "scripts/check.mjs"))) stop(1, "À lancer depuis la racine du projet.");
  if (!config) stop(1, `harness.config.mjs est illisible : ${configError}`);
  const branch = git("branch", "--show-current").stdout.trim();
  if (!branch) stop(1, "HEAD détachée : la boucle travaille sur une branche.");
  if (["main", "master"].includes(branch)) stop(1, `La boucle ne travaille pas sur ${branch} : créer une branche dédiée.`);
  const tracked = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
  if (tracked) stop(1, "Des fichiers suivis sont modifiés. Committer ou remiser avant de lancer la boucle :\n" + tracked);
  const problems = validate(list(root), models.levels);
  if (problems.length) stop(1, "File de tickets invalide :\n" + problems.join("\n"));
  if (!options.dryRun) {
    fs.mkdirSync(loopDir, { recursive: true });
    if (fs.existsSync(lockFile)) {
      const pid = Number(fs.readFileSync(lockFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        // Le processus n'existe plus : le verrou est un reste d'un arrêt brutal.
        alive = false;
      }
      if (alive) stop(1, `Une boucle tourne déjà (processus ${pid}).`);
    }
    fs.writeFileSync(lockFile, String(process.pid));
  }
  // `untrackedBefore` est lu par `git status -z`, comme l'état relu : un nom hors ASCII y est le même des deux côtés.
  return { branch, untracked: new Set(statusEntries().flatMap((e) => e.paths)), untrackedBefore: untrackedPaths(root) };
}

function compactions(dir) {
  const file = path.join(dir, "compactions.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

/** Ce que la session rapporte d'elle-même (message `result` de `claude -p`) : sert à calibrer la taille des tickets. */
function sessionReport(result, dir, compactionsBefore) {
  const report = { compactions: compactions(dir) - compactionsBefore };
  // Sans message `result` (session interrompue), seul le compte des compactions est connu.
  if (!result) return report;
  const usage = result.usage || {};
  report.session = result.session_id;
  report.tours = result.num_turns;
  report.duree_s = Math.round((result.duration_ms || 0) / 1000);
  report.cout_usd = result.total_cost_usd;
  report.tokens_sortie = usage.output_tokens;
  // Cumul sur tous les appels de la session : il suit le coût, pas la taille du contexte à un instant donné.
  report.tokens_lus_cumules = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  report.refus_de_permission = (result.permission_denials || []).length;
  report.refus = (result.permission_denials || []).map((d) => `${d.tool_name} ${JSON.stringify(d.tool_input || {})}`.slice(0, 300));
  const byModel = Object.entries(result.modelUsage || {}).map(([model, use]) => [model, Math.round((use.costUSD || 0) * 100) / 100]);
  report.cout_par_modele = Object.fromEntries(byModel);
  return report;
}

/** Ce que fait la session, une ligne par outil appelé : la cible plutôt que l'entrée entière. */
function actions(message) {
  if (message.type !== "assistant") return [];
  const indent = message.parent_tool_use_id ? "    " : "  ";
  const relative = (p) => (p && path.isAbsolute(p) ? path.relative(root, p) : p);
  return (message.message?.content || [])
    .filter((part) => part.type === "tool_use")
    .map(({ name, input = {} }) => {
      const target =
        name === "Agent" || name === "Task"
          ? `${input.subagent_type || ""} ${input.description || ""}`
          : name === "Bash"
            ? input.description || input.command
            : relative(input.file_path || input.path) || input.pattern || input.skill || "";
      return `${indent}${name} ${String(target).replace(/\s+/g, " ").trim()}`.slice(0, 160);
    });
}

/** Un sous-agent qui a rendu la main : son rôle, son modèle effectif et ce qu'il a consommé. */
function subAgent(message) {
  const done = message.type === "user" ? message.tool_use_result : null;
  if (!done || typeof done !== "object" || !done.agentType) return null;
  const { agentType, resolvedModel, totalTokens, totalToolUseCount, totalDurationMs } = done;
  return { role: agentType, modele: resolvedModel, tokens: totalTokens, outils: totalToolUseCount, duree_ms: totalDurationMs };
}

/** Lance la session en affichant ses actions au fil de l'eau ; garde le flux entier pour examen. */
function streamSession(bin, args, env, dir, attempt) {
  const started = Date.now();
  const clock = () => {
    const s = Math.round((Date.now() - started) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const stream = fs.createWriteStream(path.join(dir, `session-${attempt}.jsonl`));
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMin * 60 * 1000);
    let pending = "";
    let stderr = "";
    let result = null;
    const subAgents = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stream.write(chunk);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          // Ligne qui n'est pas du JSON : gardée dans le flux, rien à afficher.
          continue;
        }
        if (message.type === "result") result = message;
        const agent = subAgent(message);
        if (agent) subAgents.push(agent);
        for (const action of actions(message)) console.log(`[boucle] ${clock()}${action}`);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      stream.end();
      resolve({ code: code ?? 1, result, stderr, subAgents });
    });
  });
}

/**
 * Modèle de la tentative : un palier de l'échelle selon le niveau du ticket, un de plus à chaque tentative
 * refusée. `--model` fige le modèle de toutes les tentatives et laisse le relecteur hériter du sien.
 */
function sessionPlan(ticket, attempt) {
  const niveau = levelOf(ticket);
  if (options.model) return { niveau, modele: options.model, effort: options.effort, palier: null, relecteur: null };
  const step = plan(niveau, attempt, models);
  return { niveau, modele: step.model, effort: options.effort || step.effort, palier: step.rung, relecteur: step.reviewModel };
}

function attemptsFor(ticket) {
  if (options.attempts) return options.attempts;
  return options.model ? 3 : attemptsToTop(levelOf(ticket), models);
}

const usd = (n) => `${(n || 0).toFixed(2)} $`;

async function runSession(ticket, attempt, dir, failureReport, step) {
  const retry = failureReport
    ? ` C'est la tentative ${attempt} : une session précédente n'a pas abouti. Lis ${path.relative(root, failureReport)}` +
      " et le journal du ticket, regarde git status, puis reprends là où le travail s'est arrêté."
    : "";
  const prompt =
    `Traite le ticket ${ticket.id} (${ticket.file}) en suivant la skill « ticket » : lis d'abord` +
    ` .claude/skills/ticket/SKILL.md, puis le ticket en entier.${retry}` +
    ` Avant de terminer, écris ton verdict dans .harness-state/tickets/${ticket.id}/verdict.json.`;
  const args = ["-p", prompt, "--permission-mode", options.permissionMode, "--output-format", "stream-json", "--verbose"];
  args.push("--session-id", randomUUID(), "--name", `${config.project} ${ticket.id} tentative ${attempt}`);
  // Aucun serveur MCP du compte (messagerie, documents, navigateur) : un ticket n'en a pas besoin, et la session
  // tourne sans demander de permission.
  args.push("--strict-mcp-config");
  if (step.modele) args.push("--model", step.modele);
  if (step.effort) args.push("--effort", step.effort);
  if (options.budgetUsd) args.push("--max-budget-usd", options.budgetUsd);
  const env = {
    ...process.env,
    HARNESS_LOOP: "1",
    HARNESS_TICKET: ticket.id,
    HARNESS_TICKET_FILE: ticket.file,
    HARNESS_ALLOW_INSTALL: ticket.installe ? "1" : "0",
    HARNESS_EDIT: ticket.harnais ? "1" : "0",
    // Les sous-agents ne lancent pas eux-mêmes de sous-agents : trois rôles, un niveau.
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
  };
  // Le relecteur tourne sur le modèle du palier, ou plus haut : le hook guard-agent le lui impose.
  if (step.relecteur) env.HARNESS_REVIEW_MODEL = step.relecteur;
  // Plafond de contexte : au-delà la session se compacte. Une session de ticket qui l'atteint traite un ticket trop gros.
  if (options.compactWindow > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(options.compactWindow);
  const bin = process.env.HARNESS_CLAUDE_BIN || "claude";
  event("session", { ticket: ticket.id, attempt, ...step });
  say(`Tentative ${attempt} : ${step.modele || "modèle par défaut"}, effort ${step.effort || "par défaut"}, relecteur ${step.relecteur || "hérité"}.`);
  const compactionsBefore = compactions(dir);
  const result = await streamSession(bin, args, env, dir, attempt);
  if (result.result) fs.writeFileSync(path.join(dir, `session-${attempt}.json`), JSON.stringify(result.result));
  if (result.stderr) fs.writeFileSync(path.join(dir, `session-${attempt}.stderr`), result.stderr);
  const report = { ...sessionReport(result.result, dir, compactionsBefore), sous_agents: result.subAgents };
  event("session-terminee", { ticket: ticket.id, attempt, code: result.code, ...report });
  if (report.tours !== undefined) {
    say(`Session ${attempt} : ${report.tours} tours, ${report.duree_s} s, ${report.tokens_sortie} tokens produits, ${usd(report.cout_usd)}.`);
  }
  if (report.compactions) say(`La session s'est compactée ${report.compactions} fois : ce ticket est sans doute trop gros pour une session.`);
  return { code: result.code, report };
}

function readVerdict(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
  } catch (error) {
    // Pas de verdict lisible : la session s'est arrêtée sans conclure.
    return null;
  }
}

/** Contrôles de la boucle après une session qui se dit terminée. Renvoie la liste des refus. */
function gates(ticket, specBefore, untracked) {
  const problems = [];
  const text = fs.readFileSync(path.join(root, ticket.file), "utf8");
  if (spec(text) !== specBefore) problems.push("Le ticket a été modifié au-dessus de son journal (critères, périmètre ou en-tête).");
  const entries = statusEntries().filter((e) => !e.paths.every((p) => untracked.has(p)));
  const touched = entries.flatMap((e) => e.paths);
  if (!ticket.harnais) {
    const harness = touched.filter(isHarnessFile);
    if (harness.length) problems.push("Le harnais a été modifié sans que le ticket l'autorise : " + harness.join(", "));
  }
  if (!ticket.supprimeTests) {
    const testFile = (p) => p.startsWith(`${config.testDir}/`) || isTest(config, p);
    const deleted = entries.filter((e) => e.status.includes("D")).flatMap((e) => e.paths).filter(testFile);
    if (deleted.length) problems.push("Des fichiers de test ont été supprimés sans que le ticket l'autorise : " + deleted.join(", "));
  }
  if (ticket.adr) {
    const added = entries.filter((e) => /[?A]/.test(e.status)).flatMap((e) => e.paths);
    if (!added.some((p) => /^docs\/adr\/\d{4}-.+\.md$/.test(p))) problems.push("Le ticket demande un ADR et aucun n'a été ajouté dans docs/adr/.");
  }
  const unreviewed = unreviewedChange(root, ticket);
  if (unreviewed) problems.push(unreviewed);
  const unaccepted = unacceptedReview(root, ticket);
  if (unaccepted) problems.push(unaccepted);
  const check = sh(process.execPath, ["scripts/check.mjs"]);
  if (check.code !== 0) problems.push("Le contrôle qualité complet est rouge :\n" + check.out);
  return problems;
}

const totalCost = (history) => history.reduce((sum, h) => sum + (h.report.cout_usd || 0), 0);

/** Une réserve telle que la session l'a écrite : une chaîne telle quelle, toute autre valeur en JSON. */
const reserveText = (reserve) => (typeof reserve === "string" ? reserve : JSON.stringify(reserve));

/** Une réserve en élément de liste Markdown : ses lignes suivantes, indentées, restent dans l'élément. */
function reserveItem(reserve) {
  const [first, ...rest] = reserveText(reserve).trimEnd().split("\n");
  return [`- ${first}`, ...rest.map((line) => (line ? `  ${line}` : line))].join("\n");
}

/** Le ticket suivi du jalon de ses réserves, à la fin du journal ; inchangé sans réserve. */
function withReserves(text, reserves) {
  if (!reserves.length) return text;
  return `${text.trimEnd()}\n\n### Réserves à la clôture\n\n${reserves.map(reserveItem).join("\n")}\n`;
}

/** Paragraphes du message du commit : le texte des réserves reste dans le journal, en français ; le message dit leur nombre. */
function commitMessage(ticket, reserves, trailer) {
  const paragraphs = [`${ticket.id}: ${ticket.titre}`, `Ticket: ${ticket.file}`];
  if (reserves.length) paragraphs.push(`Reserves: ${reserves.length}, listed in the ticket journal.`);
  return [...paragraphs, trailer];
}

/** Commit (et push) du ticket. Renvoie le code de sortie de la boucle : 0, 2 si le commit échoue, 3 si le push est refusé. */
function integrate(ticket, branch, untracked, { step, verdict, history }) {
  const reserves = [verdict.reste].flat().filter(Boolean);
  const baseline = readBaseline(root);
  const senses = directions(config);
  if (baseline) writeBaseline(root, tighten(baseline, measure(root, config), senses), senses);
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, withReserves(setStatus(fs.readFileSync(file, "utf8"), "termine"), reserves));
  const paths = statusEntries().flatMap((e) => e.paths).filter((p) => !untracked.has(p));
  git("add", "-A", "--", ...paths);
  const trailer = `Co-Authored-By: ${displayName(step.modele)} <noreply@anthropic.com>`;
  const commit = git("commit", ...commitMessage(ticket, reserves, trailer).flatMap((paragraph) => ["-m", paragraph]));
  if (commit.code !== 0) return block(ticket, "Le commit a échoué :\n" + commit.out, history);
  const head = git("rev-parse", "--short", "HEAD").stdout.trim();
  const integrated = { ticket: ticket.id, commit: head, modele: step.modele, tentatives: history.length, cout_usd: totalCost(history) };
  event("integre", reserves.length ? { ...integrated, reserves } : integrated);
  say(`${ticket.id} intégré (${head}) en ${history.length} tentative(s), ${usd(totalCost(history))}.`);
  if (reserves.length) say(`Réserves de la session : ${reserves.map(reserveText).join(" ; ")}`);
  if (!options.push) return 0;
  const push = git("push", "-u", "origin", branch);
  if (push.code !== 0) {
    event("push-refuse", { ticket: ticket.id, sortie: push.out.slice(-2000) });
    say("Le commit est fait mais le push a échoué. Rien d'autre n'est lancé :\n" + push.out);
    return 3;
  }
  say(`Poussé sur origin/${branch}.`);
  return 0;
}

function block(ticket, why, history) {
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, "utf8"), "bloque"));
  event("bloque", { ticket: ticket.id, raison: why.slice(0, 2000), tentatives: history.length, cout_usd: totalCost(history) });
  say(`${ticket.id} est bloqué : ${why}\nLe travail en cours est laissé tel quel dans le dossier, pour examen.`);
  return 2;
}

/** Traite un ticket jusqu'à l'intégration ou au blocage. Renvoie le code de sortie et ce qui s'est passé, pour la rétrospective. */
async function processTicket(ticket, context) {
  const dir = ticketDir(root, ticket.id);
  // La session ne connaît pas les fichiers non suivis d'avant elle : sans cette liste, ils entreraient dans l'état relu.
  writeUntrackedBefore(dir, context.untrackedBefore);
  const file = path.join(root, ticket.file);
  const specBefore = spec(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, "utf8"), "en-cours"));
  say(`${ticket.id} — ${ticket.titre} (niveau ${levelOf(ticket)})`);
  const history = [];
  const ended = (code, outcome, reason) => ({ code, outcome, reason, history });
  const attempts = attemptsFor(ticket);
  let failureReport = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Un verdict d'une tentative précédente ne vaut pas pour celle-ci.
    fs.rmSync(path.join(dir, "verdict.json"), { force: true });
    const step = sessionPlan(ticket, attempt);
    const { code, report } = await runSession(ticket, attempt, dir, failureReport, step);
    const entry = { attempt, plan: step, report, failure: null };
    history.push(entry);
    const verdict = readVerdict(dir);
    let failure;
    if (!verdict) failure = `La session s'est terminée sans verdict (code de sortie ${code}).`;
    else if (verdict.statut === "BLOQUÉ") {
      const why = verdict.resume || "la session s'est déclarée bloquée sans dire pourquoi";
      return ended(block(ticket, why, history), "bloqué", why);
    } else if (verdict.statut === "PARTIEL") {
      failure = "La session s'est déclarée PARTIELLE. Reste à faire : " + JSON.stringify(verdict.reste || verdict.resume || "");
    } else if (verdict.statut === "TERMINÉ") {
      const problems = gates(ticket, specBefore, context.untracked);
      if (!problems.length) {
        const code = integrate(ticket, context.branch, context.untracked, { step, verdict, history });
        return ended(code, code === 2 ? "bloqué" : "intégré", code === 3 ? "push refusé" : null);
      }
      failure = "La session s'est déclarée TERMINÉE mais la boucle refuse l'intégration :\n\n" + problems.join("\n\n");
    } else failure = `Verdict illisible : statut « ${verdict.statut} ».`;
    entry.failure = failure;
    failureReport = path.join(dir, `echec-${attempt}.txt`);
    fs.writeFileSync(failureReport, failure + "\n");
    event("tentative-refusee", { ticket: ticket.id, attempt, raison: failure.slice(0, 2000) });
    say(`Tentative ${attempt} refusée : ${failure.split("\n")[0]}`);
  }
  const why = `${attempts} tentative(s) sans aboutir. Dernier refus : ${path.relative(root, failureReport)}`;
  return ended(block(ticket, why, history), "bloqué", why);
}

/** Rétrospective du ticket : propose des améliorations du harnais. Son échec n'arrête jamais la boucle. */
function retrospective(ticket, run) {
  say("Rétrospective du ticket…");
  const bin = process.env.HARNESS_CLAUDE_BIN || "claude";
  const retroOptions = { bin, permissionMode: options.permissionMode, model: config.models.retro || RETRO_MODEL, project: config.project };
  const { added, cost, problem } = runRetro(root, ticket, ticketDir(root, ticket.id), run, retroOptions);
  if (problem) {
    event("retro-echouee", { ticket: ticket.id, raison: problem.slice(0, 2000) });
    say(`La rétrospective a échoué, la boucle continue : ${problem.split("\n")[0]}`);
    return;
  }
  event("retro", { ticket: ticket.id, observations: added.length, cout_usd: cost });
  say(`Rétrospective : ${added.length} observation(s), ${usd(cost)}. À trancher : node scripts/loop/retro.mjs liste`);
}

const context = preflight();
for (let done = 0; done < options.max; done++) {
  const wanted = done === 0 ? options.ticket : null;
  const queue = list(root);
  const { ticket, reason } = next(queue, wanted);
  // Un ticket demandé qui ne peut pas partir est un refus au démarrage ; une file sans ticket prêt est une fin normale.
  if (!ticket) stop(wanted ? 1 : 0, reason);
  // Un ticket hors de Git resterait hors de son propre commit : ni son journal ni son statut n'y entreraient.
  if (git("ls-files", "--error-unmatch", "--", ticket.file).code !== 0) {
    stop(1, `${ticket.id} n'est pas suivi par Git (${ticket.file}) : committer le ticket avant de lancer la boucle.`);
  }
  // Une fois par lancement : sans cette ligne, un ticket sauté parce qu'il attend une décision passerait inaperçu.
  const asking = awaitingDecision(queue);
  if (done === 0 && asking.length) say(`En attente d'une décision du propriétaire : ${asking.join(", ")}.`);
  if (options.dryRun) {
    const first = sessionPlan(ticket, 1);
    say(`Prochain ticket : ${ticket.id} — ${ticket.titre} (${ticket.file}), niveau ${first.niveau}`);
    say(`Session : claude -p … --permission-mode ${options.permissionMode}, ${attemptsFor(ticket)} tentative(s) au plus.`);
    say(`Première tentative : ${first.modele || "modèle par défaut"}, effort ${first.effort || "par défaut"}, relecteur ${first.relecteur || "hérité"}.`);
    say(options.push ? `Après contrôle : commit puis push sur origin/${context.branch}.` : "Après contrôle : commit local, sans push.");
    stop(0);
  }
  const run = await processTicket(ticket, context);
  if (options.retro) retrospective(ticket, run);
  if (run.code !== 0) stop(run.code);
}
stop(0, "Nombre de tickets demandé atteint.");
