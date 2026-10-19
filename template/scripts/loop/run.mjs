#!/usr/bin/env node
// Boucle de tickets : une session d'agent fraîche par ticket, puis des contrôles que la session
// ne peut pas contourner, puis un commit et un push. La session propose ; ce script décide.
//
//   node scripts/loop/run.mjs                 traite le prochain ticket prêt
//   node scripts/loop/run.mjs --max 5         jusqu'à cinq tickets à la suite
//   node scripts/loop/run.mjs --ticket T003   ce ticket précisément
//   node scripts/loop/run.mjs --dry-run       montre ce qui serait fait, sans rien lancer
//   --attempts <n> (sessions par ticket ; par défaut, de quoi monter jusqu'en haut de l'échelle des modèles)
//   --model <m> (fige le modèle, sans escalade)   --effort <e>   --no-push   --no-retro
//   --engine codex --fallback-engine claude (une relève après quota ; modèle/effort deviennent le palier Claude)
//   --engine opencode (OpenCode explore et implémente, Claude relit ; --effort devient la variante du modèle)
//   --permission-mode auto   --budget-usd <n>   --timeout-min 120
//   --compact-window 200000 (plafond de contexte d'une session, en tokens ; 0 pour ne pas le fixer)
//   --tune-every <n> (harmonise les consignes du harnais tous les n tickets intégrés ; 0, par défaut, jamais)
//
// Codes de sortie : 0 terminé, 1 refus au démarrage, 2 ticket bloqué, 3 push refusé,
// 4 harmonisation refusée que la boucle n'a pas pu défaire (arbre laissé sale, aucun ticket lancé ensuite),
// 5 quota Codex épuisé (ticket à faire, travail conservé, reprise annoncée ou absence indiquée).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { admitWorker, integratedModules, receiveLaunch, retireWorker, supervise } from "./restart.mjs";
import { runCodex } from "./codex.mjs";
import { runOpencode } from "./opencode.mjs";
import { quotaDiagnostic } from "./codex-quota.mjs";
import { captureQuotaHandoff, consumeQuotaHandoff, fingerprintUntracked, preexistingChange, reviewFingerprint } from "./quota-handoff.mjs";
import { loadConfig } from "../quality/config.mjs";
import { isTest } from "../quality/metrics.mjs";
import { BASELINE } from "../quality/ratchet.mjs";
import { isHarnessFile } from "./harness-files.mjs";
import { attemptsToTop, displayName, levelOf, modelSettings, plan } from "./models.mjs";
import { RETRO_MODEL, runRetro } from "./retro.mjs";
import {
  readUntrackedBefore, statusEntries as readStatusEntries, ticketDir, UNTRACKED_BEFORE,
  unacceptedReview, unreviewedChange, untrackedPaths, writeUntrackedBefore,
} from "./reviewed-state.mjs";
import { awaitingDecision, describe, list, next, setStatus, spec, validate } from "./tickets.mjs";
import { tuneInstructions } from "./tune.mjs";

const root = process.cwd();
const launch = await receiveLaunch();
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const tuneEveryArg = option("--tune-every", "0");
const options = launch?.options ?? {
  engine: option("--engine", "claude"),
  fallbackEngine: flag("--fallback-engine") ? option("--fallback-engine", "") ?? "" : null,
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
  // Un nombre de tickets : un entier, 0 ou plus. Toute autre valeur est refusée au démarrage (null).
  tuneEvery: /^\d+$/.test(tuneEveryArg ?? "") ? Number(tuneEveryArg) : null,
};
// Configuration du projet : nom, dossier des tests, échelles de modèles. Illisible, la boucle refuse de démarrer.
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
const QUOTA_EXIT_CODE = 5;
// Moteurs qui explorent et implémentent hors de Claude ; la boucle fait relire leur travail par un processus Claude séparé.
const EXTERNAL_ENGINES = { codex: runCodex, opencode: runOpencode };
const COMMIT_EMAILS = { claude: "noreply@anthropic.com", codex: "noreply@openai.com", opencode: "noreply@opencode.ai" };
const SESSION_COMMANDS = { codex: "codex exec --json", opencode: "opencode run --standalone --format json" };

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

