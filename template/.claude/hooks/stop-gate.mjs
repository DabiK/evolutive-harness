#!/usr/bin/env node
// Stop / SubagentStop : une session de ticket ne se termine pas sur un contrôle rouge ni sans verdict.
// Bloque au plus MAX_BLOCKS fois de suite : au-delà, la boucle tranche avec ses propres contrôles.
// En interactif, rien n'est bloqué : un contrôle rouge est seulement signalé.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { block, loopMode, projectDir, readInput, stateDir } from "./lib.mjs";

const MAX_BLOCKS = 2;
const VERDICTS = ["TERMINÉ", "PARTIEL", "BLOQUÉ"];
const input = readInput();
const root = projectDir(input);
const subagent = process.argv.includes("--subagent");

// Le hook a 300 s (settings.json) : le contrôle doit avoir rendu la main avant, sinon ses tests lui survivraient.
const BUDGET_MS = process.env.HARNESS_TEST_BUDGET_MS || "240000";

function check(extra = []) {
  const env = { ...process.env, HARNESS_TEST_BUDGET_MS: BUDGET_MS };
  const result = spawnSync(process.execPath, ["scripts/check.mjs", "--changed", ...extra], { cwd: root, encoding: "utf8", env });
  return { ok: result.status === 0, out: (result.stdout || "") + (result.stderr || "") };
}

if (!loopMode && !subagent) {
  const result = check(["--no-tests"]);
  if (!result.ok) console.log(JSON.stringify({ systemMessage: "Contrôle qualité rouge sur les fichiers modifiés :\n" + result.out }));
  process.exit(0);
}

// Compteur de blocages par session (ou par sous-agent), pour ne jamais boucler sans fin.
const key = String((subagent && input.agent_id) || input.session_id || "session").replace(/[^A-Za-z0-9_-]/g, "");
const counterFile = path.join(stateDir(root, "stop"), key + ".json");
const blocks = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, "utf8")).blocks : 0;
if (blocks >= MAX_BLOCKS) process.exit(0);
const refuse = (reason) => {
  fs.writeFileSync(counterFile, JSON.stringify({ blocks: blocks + 1 }));
  block(reason);
};

if (subagent) {
  // Fin de l'implémenteur : son incrément doit passer le contrôle des fichiers modifiés.
  const result = check();
  if (!result.ok) refuse("Ton incrément ne passe pas le contrôle qualité. Corrige avant de rendre la main :\n" + result.out);
  process.exit(0);
}

const ticket = process.env.HARNESS_TICKET;
if (!ticket) process.exit(0);
const verdictFile = path.join(root, ".harness-state", "tickets", ticket, "verdict.json");
let verdict = null;
try {
  verdict = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
} catch (error) {
  // Verdict absent ou illisible : traité plus bas comme « pas de verdict ».
  verdict = null;
}
if (!verdict || !VERDICTS.includes(verdict.statut)) {
  const expected = `"statut" (${VERDICTS.join(", ")}) et "resume", comme le décrit la skill ticket`;
  refuse(`Aucun verdict pour ${ticket}. Écris .harness-state/tickets/${ticket}/verdict.json avec ${expected}.`);
}
if (verdict.statut === "TERMINÉ") {
  const result = check();
  const advice = "Corrige, ou passe le verdict à PARTIEL ou BLOQUÉ avec la raison";
  if (!result.ok) refuse(`Le verdict dit TERMINÉ mais le contrôle qualité est rouge. ${advice} :\n${result.out}`);
}
