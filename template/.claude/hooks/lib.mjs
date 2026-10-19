// Fonctions communes aux hooks. Un hook ne porte aucune règle de qualité : il appelle scripts/check.mjs.
// Deux modes : « boucle » (HARNESS_LOOP=1, session lancée par scripts/loop/run.mjs, personne pour répondre)
// et « interactif » (une personne est là : on demande au lieu de refuser).
import fs from "node:fs";
import path from "node:path";

export function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch (error) {
    // Entrée absente ou illisible : le hook se comporte comme s'il n'avait reçu aucun détail.
    return {};
  }
}

export const loopMode = process.env.HARNESS_LOOP === "1";

/** Sans racine Claude, les hooks partagés sont reçus par Codex, même en interactif. */
export function ticketSkill() {
  const codex = process.env.HARNESS_ENGINE === "codex" || !process.env.CLAUDE_PROJECT_DIR;
  return codex ? ".agents/skills/ticket-codex/SKILL.md" : "ticket";
}

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

/** Chemin relatif au projet, avec des « / » ; commence par « .. » si le fichier est en dehors. */
export function relative(root, file) {
  return path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
}

/** Chemins d'une édition ou d'un patch Codex, sources et destinations de déplacement comprises. */
export function editPaths(input) {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (target) return [target];
  return [...String(input.tool_input?.command || "").matchAll(
    /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
  )].map((match) => match[1].trim());
}

/** Réponse d'un hook PreToolUse : "deny" refuse, "ask" demande à la personne présente. */
export function decide(decision, reason) {
  const output = { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason };
  console.log(JSON.stringify({ hookSpecificOutput: output }));
  process.exit(0);
}

/** En boucle on refuse ; en interactif on demande. */
export function refuseOrAsk(reason) {
  decide(loopMode ? "deny" : "ask", reason);
}

/** Bloque la fin de tour (Stop, SubagentStop) ou signale un problème après un outil (PostToolUse). */
export function block(reason) {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

export function stateDir(root, ...parts) {
  const dir = path.join(root, ".harness-state", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
