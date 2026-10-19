// Plugin OpenCode du harnais : les scripts de .claude/hooks/ branchés sur une session OpenCode, comme .codex/hooks.json
// les branche sur Codex. Chaque script tourne dans un processus node séparé et reçoit l'entrée qu'en attend Claude Code.
//
//   avant un outil   guard-write (write, edit, patch) et guard-bash (shell) ; leur refus passe par l'évaluation
//                    des permissions d'OpenCode, que le modèle lit comme une erreur de l'outil
//   après un outil   after-edit : un contrôle rapide en échec s'ajoute au résultat de l'outil
//   premier message  session-context : contexte ajouté au message, témoin de démarrage en boucle
//   compaction       record-compaction : trace et consignes du résumé
//
// OpenCode n'a pas de fin de tour bloquante : la boucle appelle elle-même stop-gate.mjs après chaque session
// (scripts/loop/opencode.mjs). Un hook de ce plugin ne lève jamais d'exception : OpenCode en ferait une erreur fatale
// de la session. Un garde-fou en échec refuse l'appel en boucle et le soumet à la personne présente sinon.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD_TIMEOUT_MS = 10000;
const AFTER_EDIT_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 64 * 1024;

const loopMode = () => process.env.HARNESS_LOOP === "1";

/** Lance un script de .claude/hooks/ ; rend sa sortie, ou `problem` s'il n'a pas pu rendre la main normalement. */
function runHook(name, input, timeoutMs) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT, HARNESS_ENGINE: process.env.HARNESS_ENGINE || "opencode" };
    let child;
    try {
      child = spawn("node", [path.join(ROOT, ".claude", "hooks", `${name}.mjs`)], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ problem: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(0, MAX_OUTPUT)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-MAX_OUTPUT)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ problem: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) resolve({ problem: `${name} interrompu (${signal}, délai ${timeoutMs} ms)` });
      else if (code !== 0) resolve({ problem: `${name} en échec (code ${code}) : ${stderr.trim()}` });
      else resolve({ stdout });
    });
    child.stdin.on("error", () => {
      // Le script peut se terminer sans lire son entrée : la fermeture de son entrée ne change pas sa décision.
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const json = (text) => {
  try {
    return text.trim() ? JSON.parse(text) : null;
  } catch (error) {
    // Une sortie qui n'est pas du JSON ne porte aucune décision lisible.
    return undefined;
  }
};

/** L'entrée Claude Code d'un appel d'outil OpenCode, ou null pour un outil que le harnais ne garde pas. */
function hookCall(tool, input, directory) {
  const file = (value) => (typeof value === "string" ? path.resolve(directory, value) : value);
  if (tool === "write") return { kind: "edit", input: { tool_name: "Write", tool_input: { file_path: file(input?.path) } } };
  if (tool === "edit") return { kind: "edit", input: { tool_name: "Edit", tool_input: { file_path: file(input?.path) } } };
  if (tool === "patch") return { kind: "edit", input: { tool_name: "apply_patch", tool_input: { command: String(input?.patchText ?? "") } } };
  if (tool === "shell") return { kind: "shell", input: { tool_name: "Bash", tool_input: { command: String(input?.command ?? "") } } };
  return null;
}

/** Décision d'un garde-fou : { effect: "deny" | "ask", message }, ou null s'il laisse passer. */
async function guard(call) {
  const name = call.kind === "edit" ? "guard-write" : "guard-bash";
  const failed = (problem) => ({
    effect: loopMode() ? "deny" : "ask",
    message: `Garde-fou du harnais en échec (${name}) : ${problem}. L'appel n'est pas autorisé sans lui.`,
  });
  const result = await runHook(name, call.input, GUARD_TIMEOUT_MS);
  if (result.problem) return failed(result.problem);
  const output = json(result.stdout);
  if (output === undefined) return failed("sortie illisible");
  const decision = output?.hookSpecificOutput?.permissionDecision;
  if (decision !== "deny" && decision !== "ask") return null;
  return { effect: decision, message: output.hookSpecificOutput.permissionDecisionReason || `Refusé par ${name}.` };
}

export default {
  id: "evolutive-harness",
  async setup(ctx) {
    const directory = ctx.location?.directory || ROOT;
    // Décision de chaque appel d'outil gardé, en attendant que l'évaluation de sa permission la lise (même identifiant).
    const decisions = new Map();
    const started = new Set();

    await ctx.tool.hook("execute.before", async (event) => {
      try {
        const call = hookCall(event.tool, event.input, directory);
        if (!call) return;
        const decision = await guard(call);
        if (decision) decisions.set(event.id, decision);
        else decisions.delete(event.id);
      } catch (error) {
        decisions.set(event.id, { effect: loopMode() ? "deny" : "ask", message: `Garde-fou du harnais en échec : ${error.message}.` });
      }
    });

    await ctx.permission.hook("evaluate", (event) => {
      const id = event.source?.id;
      const decision = id ? decisions.get(id) : null;
      if (!decision) return;
      decisions.delete(id);
      event.effect = decision.effect;
      event.message = decision.message;
    });

    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.status !== "completed") return;
        const call = hookCall(event.tool, event.input, directory);
        if (call?.kind !== "edit") return;
        const result = await runHook("after-edit", call.input, AFTER_EDIT_TIMEOUT_MS);
        const output = result.problem ? null : json(result.stdout);
        const reason = result.problem ? `Contrôle rapide indisponible : ${result.problem}.` : output?.decision === "block" ? output.reason : null;
        if (!reason) return;
        const content = Array.isArray(event.result.content) ? event.result.content : [];
        event.result.content = [...content, { type: "text", text: reason }];
      } catch (error) {
        // Le contrôle complet de la boucle reste le dernier mur : un contrôle rapide manqué ne bloque pas l'édition faite.
      }
    });

    await ctx.session.hook("prompt", async (event) => {
      try {
        if (started.has(event.sessionID)) return;
        started.add(event.sessionID);
        const input = { session_id: event.sessionID, cwd: ROOT, hook_event_name: "SessionStart" };
        const result = await runHook("session-context", input, GUARD_TIMEOUT_MS);
        const context = result.problem ? null : json(result.stdout)?.hookSpecificOutput?.additionalContext;
        if (context && typeof event.prompt?.text === "string") event.prompt.text = `${event.prompt.text}\n\n${context}`;
      } catch (error) {
        // Sans témoin de démarrage, la boucle refuse la session : l'absence de contexte ne passe pas inaperçue.
      }
    });

    await ctx.session.hook("compaction", async (event) => {
      try {
        const result = await runHook("record-compaction", { session_id: event.sessionID, trigger: "auto" }, GUARD_TIMEOUT_MS);
        const advice = result.problem ? "" : result.stdout.trim();
        if (advice && Array.isArray(event.system)) event.system.push({ type: "text", text: advice });
      } catch (error) {
        // Une compaction non tracée reste visible dans le flux de la session.
      }
    });
  },
};