const statusEntries = () => readStatusEntries(root);

function acquireLock() {
  if (launch) {
    if (fs.readFileSync(lockFile, "utf8") !== String(process.ppid)) stop(1, "La relève ne possède pas le verrou du superviseur.");
  } else if (!options.dryRun) {
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
      fs.rmSync(lockFile);
    }
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      stop(1, "Une autre boucle a pris le verrou.");
    }
  }
}

function claudeFallbackOptions() {
  return options.engine === "claude" && options.fallbackEngine === null && options.model === null && options.effort === null;
}

function interruptedCodexAttempt(resume) {
  const last = Array.isArray(resume.history) ? resume.history.at(-1) : null;
  return last?.interrupted && last.report?.moteur === "codex" && last.attempt === resume.attempt;
}

function validResumeAttempts({ attempt, attempts }) {
  return Number.isInteger(attempt) && Number.isInteger(attempts) && attempt >= 1 && attempt <= attempts;
}

function receiveQuotaWork() {
  try {
    const resume = launch.quotaResume;
    if (!claudeFallbackOptions() || !interruptedCodexAttempt(resume) || !validResumeAttempts(resume)) {
      throw new Error("État de reprise après quota incomplet.");
    }
    resume.source = consumeQuotaHandoff(root, resume.handoff, {
      ...resume, untrackedBefore: launch.untrackedBefore, preexisting: launch.preexisting,
    });
  } catch (error) {
    stop(1, `La relève Claude est refusée : ${error.message}`);
  }
}

function preflight() {
  if (!["claude", ...Object.keys(EXTERNAL_ENGINES)].includes(options.engine)) stop(1, "--engine attend claude, codex ou opencode.");
  if (!launch && argv.filter(arg => arg === "--fallback-engine").length > 1) stop(1, "--fallback-engine ne se précise qu'une fois.");
  if (options.fallbackEngine !== null && (options.engine !== "codex" || options.fallbackEngine !== "claude")) {
    stop(1, "--fallback-engine attend claude, uniquement avec --engine codex.");
  }
  if (!fs.existsSync(path.join(root, "scripts/check.mjs"))) stop(1, "À lancer depuis la racine du projet.");
  if (!config) stop(1, `harness.config.mjs est illisible : ${configError}`);
  if (options.tuneEvery === null) stop(1, `--tune-every attend un nombre entier de tickets, 0 ou plus (0 : jamais), pas « ${tuneEveryArg ?? ""} ».`);
  const branch = git("branch", "--show-current").stdout.trim();
  if (!branch) stop(1, "HEAD détachée : la boucle travaille sur une branche.");
  if (["main", "master"].includes(branch)) stop(1, `La boucle ne travaille pas sur ${branch} : créer une branche dédiée.`);
  const tracked = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
  if (tracked && !launch?.quotaResume) stop(1, "Des fichiers suivis sont modifiés. Committer ou remiser avant de lancer la boucle :\n" + tracked);
  const problems = validate(list(root), models.levels);
  if (problems.length) stop(1, "File de tickets invalide :\n" + problems.join("\n"));
  acquireLock();
  if (launch?.quotaResume) receiveQuotaWork();
  // `untrackedBefore` est lu par `git status -z`, comme l'état relu : un nom hors ASCII y est le même des deux côtés.
  const untrackedBefore = launch?.untrackedBefore ?? untrackedPaths(root);
  try {
    const preexisting = launch?.preexisting ?? (options.fallbackEngine ? fingerprintUntracked(root, untrackedBefore) : null);
    return { branch, untracked: new Set(launch?.untracked ?? untrackedBefore), untrackedBefore, preexisting };
  } catch (error) {
    stop(1, error.message);
  }
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
    let startupError = null;
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
    child.on("error", (error) => { startupError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      stream.end();
      resolve({ code: code ?? 1, result, stderr, subAgents, startupError });
    });
  });
}

/**
 * Modèle de la tentative : un palier de l'échelle selon le niveau du ticket, un de plus à chaque tentative
 * refusée. Avec Claude, `--model` laisse le relecteur hériter ; un moteur externe garde un relecteur Claude séparé.
 */
