#!/usr/bin/env node
// SessionStart : donne à la session l'état réel du dépôt et de la machine, en quelques lignes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loopMode, projectDir, readInput } from "./lib.mjs";

const root = projectDir(readInput());
const sh = (command, args) => (spawnSync(command, args, { cwd: root, encoding: "utf8" }).stdout || "").trim();

const branch = sh("git", ["branch", "--show-current"]) || "(HEAD détachée)";
const head = sh("git", ["log", "-1", "--format=%h %s"]);
const dirty = sh("git", ["status", "--porcelain"]).split("\n").filter(Boolean).length;
const swap = process.platform === "darwin" ? sh("sysctl", ["-n", "vm.swapusage"]) : "";

/** Propositions de la rétrospective encore à trancher par le propriétaire. */
function openProposals() {
  const file = path.join(root, ".harness-state", "retours", "observations.jsonl");
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.filter((line) => {
    try {
      return JSON.parse(line).statut === "propose";
    } catch (error) {
      // Ligne abîmée : elle ne compte pas comme une proposition.
      return false;
    }
  }).length;
}

const lines = [
  `Branche ${branch} — ${head}`,
  `${dirty} fichier(s) modifié(s) ou non suivi(s).`,
  loopMode
    ? `Mode boucle : ticket ${process.env.HARNESS_TICKET} (${process.env.HARNESS_TICKET_FILE}). Suis la skill ticket ; ne committe pas, ne pousse pas.`
    : "Mode interactif. Pour traiter un ticket de docs/travail/tickets/, suivre la skill ticket.",
  "Contrôle qualité : node scripts/check.mjs (--changed pour les fichiers modifiés). Règles : docs/standards.md.",
];
const proposals = loopMode ? 0 : openProposals();
if (proposals) lines.push(`${proposals} proposition(s) de la rétrospective à trancher : node scripts/loop/retro.mjs liste.`);
if (swap) lines.push(`Mémoire d'échange : ${swap}.`);

console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }));
