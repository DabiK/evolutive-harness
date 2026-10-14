#!/usr/bin/env node
// PreToolUse(Edit|Write|…) : protège le harnais lui-même et le cadre du ticket en cours.
// Ouvrir le harnais dix heures, en session interactive seulement :
//   mkdir -p .harness-state && echo $(( $(date +%s) + 10*3600 )) > .harness-state/harnais-ouvert
import fs from "node:fs";
import path from "node:path";
import { isHarnessFile } from "../../scripts/loop/harness-files.mjs";
import { DEFAULTS } from "../../scripts/quality/config.mjs";
import { TICKET_NAMED_TEST } from "../../scripts/quality/metrics.mjs";
import { decide, loopMode, projectDir, readInput, refuseOrAsk, relative } from "./lib.mjs";

const input = readInput();
const root = projectDir(input);
const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
if (!target) process.exit(0);
const file = relative(root, target);

// Ce qui définit les règles ne se modifie pas en cours de ticket : sinon un contrôle rouge se « répare » en l'affaiblissant.
const isProtected = isHarnessFile(file);

// Le motif par défaut des fichiers de test, pas celui du projet : un harness.config.mjs cassé ne doit pas bloquer
// toute écriture, y compris celle qui le répare. scripts/check.mjs applique ensuite le motif du projet.
const name = path.basename(file);
const newFile = !fs.existsSync(path.resolve(root, target));
if (newFile && name.search(DEFAULTS.testFiles) !== -1 && TICKET_NAMED_TEST.test(name)) {
  const advice = "Nomme le fichier d'après le comportement testé, ou ajoute le test au fichier du module concerné.";
  decide("deny", `« ${name} » porte le nom d'un ticket ou d'une revue. ${advice}`);
}

// Déverrouillage temporaire : en session interactive, le propriétaire peut ouvrir le harnais pour une durée
// bornée, par un fichier hors Git qui contient l'heure de fin en secondes. Une session de ticket l'ignore.
const UNLOCK_FILE = ".harness-state/harnais-ouvert";
const UNLOCK_MAX_S = 24 * 3600;
function unlocked() {
  if (loopMode) return false;
  try {
    const until = Number(fs.readFileSync(path.join(root, UNLOCK_FILE), "utf8").trim());
    const left = until - Date.now() / 1000;
    return Number.isFinite(until) && left > 0 && left <= UNLOCK_MAX_S;
  } catch (error) {
    // Pas de fichier lisible : le harnais reste verrouillé.
    return false;
  }
}

if (isProtected && process.env.HARNESS_EDIT !== "1" && !unlocked()) {
  const when = "Il ne se modifie que dans un ticket marqué « harnais: oui » ou à la demande explicite de l'utilisateur.";
  refuseOrAsk(`${file} fait partie du harnais (règles, contrôles, boucle). ${when}`);
}

if (loopMode) {
  if (file.startsWith("..")) decide("deny", "Refusé pendant un ticket : écriture en dehors du projet.");
  const ticket = process.env.HARNESS_TICKET_FILE ? relative(root, process.env.HARNESS_TICKET_FILE) : null;
  // Le gabarit n'est pas un ticket mais le format des tickets : seul un ticket de harnais le modifie.
  const template = file === "docs/travail/tickets/_gabarit.md" && process.env.HARNESS_EDIT === "1";
  if (file.startsWith("docs/travail/tickets/") && file !== ticket && !template)
    decide("deny", "Refusé pendant un ticket : seul le journal du ticket en cours se modifie, pas les autres tickets.");
}