function sessionPlan(ticket, attempt) {
  const niveau = levelOf(ticket);
  const step = plan(niveau, attempt, models, options.engine);
  if (options.model) {
    const external = Object.hasOwn(EXTERNAL_ENGINES, options.engine);
    const effort = options.effort || (external ? step.effort : null);
    return { niveau, modele: options.model, effort, palier: null, relecteur: external ? step.reviewModel : null };
  }
  return { niveau, modele: step.model, effort: options.effort || step.effort, palier: step.rung, relecteur: step.reviewModel };
}

function attemptsFor(ticket) {
  if (options.attempts) return options.attempts;
  return options.model ? 3 : attemptsToTop(levelOf(ticket), models);
}

const usd = (n) => (n === null ? "coût indisponible" : `${(n || 0).toFixed(2)} $`);

/**
 * Lance `claude -p` pour une session de la boucle, de ticket ou d'harmonisation, et rend compte de ce qu'elle a coûté.
 * `env` porte les variables propres au type de session ; `HARNESS_LOOP` et `HARNESS_TICKET` (`id`) valent pour toutes.
 */
async function launchSession({ id, attempt, dir, prompt, name, step, env }) {
  const args = ["-p", prompt, "--permission-mode", options.permissionMode, "--output-format", "stream-json", "--verbose"];
  args.push("--session-id", randomUUID(), "--name", name);
  // Aucun serveur MCP du compte (messagerie, documents, navigateur) : un ticket n'en a pas besoin, et la session
  // tourne sans demander de permission.
  args.push("--strict-mcp-config");
  if (step.modele) args.push("--model", step.modele);
  if (step.effort) args.push("--effort", step.effort);
  if (options.budgetUsd) args.push("--max-budget-usd", options.budgetUsd);
  const sessionEnv = {
    ...process.env,
    HARNESS_LOOP: "1",
    HARNESS_TICKET: id,
    ...env,
    // Les sous-agents ne lancent pas eux-mêmes de sous-agents : trois rôles, un niveau.
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
  };
  // Le relecteur tourne sur le modèle du palier, ou plus haut : le hook guard-agent le lui impose.
  if (step.relecteur) sessionEnv.HARNESS_REVIEW_MODEL = step.relecteur;
  // Plafond de contexte : au-delà la session se compacte. Une session de ticket qui l'atteint traite un ticket trop gros.
  if (options.compactWindow > 0) sessionEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(options.compactWindow);
  const bin = process.env.HARNESS_CLAUDE_BIN || "claude";
  event("session", { ticket: id, attempt, ...step });
  const compactionsBefore = compactions(dir);
  const result = await streamSession(bin, args, sessionEnv, dir, attempt);
  if (result.result) fs.writeFileSync(path.join(dir, `session-${attempt}.json`), JSON.stringify(result.result));
  if (result.stderr) fs.writeFileSync(path.join(dir, `session-${attempt}.stderr`), result.stderr);
  const report = { ...sessionReport(result.result, dir, compactionsBefore), sous_agents: result.subAgents };
  event("session-terminee", { ticket: id, attempt, code: result.code, ...report });
  if (report.tours !== undefined) {
    say(`Session ${attempt} : ${report.tours} tours, ${report.duree_s} s, ${report.tokens_sortie} tokens produits, ${usd(report.cout_usd)}.`);
  }
  if (report.compactions) say(`La session s'est compactée ${report.compactions} fois : ce ticket est sans doute trop gros pour une session.`);
  return { code: result.code, report, startupError: result.startupError?.message };
}

