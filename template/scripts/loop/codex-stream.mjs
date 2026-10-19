import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { capacityFailure } from "./codex-capacity.mjs";
import { quotaDiagnostic, quotaFailure } from "./codex-quota.mjs";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MAX_ACTION_LENGTH = 160;
export const MAX_DIAGNOSTIC_LENGTH = 2000;
const MAX_SESSION_ID_LENGTH = 160;
const TERMINATION_GRACE_MS = 1000;
const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

export function sessionState() {
  return {
    session: null, turnStarted: false, tours: 0, jetons: Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0])),
    problem: null, capacity: null, quota: null, terminal: false,
  };
}

function showAction(root, item, started) {
  const actions = [];
  if (item?.type === "command_execution") actions.push(`Bash ${item.command}`);
  if (item?.type === "file_change") {
    const files = (item.changes || []).map((change) => path.isAbsolute(change.path) ? path.relative(root, change.path) : change.path);
    actions.push(`Write ${files.join(", ")}`);
  }
  const seconds = Math.round((Date.now() - started) / MS_PER_SECOND);
  const minutes = String(Math.floor(seconds / SECONDS_PER_MINUTE)).padStart(2, "0");
  const remainder = String(seconds % SECONDS_PER_MINUTE).padStart(2, "0");
  for (const action of actions) console.log(`[boucle] ${minutes}:${remainder}  ${action.replace(/\s+/g, " ").slice(0, MAX_ACTION_LENGTH)}`);
}

function readIdentity(message, state) {
  const session = message.thread_id;
  const valid = typeof session === "string" && session.length <= MAX_SESSION_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(session);
  if (!valid || (state.session && state.session !== session)) {
    state.problem = "Codex : identité du fil invalide ou contradictoire.";
    state.terminal = true;
    return;
  }
  state.session = session;
}

function retainQuota(state, errors) {
  const pending = errors.find(error => error.quota?.reprise)?.quota || errors.find(error => error.quota)?.quota || null;
  if (!state.quota || state.quota.reprise === null) state.quota = pending || state.quota;
}

function consumeTurn(message, state, stream) {
  if (message.type === "turn.started") stream.openTurn = true;
  const workItem = ["item.started", "item.completed"].includes(message.type) && message.item?.type !== "error";
  if (["turn.started", "turn.completed"].includes(message.type) || workItem) state.turnStarted = true;
  if (message.type === "turn.completed") {
    stream.openTurn = false;
    if (state.quota) retainQuota(state, stream.errors);
    for (const error of stream.errors) stream.reportRecovery(error.reason);
    stream.errors = [];
    state.tours++;
  }
  if (["turn.completed", "turn.failed"].includes(message.type)) {
    for (const field of TOKEN_FIELDS) state.jetons[field] += message.usage?.[field] || 0;
  }
}

function consumeFailure(message, state, stream) {
  if (["error", "turn.failed"].includes(message.type)) {
    const quota = quotaFailure(message);
    const reason = quota ? quotaDiagnostic(quota.reprise) :
      `Codex : ${message.error?.message || message.message || "erreur du flux"}`.slice(0, MAX_DIAGNOSTIC_LENGTH);
    const capacity = capacityFailure(message);
    if (message.type === "error") stream.errors.push({ reason, capacity, quota });
    else {
      state.problem ||= reason;
      state.quota ||= quota;
      state.capacity = capacity;
      stream.nonCapacityFailure ||= !capacity;
    }
  }
}

function consumeLine(root, line, state, started, stream) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    // Le flux brut reste archivé même si une ligne de diagnostic ne suit pas le protocole JSONL.
    return;
  }
  if (!message || typeof message !== "object") return;
  if (message.type === "thread.started") readIdentity(message, state);
  consumeTurn(message, state, stream);
  consumeFailure(message, state, stream);
  if (message.type === "item.completed") showAction(root, message.item, started);
}

export function streamSession(root, args, env, files, state, timeoutMs, started, reportRecovery) {
  const append = (suffix, chunk) => {
    for (const file of files) fs.appendFileSync(file + suffix, chunk);
  };
  return new Promise((resolve) => {
    const child = spawn(env.HARNESS_CODEX_BIN || "codex", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let killTimer;
    const timer = setTimeout(() => {
      state.problem = "Codex : délai maximal dépassé.";
      state.terminal = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    }, timeoutMs);
    const stream = { errors: [], reportRecovery, nonCapacityFailure: false, openTurn: false };
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => consumeLine(root, line, state, started, stream));
    child.stdout.on("data", chunk => append("", chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      append(".stderr", chunk);
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
    });
    child.on("error", (error) => {
      state.problem = `Codex : ${error.code} (${error.message})`;
      state.terminal = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      state.problem ||= stream.errors.at(-1)?.reason;
      if (stream.errors.length) {
        retainQuota(state, stream.errors);
        state.capacity ||= stream.errors.at(-1).capacity;
        stream.nonCapacityFailure ||= stream.errors.some(error => !error.capacity);
      }
      if (signal) state.terminal = true;
      if (code !== 0) state.problem ||= `Codex : processus en échec (code ${code}). ${stderr}`;
      if (!state.problem && (state.tours === 0 || stream.openTurn)) {
        state.problem = "Codex : tour inachevé, aucune fin de tour valide.";
        state.terminal = true;
      }
      if (state.terminal || stream.nonCapacityFailure || state.quota) state.capacity = null;
      if (state.quota) state.problem = quotaDiagnostic(state.quota.reprise);
      resolve(state.problem ? 1 : 0);
    });
  });
}
