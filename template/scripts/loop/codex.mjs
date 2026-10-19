// Codex écrit ; un processus Claude séparé juge l'état enregistré avant les contrôles de la boucle.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { retryCapacity } from "./codex-capacity.mjs";
import { MAX_DIAGNOSTIC_LENGTH, sessionState, streamSession } from "./codex-stream.mjs";
import { lastReviewReport, record, recordReview, reviewVerdict, uncorrectedFindings } from "./reviewed-state.mjs";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MAX_REVIEW_OUTPUT = 64 * 1024 * 1024;
const MAX_CORRECTIONS = 2;
const DISABLED_FEATURES = ["plugins", "apps", "memories", "image_generation"];
const DEFAULT_DISCOVERY_TIMEOUT_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

function sessionEnv(ticket) {
  return {
    ...process.env,
    HARNESS_LOOP: "1",
    HARNESS_ENGINE: "codex",
    HARNESS_TICKET: ticket.id,
    HARNESS_TICKET_FILE: ticket.file,
    HARNESS_EDIT: ticket.harnais ? "1" : "0",
    HARNESS_ALLOW_INSTALL: ticket.installe ? "1" : "0",
  };
}

function checkResumeOptions(root, disabled, directories, env, timeoutMs) {
  const result = spawnSync(env.HARNESS_CODEX_BIN || "codex", ["exec", "resume", ...disabled, ...directories, "--help"], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs,
  });
  if (result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") throw timeoutError();
    const reason = result.error?.message || result.stderr || `code ${result.status}`;
    throw Object.assign(new Error(`Codex : options requises de reprise indisponibles : ${reason}`), { code: "CODEX_RESUME_UNAVAILABLE" });
  }
}

function timeoutError() {
  return Object.assign(new Error("Codex : délai maximal dépassé."), { code: "CODEX_TIMEOUT" });
}

function remainingTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  return remaining;
}

export function codexArgs(root, step, prompt, {
  env = process.env, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, session = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const disabled = DISABLED_FEATURES.flatMap((name) => ["--disable", name]);
  const directories = env.HARNESS_EDIT === "1" ? [".codex", ".agents"].flatMap((dir) => ["--add-dir", path.join(root, dir)]) : [];
  if (session) checkResumeOptions(root, disabled, directories, env, remainingTime(deadline));
  let servers;
  try {
    const listed = spawnSync(env.HARNESS_CODEX_BIN || "codex", ["mcp", "list", "--json", ...disabled], {
      cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: remainingTime(deadline),
    });
    if (listed.error?.code === "ETIMEDOUT") throw timeoutError();
    if (listed.status !== 0) throw new Error(listed.error?.message || `processus en échec (code ${listed.status})`);
    servers = JSON.parse(listed.stdout);
    const valid = (server) => server && typeof server.name === "string" && server.name.trim() && typeof server.enabled === "boolean";
    if (!Array.isArray(servers) || !servers.every(valid)) throw new Error("format inattendu");
  } catch (error) {
    if (error.code === "CODEX_TIMEOUT") throw error;
    throw Object.assign(new Error(`Codex : liste des serveurs MCP en échec ou illisible : ${error.message}`), { code: "CODEX_MCP_LIST" });
  }
  const mcp = servers.filter((server) => server.enabled).flatMap(({ name }) => {
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
    return ["-c", `mcp_servers.${key}.enabled=false`];
  });
  const args = [
    ...(session ? ["exec", "resume", session] : ["exec"]), "--json", "-m", step.modele,
    "-c", `model_reasoning_effort="${step.effort}"`,
    "-c", 'approval_policy="never"',
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", `projects.${JSON.stringify(root)}.trust_level="trusted"`,
    ...disabled, "-c", "notify=[]", ...mcp, "--dangerously-bypass-hook-trust",
  ];
  args.push(...directories);
  if (session) args.push("-c", 'sandbox_mode="workspace-write"');
  else args.push("-s", "workspace-write", "-C", root);
  return [...args, prompt];
}

function sessionProblem(request, state, marker, run) {
  if (!state.session && state.turnStarted) {
    return { reason: "Codex : identité de session absente après le début du travail ; reprise refusée.", resumeImpossible: false };
  }
  if (request.session && state.session && state.session !== request.session) {
    const reason = `Codex : session changée lors de la reprise : ${request.session} attendue, ${state.session} reçue.`;
    return { reason, resumeImpossible: true };
  }
  if (!state.session || marker?.session !== state.session || marker?.run !== run) {
    const reason = "hooks Codex non chargés : aucun témoin de démarrage valide pour cette session et ce lancement." +
      " Cause probable : hooks de .codex/hooks.json non approuvés pour ce dépôt, ou session hors du dépôt approuvé." +
      " Le propriétaire les approuve avec codex, puis /hooks.";
    return { reason, resumeImpossible: Boolean(request.session) };
  }
  return null;
}

async function hookedSession(root, request, env, file, state, timeoutMs, started, dir) {
  const deadline = Date.now() + timeoutMs;
  const markerFile = path.join(dir, "hooks-started.json");
  const run = request.invocation;
  fs.rmSync(markerFile, { force: true });
  state.session = null;
  state.turnStarted = false;
  let args;
  let remaining;
  try {
    args = codexArgs(root, request.step, request.prompt, { env, timeoutMs, session: request.session });
    remaining = remainingTime(deadline);
  } catch (error) {
    if (!["CODEX_MCP_LIST", "CODEX_RESUME_UNAVAILABLE", "CODEX_TIMEOUT"].includes(error.code)) throw error;
    state.problem = error.message;
    state.terminal = error.code === "CODEX_TIMEOUT";
    return { code: 1, resumeImpossible: Boolean(request.session && !state.terminal) };
  }
  const reportRecovery = (reason) => request.reportRecovery(run, reason);
  const files = [file, request.trace];
  const code = await streamSession(root, args, { ...env, HARNESS_HOOK_RUN: run }, files, state, remaining, started, reportRecovery);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  } catch (error) {
    // Un témoin absent ou illisible ne prouve pas le chargement des hooks.
    marker = null;
  }
  return sessionOutcome(request, state, marker, run, code);
}