async function runSession(ticket, attempt, dir, failureReport, step, resume) {
  const retry = failureReport
    ? ` C'est la tentative ${attempt} : une session précédente n'a pas abouti. Lis ${path.relative(root, failureReport)}` +
      " et le journal du ticket, regarde git status, puis reprends là où le travail s'est arrêté."
    : "";
  const handoff = resume
    ? ` Codex a été interrompu par son quota. Lis le journal du ticket, git status et git diff, puis ${resume.source.diff}` +
      ` et ${resume.source.manifest}. Reprends le travail présent, nouveaux fichiers compris, et fais relire l'état final.`
    : "";
  const prompt =
    `Traite le ticket ${ticket.id} (${ticket.file}) en suivant la skill « ticket » : lis d'abord` +
    ` .claude/skills/ticket/SKILL.md, puis le ticket en entier.${retry}${handoff}` +
    ` Avant de terminer, écris ton verdict dans .harness-state/tickets/${ticket.id}/verdict.json.`;
  const env = {
    HARNESS_TICKET_FILE: ticket.file,
    HARNESS_ALLOW_INSTALL: ticket.installe ? "1" : "0",
    HARNESS_EDIT: ticket.harnais ? "1" : "0",
  };
  say(`Tentative ${attempt} : ${step.modele || "modèle par défaut"}, effort ${step.effort || "par défaut"}, relecteur ${step.relecteur || "hérité"}.`);
  return launchSession({ id: ticket.id, attempt, dir, prompt, name: `${config.project} ${ticket.id} tentative ${attempt}`, step, env });
}

function readVerdict(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
  } catch (error) {
    // Pas de verdict lisible : la session s'est arrêtée sans conclure.
    return null;
  }
}

/** La référence en mémoire ne dépend pas d'un fichier que la session peut réécrire avant sa relecture. */
function untrackedListChange(ticket, expected) {
  const before = readUntrackedBefore(ticketDir(root, ticket.id));
  if (before.missing) return `${UNTRACKED_BEFORE} est absent : la session a retiré la liste écrite par la boucle.`;
  if (before.unreadable) return `${before.unreadable}.`;
  return JSON.stringify(before.paths) === JSON.stringify(expected) ? null : `${UNTRACKED_BEFORE} a été modifié depuis le démarrage de la boucle.`;
}

/** Contrôles de la boucle après une session qui se dit terminée. Renvoie la liste des refus. */
function gates(ticket, specBefore, { untracked, untrackedBefore, preexisting, reviewBefore }) {
  const problems = [];
  const listChange = untrackedListChange(ticket, untrackedBefore);
  if (listChange) problems.push(listChange);
  const changed = preexisting && preexistingChange(root, untrackedBefore, preexisting);
  if (changed) problems.push(changed);
  if (reviewBefore && reviewBefore === reviewFingerprint(root, ticket)) {
    problems.push("Une nouvelle relecture par Claude après quota est nécessaire.");
  }
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

const totalCost = (history) => {
  if (history.some((h) => h.report.cout_usd === null)) return null;
  return history.reduce((sum, h) => sum + (h.report.cout_usd || 0), 0);
};
const usefulAttempts = (history) => history.filter(entry => !entry.interrupted).length;

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

/** Indexe ces chemins et committe, un paragraphe par `-m`. Renvoie le commit court (`head`), ou `problem` avec la sortie de Git. */
function commitPaths(paths, paragraphs) {
  git("add", "-A", "--", ...paths);
  const commit = git("commit", ...paragraphs.flatMap((paragraph) => ["-m", paragraph]));
  if (commit.code !== 0) return { problem: commit.out || `git commit refusé (code ${commit.code}).` };
  return { head: git("rev-parse", "--short", "HEAD").stdout.trim() };
}

/** Pousse la branche, sauf avec `--no-push`. Renvoie le code de sortie de la boucle : 0, ou 3 si le push est refusé. */
function pushBranch(branch, id) {
  if (!options.push) return 0;
  const push = git("push", "-u", "origin", branch);
  if (push.code !== 0) {
    event("push-refuse", { ticket: id, sortie: push.out.slice(-2000) });
    say("Le commit est fait mais le push a échoué. Rien d'autre n'est lancé :\n" + push.out);
    return 3;
  }
  say(`Poussé sur origin/${branch}.`);
  return 0;
}

/** Commit (et push) du ticket. Renvoie le code de sortie de la boucle : 0, 2 si le commit échoue, 3 si le push est refusé. */
function integrate(ticket, branch, untracked, { step, verdict, history, reviewReserves = [] }) {
  const reserves = [verdict.reste, ...reviewReserves].flat().filter(Boolean);
  if (fs.existsSync(path.join(root, BASELINE))) {
    // Une session de harnais peut migrer les mesures : charger leurs définitions actuelles sur disque.
    const tightened = sh(process.execPath, ["scripts/quality/ratchet.mjs", "--tighten"]);
    if (tightened.code !== 0) return block(ticket, "Le resserrement du plancher a échoué :\n" + tightened.out, history);
  }
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, withReserves(setStatus(fs.readFileSync(file, "utf8"), "termine"), reserves));
  const paths = statusEntries().flatMap((e) => e.paths).filter((p) => !untracked.has(p));
  const email = COMMIT_EMAILS[options.engine];
  const trailer = `Co-Authored-By: ${displayName(step.modele, options.engine)} <${email}>`;
  const committed = commitPaths(paths, commitMessage(ticket, reserves, trailer));
  if (committed.problem) return block(ticket, "Le commit a échoué :\n" + committed.problem, history);
  const { head } = committed;
  const integrated = { ticket: ticket.id, commit: head, modele: step.modele, tentatives: usefulAttempts(history), cout_usd: totalCost(history) };
  event("integre", reserves.length ? { ...integrated, reserves } : integrated);
  say(`${ticket.id} intégré (${head}) en ${usefulAttempts(history)} tentative(s), ${usd(totalCost(history))}.`);
  if (reserves.length) say(`Réserves de la session : ${reserves.map(reserveText).join(" ; ")}`);
  return pushBranch(branch, ticket.id);
}

