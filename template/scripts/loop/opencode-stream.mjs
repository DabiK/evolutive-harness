// Un processus `opencode run --format json` : la consigne passe par l'entrée standard, fermée aussitôt (sans quoi
// OpenCode attend la fin d'une entrée qui ne vient pas), et le flux JSONL est lu au fil de l'eau.
//
// Le flux d'OpenCode 2 : `step_start`, `text`, `tool_use` (outil terminé ou en erreur), `step_finish` (coût et jetons
// de l'étape) et `error`, chacun avec `sessionID`. La dernière étape d'une session n'a pas de `step_finish` : le coût
// de la session se lit ensuite dans son export (opencode.mjs), le flux n'en donne qu'une estimation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MAX_ACTION_LENGTH = 160;
export const MAX_DIAGNOSTIC_LENGTH = 2000;
const MAX_TOOL_ERRORS = 20;
const MAX_SESSION_ID_LENGTH = 160;
const TERMINATION_GRACE_MS = 1000;

/** Ce qu'une invocation a observé dans son flux. */
export function invocationState() {
  return { session: null, steps: 0, cost: 0, tokens: 0, toolErrors: [], problem: null, terminal: false };
}

function elapsed(started) {
  const seconds = Math.round((Date.now() - started) / MS_PER_SECOND);
  return `${String(Math.floor(seconds / SECONDS_PER_MINUTE)).padStart(2, "0")}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

/** La cible d'un appel d'outil, comme la boucle l'affiche pour Claude : la commande, le fichier ou le motif. */
function target(root, tool, input = {}) {
  const relative = (p) => (typeof p === "string" && path.isAbsolute(p) ? path.relative(root, p) : p);
  if (tool === "shell") return input.command;
  if (tool === "patch") return [...String(input.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]).join(", ");
  return relative(input.path) || input.pattern || input.id || input.url || "";
}

function showTool(root, part, started, state) {
  const { tool, state: call = {} } = part || {};
  if (typeof tool !== "string") return;
  const line = `${tool} ${String(target(root, tool, call.input) ?? "").replace(/\s+/g, " ").trim()}`.trim();
  if (call.status === "error") {
    const reason = String(call.error || "").split("\n")[0];
    if (state.toolErrors.length < MAX_TOOL_ERRORS) state.toolErrors.push(`${line} : ${reason}`.slice(0, 300));
    console.log(`[boucle] ${elapsed(started)}  ${`${line} — erreur : ${reason}`.slice(0, MAX_ACTION_LENGTH)}`);
  } else {
    console.log(`[boucle] ${elapsed(started)}  ${line.slice(0, MAX_ACTION_LENGTH)}`);
  }
}

function readIdentity(message, state) {
  const session = message.sessionID;
  if (session === undefined || session === "") return;
  const valid = typeof session === "string" && session.length <= MAX_SESSION_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(session);
  if (!valid || (state.session && state.session !== session)) {
    state.problem ||= "OpenCode : identité de session invalide ou contradictoire dans le flux.";
    state.terminal = true;
    return;
  }
  state.session = session;
}

function consumeLine(root, line, state, started) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    // Le flux brut reste archivé même si une ligne ne suit pas le protocole JSONL.
    return;
  }
  if (!message || typeof message !== "object") return;
  readIdentity(message, state);
  if (message.type === "step_start") state.steps++;
  if (message.type === "tool_use") showTool(root, message.part, started, state);
  if (message.type === "step_finish") {
    const { cost, tokens } = message.part || {};
    if (Number.isFinite(cost)) state.cost += cost;
    if (tokens && typeof tokens === "object") state.tokens += (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0);
  }
  if (message.type === "error") {
    const reason = message.error?.message || message.message || "erreur du flux";
    state.problem ||= `OpenCode : ${reason}`.slice(0, MAX_DIAGNOSTIC_LENGTH);
  }
}

/** Lance une invocation ; rend son code (0 sans problème). Le flux brut s'ajoute à `file`, l'erreur standard à `file.stderr`. */
export function streamOpencode(root, args, { env, prompt, file, state, timeoutMs, started }) {
  return new Promise((resolve) => {
    const child = spawn(env.HARNESS_OPENCODE_BIN || "opencode", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let killTimer;
    const timer = setTimeout(() => {
      state.problem ||= "OpenCode : délai maximal dépassé.";
      state.terminal = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    }, timeoutMs);
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => consumeLine(root, line, state, started));
    child.stdout.on("data", (chunk) => fs.appendFileSync(file, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(`${file}.stderr`, chunk);
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
    });
    child.stdin.on("error", () => {
      // Un processus qui meurt avant d'avoir lu la consigne rend son propre diagnostic à sa fermeture.
    });
    child.stdin.end(prompt);
    child.on("error", (error) => {
      state.problem ||= `OpenCode : ${error.code} (${error.message})`;
      state.terminal = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) state.terminal = true;
      if (code !== 0) state.problem ||= `OpenCode : processus en échec (code ${code ?? signal}). ${stderr}`.trim();
      if (!state.session) state.problem ||= "OpenCode : aucune identité de session dans le flux.";
      resolve(state.problem ? 1 : 0);
    });
  });
}
