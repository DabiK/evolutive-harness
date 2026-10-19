// Codex écrit ; un processus Claude séparé juge l'état enregistré avant les contrôles de la boucle.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { retryCapacity } from "./codex-capacity.mjs";
import { MAX_DIAGNOSTIC_LENGTH, sessionState, streamSession } from "./codex-stream.mjs";
import { reviewAndCorrect } from "./claude-review.mjs";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const CODEX_SKILL = ".agents/skills/ticket-codex/SKILL.md";
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

export async function runCodex(root, ticket, attempt, dir, failureReport, step, { event, timeoutMin }) {
  const started = Date.now();
  const timeoutMs = timeoutMin * SECONDS_PER_MINUTE * MS_PER_SECOND;
  const state = { ...sessionState(), invocations: [] };
  const env = sessionEnv(ticket);
  const retry = failureReport ? ` Lis ${path.relative(root, failureReport)} et le journal, puis reprends le travail.` : "";
  const prompt = `Traite le ticket ${ticket.id} (${ticket.file}) en suivant ${CODEX_SKILL}.${retry}`;
  event("session", { ticket: ticket.id, attempt, moteur: "codex", ...step });
  const file = path.join(dir, `codex-${attempt}.jsonl`);
  fs.writeFileSync(file, "");
  const reportRecovery = (invocation, raison) => {
    event("reconnexion", { ticket: ticket.id, attempt, invocation, raison });
    console.log(`[boucle] ${ticket.id} tentative ${attempt} invocation ${invocation} : reconnexion récupérée (${raison}).`);
  };
  const invocationEvent = (phase, data) => event(phase, { ...data, attempt });
  const initial = { step, prompt, reportRecovery, attempt };
  const first = await capacitySession(root, initial, env, file, state, timeoutMs, started, dir, invocationEvent);
  const correct = (prompt) => {
    const fallbackEvent = (phase, data) => event(phase, { ...data, attempt });
    const request = { step, prompt, session: state.session, reportRecovery, attempt };
    return correctionSession(root, request, env, file, state, timeoutMs, started, dir, fallbackEvent);
  };
  const reviewed = await reviewAndCorrect({ root, ticket, dir, env, step, timeoutMs, skill: CODEX_SKILL, code: first.code, correct });
  const { code, relectures, reserves } = reviewed;
  if (reviewed.problem) state.problem = reviewed.problem;
  const { problem, turnStarted, terminal, ...usage } = state;
  const report = { ...usage, moteur: "codex", duree_s: Math.round((Date.now() - started) / MS_PER_SECOND), relectures, cout_usd: null };
  event("session-terminee", { ticket: ticket.id, attempt, code, ...report });
  return { code, report, problem, reserves, quota: state.quota };
}