function sessionOutcome(request, state, marker, run, code) {
  if (state.quota) return { code: 1, resumeImpossible: false };
  // Sans fil ni début de travail, le fournisseur a refusé avant qu'une session puisse être reprise.
  const beforeSession = !request.session && !state.session && !state.turnStarted && state.capacity && !state.terminal;
  if (beforeSession) return { code, resumeImpossible: false };
  const problem = sessionProblem(request, state, marker, run);
  if (problem) {
    // Le motif de confinement et son remède doivent survivre à la coupe d'un long diagnostic fournisseur.
    state.problem = [problem.reason, state.problem].filter(Boolean).join(" ");
    const resumeImpossible = !state.capacity && !state.terminal && problem.resumeImpossible;
    state.capacity = null;
    return { code: 1, resumeImpossible };
  }
  const resumeImpossible = request.session && code !== 0 && !state.turnStarted;
  return { code, resumeImpossible: Boolean(resumeImpossible && !state.capacity && !state.terminal) };
}

async function capacitySession(root, request, env, file, state, timeoutMs, started, dir, event) {
  const skipWait = env.HARNESS_CODEX_SKIP_CAPACITY_WAIT === "1";
  const result = await retryCapacity(async ({ session, timeoutMs: remaining, retry }) => {
    fs.rmSync(path.join(dir, "verdict.json"), { force: true });
    const invocation = randomUUID();
    const trace = path.join(dir, `${path.basename(file, ".jsonl")}-${invocation}.jsonl`);
    fs.writeFileSync(trace, "");
    const current = sessionState();
    const next = { ...request, session, invocation, trace };
    const launched = Date.now();
    const outcome = await hookedSession(root, next, env, file, current, remaining, started, dir);
    current.problem = current.problem?.slice(0, MAX_DIAGNOSTIC_LENGTH) ?? null;
    const report = {
      invocation, session: current.session, reprise: retry, code: outcome.code, trace: path.relative(root, trace),
      tours: current.tours, jetons: current.jetons, duree_ms: Date.now() - launched, delai_ms: remaining,
      capacity: current.capacity, quota: current.quota, problem: current.problem,
    };
    state.invocations.push(report);
    state.session = current.session;
    state.tours += current.tours;
    for (const field of Object.keys(state.jetons)) state.jetons[field] += current.jetons[field];
    event("invocation-terminee", { ticket: env.HARNESS_TICKET, ...report });
    return { ...outcome, session: current.session, capacity: current.capacity, quota: current.quota, problem: current.problem,
      resumeImpossible: retry === 0 && outcome.resumeImpossible };
  }, {
    timeoutMs, session: request.session, wait: delay => skipWait ? Promise.resolve() : sleep(delay),
    onRetry: ({ result: previous, retry, delay }) => {
      const invocation = state.invocations.at(-1).invocation;
      event("capacite-reprise", {
        ticket: env.HARNESS_TICKET, invocation, reprise: retry, attente_ms: delay, session: previous.session, raison: previous.capacity.diagnostic,
      });
      const label = `${env.HARNESS_TICKET} tentative ${request.attempt} invocation ${invocation}`;
      console.log(`[boucle] ${label} : capacité indisponible, reprise ${retry} après ${delay} ms.`);
    },
  });
  state.problem = result.problem;
  state.capacity = result.capacity || null;
  state.quota = result.quota || null;
  if (result.exhausted) {
    event("capacite-epuisee", { ticket: env.HARNESS_TICKET, invocation: state.invocations.at(-1)?.invocation, cause: result.exhausted });
  }
  return result;
}