function block(ticket, why, history) {
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, "utf8"), "bloque"));
  event("bloque", { ticket: ticket.id, raison: why.slice(0, 2000), tentatives: usefulAttempts(history), cout_usd: totalCost(history) });
  say(`${ticket.id} est bloqué : ${why}\nLe travail en cours est laissé tel quel dans le dossier, pour examen.`);
  return 2;
}

function interruptForQuota(ticket, quota, { untracked }) {
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, "utf8"), "a-faire"));
  event("quota-epuise", { ticket: ticket.id, reprise: quota.reprise });
  const action = options.fallbackEngine ? "Une relève Claude est demandée ; le ticket est remis à faire." :
    "La boucle s'arrête ; le ticket est remis à faire.";
  say(`${ticket.id} : ${quotaDiagnostic(quota.reprise)} ${action}`);
  const entries = statusEntries().filter((e) => !e.paths.every((p) => untracked.has(p)));
  const tree = entries.length ? "L'arbre contient du travail modifié ou non suivi." : "L'arbre ne contient pas de travail modifié.";
  say(`${tree} Le travail et les traces sont conservés sur disque.`);
  return QUOTA_EXIT_CODE;
}

function quotaOutcome(ticket, context, { result, attempt, attempts, step, head, specification, history, failureReport }) {
  const code = interruptForQuota(ticket, result.quota, context);
  const stopped = { code, outcome: "quota-épuisé", reason: null, history };
  if (!options.fallbackEngine) return stopped;
  history.push({ attempt, plan: step, report: result.report, failure: "Quota Codex épuisé ; relève Claude demandée.", interrupted: true });
  const expected = {
    ticket, head, branch: context.branch, specification,
    untrackedBefore: context.untrackedBefore, preexisting: context.preexisting,
  };
  try {
    const handoff = captureQuotaHandoff(root, expected);
    const quotaResume = { ticket, head, branch: context.branch, specification, attempt, attempts, history, failureReport, handoff };
    return { ...stopped, quotaResume };
  } catch (error) {
    event("relance-echouee", { ticket: ticket.id, raison: error.message, cause: error.code ?? "QUOTA_HANDOFF_FAILED" });
    say(error.message);
    return { code: 1, outcome: "relève-refusée", reason: error.message, history };
  }
}

function initialTicketState(ticket, context, resume) {
  const dir = ticketDir(root, ticket.id);
  // La session ne connaît pas les fichiers non suivis d'avant elle : sans cette liste, ils entreraient dans l'état relu.
  if (!resume) writeUntrackedBefore(dir, context.untrackedBefore);
  const file = path.join(root, ticket.file);
  const text = fs.readFileSync(file, "utf8");
  const state = resume ? {
    specBefore: resume.specification, history: resume.history, attempts: resume.attempts,
    firstAttempt: resume.attempt, failureReport: resume.failureReport ?? null, reviewBefore: resume.source.review,
  } : {
    specBefore: spec(text), history: [], attempts: attemptsFor(ticket),
    firstAttempt: 1, failureReport: null, reviewBefore: null,
  };
  fs.writeFileSync(file, setStatus(text, "en-cours"));
  say(`${ticket.id} — ${ticket.titre} (niveau ${levelOf(ticket)})`);
  return { ...state, dir };
}