async function correctionSession(root, request, env, file, state, timeoutMs, started, dir, event) {
  fs.rmSync(path.join(dir, "verdict.json"), { force: true });
  const result = await capacitySession(root, request, env, file, state, timeoutMs, started, dir, event);
  if (!result.resumeImpossible) return result.code;
  event("reprise-impossible", { ticket: env.HARNESS_TICKET, session: request.session, raison: state.problem });
  state.problem = null;
  fs.rmSync(path.join(dir, "verdict.json"), { force: true });
  const fresh = await capacitySession(root, { ...request, session: null }, env, file, state, timeoutMs, started, dir, event);
  return fresh.code;
}

function reviewRequest(root, ticket, dir, correction) {
  const previousReport = correction ? lastReviewReport(dir) : null;
  const snapshot = record(root, ticket);
  if (snapshot.problem) return { problem: snapshot.problem };
  const files = snapshot.written.slice(0, 2).map((file) => path.relative(root, file));
  let prompt = `Relis le ticket ${ticket.id} (${ticket.file}), ${files.join(" et ")}` +
    ` et, s'il existe, ${path.relative(root, path.join(dir, "ecarts.md"))}.`;
  if (correction) {
    const previous = path.relative(root, path.join(dir, previousReport));
    const interdiffFile = snapshot.written.find((file) => file.endsWith(".interdiff"));
    if (!interdiffFile) {
      const state = path.relative(root, path.join(dir, "reviewed-state.json"));
      return { problem: `Relecture de correction impossible : interdiff absent après reconstruction de ${state}. La tentative est refusée.` };
    }
    const interdiff = path.relative(root, interdiffFile);
    prompt += ` Fais une relecture de correction contre ${previous} et ${interdiff}, selon la section correspondante de tes consignes.`;
  }
  return { prompt };
}

function review(root, ticket, dir, env, step, timeoutMs, correction) {
  const request = reviewRequest(root, ticket, dir, correction);
  if (request.problem) return request;
  const { prompt } = request;
  const args = ["-p", prompt, "--agent", "relecteur", "--model", step.relecteur, "--output-format", "json", "--strict-mcp-config"];
  const reviewEnv = { ...env };
  // Les hooks de ticket exigeraient du relecteur un verdict d'implémentation et remplaceraient son rapport.
  delete reviewEnv.HARNESS_LOOP;
  delete reviewEnv.HARNESS_ENGINE;
  const result = spawnSync(process.env.HARNESS_CLAUDE_BIN || "claude", args, {
    cwd: root, env: reviewEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: MAX_REVIEW_OUTPUT,
  });
  let report;
  let failed = result.status !== 0;
  try {
    const output = JSON.parse(result.stdout);
    report = typeof output.result === "string" ? output.result : "";
    failed ||= Boolean(output.is_error);
    if (failed) report = `Relecteur en échec : ${result.stderr || ""}\n${report}`;
  } catch (error) {
    // Un processus interrompu ou une sortie non JSON ne peut jamais accepter une revue.
    report = `Relecteur illisible : ${result.error?.message || result.stderr || result.stdout || error.message}`;
    failed = true;
  }
  const uncorrected = correction ? uncorrectedFindings(report) : 0;
  let verdict = failed ? "illisible" : reviewVerdict(report);
  if (!failed && uncorrected > 0) verdict = "à corriger";
  recordReview(root, ticket.id, { verdict, modele: step.relecteur, report });
  return { verdict, report, uncorrected };
}

function sessionVerdict(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
  } catch (error) {
    // Un arrêt sans verdict lisible ne peut pas déclencher une relecture du changement.
    return null;
  }
}

function locations(text) {
  return text.match(/[^\s`]+:\d+/gu) || [];
}

function findingForm(line, section, current) {
  if (/^#{1,2}\s+/u.test(line)) return (/^#{1,2}\s+\d+[.)]\s+/u.test(line) || locations(line).length > 0) && "title";
  if (/^(?:#{3,6}\s+|\*\*(?:\d+[.)]\s+|constat\s+\d+\b))/iu.test(line)) return "title";
  if (/^\d+[.)]\s+/u.test(line)) return (!current || current.form === "numbered") && "numbered";
  const bullet = /^[-*+]\s+(.+)$/u.exec(line)?.[1];
  if (!bullet || (current && current.form !== "bullet")) return false;
  const located = locations(bullet).some(ref => bullet.replace(/^`/u, "").startsWith(ref));
  if (located || /^(?:\(\d+\)\s+|hors\s+périmètre\b)/iu.test(bullet)) return "bullet";
  if (!current && /^\*\*[^*:]+\*\*(?:\s|$)/u.test(bullet)) return "title";
  return section === "reserves" && !current && "bullet";
}

function reviewSection(title) {
  if (/^(?:\d+[.)]\s+|constat\s+\d+\b)/iu.test(title)) return null;
  if (/(?:^|\s)[ée]carts\b/iu.test(title)) return "deviations";
  if (/^réserves(?:\s+hors\s+périmètre|$)/iu.test(title)) return "reserves";
  if (/^(?:suivi|synthèse|critères|régressions|code\s+changé)\b/iu.test(title)) return "other";
  if (/^constats?\s+du\s+rapport\s+précédent\b/iu.test(title)) return "tracking";
  if (/constats?\b/iu.test(title) && !/de\s+la\s+relecture/iu.test(title)) return "findings";
  return null;
}

/** Les champs et paragraphes restent attachés au titre, même si le repère est dans le corps. */
function reviewBlocks(report) {
  const blocks = [];
  let section = "findings";
  let current = null;
  for (const line of report.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(?:VERDICT|CONSTATS|NON CORRIGÉS)\s*:/iu.test(line)) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    const nextSection = heading && reviewSection(heading[1]);
    const title = line.replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/u, "");
    const deviation = section !== "other" && /^(?:\*\*)?[ée]carts?\s+acceptés?(?!\p{L})/iu.test(title);
    const form = !nextSection && ["findings", "tracking", "reserves"].includes(section) && findingForm(line, section, current);
    if (deviation || form) {
      current = {
        kind: deviation ? "deviation" : "finding", form, tracking: section === "tracking", listed: /^[-*+]\s/u.test(line), lines: [title],
      };
      blocks.push(current);
    } else if (heading) {
      current = null;
      section = nextSection || "other";
    } else if (current?.kind === "deviation" && current.listed && /^(?:[-*+]|\d+[.)])\s/u.test(line)) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map(({ kind, tracking, lines }) => ({ kind, tracking, text: lines.join("\n").trim() }));
}

function outOfScopeFindings(blocks) {
  const findings = blocks.filter(block => block.kind === "finding" && /hors\s+périmètre/iu.test(block.text));
  const references = findings.filter(block => !block.tracking).flatMap(block => locations(block.text));
  // Un suivi peut rappeler un constat développé plus loin ; seule sa version complète est transmise.
  return findings.filter(block => !block.tracking || !locations(block.text).some(ref => references.includes(ref)));
}