function quotaLaunchFailure(ticket, handoff, result) {
  if (!handoff || result.code === 0) return null;
  const file = path.join(root, ticket.file);
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, "utf8"), "a-faire"));
  const reason = result.startupError || `session Claude en échec (code ${result.code})`;
  event("relance-echouee", { ticket: ticket.id, raison: reason, cause: "CLAUDE_LAUNCH_FAILED" });
  say(`La relève Claude a échoué : ${reason}. Le ticket et le travail sont conservés.`);
  return { code: 1, outcome: "relève-refusée", reason };
}

function assessAttempt(ticket, context, state, step, result) {
  const { dir, specBefore, history, reviewBefore } = state;
  const { code, problem } = result;
  const verdict = readVerdict(dir);
  if (problem) return { failure: problem };
  if (!verdict) return { failure: `La session s'est terminée sans verdict (code de sortie ${code}).` };
  if (verdict.statut === "BLOQUÉ") {
    const why = verdict.resume || "la session s'est déclarée bloquée sans dire pourquoi";
    return { code: block(ticket, why, history), outcome: "bloqué", reason: why };
  }
  if (verdict.statut === "PARTIEL") {
    return { failure: "La session s'est déclarée PARTIELLE. Reste à faire : " + JSON.stringify(verdict.reste || verdict.resume || "") };
  }
  if (verdict.statut !== "TERMINÉ") return { failure: `Verdict illisible : statut « ${verdict.statut} ».` };
  const problems = gates(ticket, specBefore, { ...context, reviewBefore });
  if (problems.length) {
    return { failure: "La session s'est déclarée TERMINÉE mais la boucle refuse l'intégration :\n\n" + problems.join("\n\n") };
  }
  const integrated = integrate(ticket, context.branch, context.untracked, { step, verdict, history, reviewReserves: result.reserves });
  return { code: integrated, outcome: integrated === 2 ? "bloqué" : "intégré", reason: integrated === 3 ? "push refusé" : null };
}