/** Les réserves du rapport accepté restent référencées sans réécrire le verdict ni l'état relu. */
function reviewReserves(report, reference) {
  const blocks = reviewBlocks(report);
  const findings = outOfScopeFindings(blocks);
  const deviations = blocks.filter((block) => block.kind === "deviation").map((block) => block.text);
  const expected = Number(/^\s*CONSTATS\s*:.*?(\d+)\s+hors\s+périmètre/imu.exec(report)?.[1]);
  // Un compte discordant rend l'extraction incertaine : le rapport entier reste la référence des constats.
  const kept = findings.length === expected ? findings.map((block) => block.text) : [
    `Nombre de constats discordant : CONSTATS annonce ${expected} hors périmètre ; ${findings.length} constat(s) extrait(s).` +
    " Consulter le rapport pour l'ensemble des constats hors périmètre.",
  ];
  return [...kept, ...deviations].map((text) => `${reference} : ${text}`);
}

export async function runCodex(root, ticket, attempt, dir, failureReport, step, { event, timeoutMin }) {
  const started = Date.now();
  const timeoutMs = timeoutMin * SECONDS_PER_MINUTE * MS_PER_SECOND;
  const state = { ...sessionState(), invocations: [] };
  const env = sessionEnv(ticket);
  const retry = failureReport ? ` Lis ${path.relative(root, failureReport)} et le journal, puis reprends le travail.` : "";
  const prompt = `Traite le ticket ${ticket.id} (${ticket.file}) en suivant .agents/skills/ticket-codex/SKILL.md.${retry}`;
  event("session", { ticket: ticket.id, attempt, moteur: "codex", ...step });
  const file = path.join(dir, `codex-${attempt}.jsonl`);
  fs.writeFileSync(file, "");
  const reportRecovery = (invocation, raison) => {
    event("reconnexion", { ticket: ticket.id, attempt, invocation, raison });
    console.log(`[boucle] ${ticket.id} tentative ${attempt} invocation ${invocation} : reconnexion récupérée (${raison}).`);
  };
  const invocationEvent = (phase, data) => event(phase, { ...data, attempt });
  const initial = { step, prompt, reportRecovery, attempt };
  let { code } = await capacitySession(root, initial, env, file, state, timeoutMs, started, dir, invocationEvent);
  let relectures = 0;
  let reserves = [];
  for (let correction = 0; code === 0; correction++) {
    if (sessionVerdict(dir)?.statut !== "TERMINÉ") break;
    const reviewed = review(root, ticket, dir, env, step, timeoutMs, correction > 0);
    relectures++;
    if (reviewed.uncorrected > 0) {
      const reference = path.relative(root, path.join(dir, lastReviewReport(dir)));
      state.problem = `Un constat non corrigé (ou une ligne NON CORRIGÉS absente ou illisible) dans ${reference}` +
        ` refuse la tentative : la boucle passe au palier suivant.\n\n${reviewed.report}`;
      code = 1;
      break;
    }
    if (reviewed.verdict === "accepté") {
      const reference = path.relative(root, path.join(dir, lastReviewReport(dir)));
      reserves = reviewReserves(reviewed.report, reference);
      break;
    }
    if (reviewed.problem || correction >= MAX_CORRECTIONS) {
      state.problem = reviewed.problem || reviewed.report;
      code = 1;
      break;
    }
    const reportFile = path.relative(root, path.join(dir, lastReviewReport(dir)));
    const fix = `Reprends le ticket ${ticket.id} (${ticket.file}) en suivant .agents/skills/ticket-codex/SKILL.md.` +
      ` Lis ${reportFile}, le ticket et son journal, les écarts, git status et git diff, puis reprends le travail présent dans l'arbre.` +
      ` Corrige chaque constat bloquant et mineur de cette relecture, tests d'abord, puis rends un nouveau verdict.\n\n${reviewed.report}`;
    const fallbackEvent = (phase, data) => event(phase, { ...data, attempt });
    const request = { step, prompt: fix, session: state.session, reportRecovery, attempt };
    code = await correctionSession(root, request, env, file, state, timeoutMs, started, dir, fallbackEvent);
  }
  const { problem, turnStarted, terminal, ...usage } = state;
  const report = { ...usage, moteur: "codex", duree_s: Math.round((Date.now() - started) / MS_PER_SECOND), relectures, cout_usd: null };
  event("session-terminee", { ticket: ticket.id, attempt, code, ...report });
  return { code, report, problem, reserves, quota: state.quota };
}