/** Traite un ticket jusqu'à l'intégration ou au blocage. Renvoie le code de sortie et ce qui s'est passé, pour la rétrospective. */
async function processTicket(ticket, context, resume, head) {
  const state = initialTicketState(ticket, context, resume);
  const { dir, specBefore, history, attempts, firstAttempt } = state;
  let { failureReport } = state;
  for (let attempt = firstAttempt; attempt <= attempts; attempt++) {
    // Un verdict d'une tentative précédente ne vaut pas pour celle-ci.
    fs.rmSync(path.join(dir, "verdict.json"), { force: true });
    const step = sessionPlan(ticket, attempt);
    const external = EXTERNAL_ENGINES[options.engine];
    const args = [ticket, attempt, dir, failureReport, step];
    const handoff = resume && attempt === resume.attempt ? resume : null;
    const result = external
      ? await external(root, ...args, { event, timeoutMin: options.timeoutMin, project: config.project })
      : await runSession(...args, handoff);
    if (result.quota?.code === "CODEX_QUOTA_EXHAUSTED") {
      return quotaOutcome(ticket, context, { result, attempt, attempts, step, head, specification: specBefore, history, failureReport });
    }
    const failedLaunch = quotaLaunchFailure(ticket, handoff, result);
    if (failedLaunch) return { ...failedLaunch, history };
    const entry = { attempt, plan: step, report: result.report, failure: null };
    history.push(entry);
    const assessed = assessAttempt(ticket, context, state, step, result);
    if (assessed.code !== undefined) return { ...assessed, history };
    const { failure } = assessed;
    entry.failure = failure;
    failureReport = path.join(dir, `echec-${attempt}.txt`);
    fs.writeFileSync(failureReport, failure + "\n");
    event("tentative-refusee", { ticket: ticket.id, attempt, raison: failure.slice(0, 2000) });
    say(`Tentative ${attempt} refusée : ${failure.split("\n")[0]}`);
  }
  const why = `${attempts} tentative(s) sans aboutir. Dernier refus : ${path.relative(root, failureReport)}`;
  return { code: block(ticket, why, history), outcome: "bloqué", reason: why, history };
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

/** Fréquence de l'harmonisation des consignes, telle que l'affiche `--dry-run`. */
function tuneCadence(every) {
  if (!every) return "désactivée (--tune-every 0)";
  return every === 1 ? "active, après chaque ticket intégré" : `active, tous les ${every} tickets intégrés`;
}

const context = preflight();
if (!launch && !options.dryRun) {
  const state = {
    options, done: 0, integrated: 0, untracked: [...context.untracked],
    untrackedBefore: context.untrackedBefore, preexisting: context.preexisting,
  };
  stop(await supervise(root, state, { event, say }));
}
if (launch) await admitWorker();
// Tickets intégrés depuis le lancement : l'harmonisation des consignes part tous les `--tune-every` d'entre eux.
let integrated = launch?.integrated ?? 0;
for (let done = launch?.done ?? 0; done < options.max; done++) {
  const wanted = done === 0 ? options.ticket : null;
  const queue = list(root);
  const resume = done === launch?.done ? launch.quotaResume : null;
  const { ticket, reason } = next(queue, resume?.ticket.id ?? wanted);
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
    say(`Moteur : ${options.engine}.`);
    if (options.fallbackEngine) say("Secours après quota : Claude, au palier de la tentative utile ; --model et --effort Codex sont remplacés.");
    const command = SESSION_COMMANDS[options.engine] ?? `claude -p … --permission-mode ${options.permissionMode}`;
    say(`Session : ${command}, ${attemptsFor(ticket)} tentative(s) au plus.`);
    for (let attempt = 1; attempt <= attemptsFor(ticket); attempt++) {
      const step = sessionPlan(ticket, attempt);
      const model = step.modele || "modèle par défaut";
      const effort = step.effort || "par défaut";
      const reviewer = step.relecteur || "hérité";
      say(`Palier ${step.palier ?? "fixe"} : ${model}, effort ${effort}, relecteur ${reviewer}.`);
    }
    say(`Première tentative : ${first.modele || "modèle par défaut"}, effort ${first.effort || "par défaut"}, relecteur ${first.relecteur || "hérité"}.`);
    say(options.push ? `Après contrôle : commit puis push sur origin/${context.branch}.` : "Après contrôle : commit local, sans push.");
    say(`Harmonisation des consignes : ${tuneCadence(options.tuneEvery)}.`);
    stop(0);
  }
  const before = git("rev-parse", "HEAD").stdout.trim();
  const run = await processTicket(ticket, context, resume, before);
  if (run.quotaResume) {
    await retireWorker({
      options: { ...options, engine: "claude", fallbackEngine: null, model: null, effort: null },
      done, integrated, quotaResume: run.quotaResume,
    });
    stop(0);
  }
  if (run.outcome === "relève-refusée") stop(run.code);
  if (run.code === QUOTA_EXIT_CODE) stop(run.code);
  if (options.retro) retrospective(ticket, run);
  if (run.code !== 0) stop(run.code);
  integrated++;
  if (options.tuneEvery > 0 && integrated % options.tuneEvery === 0) {
    const io = { say, event, launch: launchSession, commit: commitPaths, push: (id) => pushBranch(context.branch, id), project: config.project, models };
    const tuned = await tuneInstructions(root, io);
    if (tuned !== 0) stop(tuned);
  }
  if (done + 1 < options.max) {
    try {
      const modules = integratedModules(git, before);
      if (modules.length) {
        event("relance-demandee", { ticket: ticket.id, modules });
        await retireWorker({ done: done + 1, integrated, quotaResume: null });
        stop(0);
      }
    } catch (error) {
      event("relance-echouee", { raison: error.message, cause: error.code ?? "LOOP_PATHS_FAILED" });
      stop(1, `La relève de la boucle a échoué : ${error.message}`);
    }
  }
}
stop(0, "Nombre de tickets demandé atteint.");
