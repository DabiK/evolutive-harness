// Mesures de qualité sans dépendance : elles alimentent le cliquet (scripts/quality/ratchet.mjs).
// Chaque mesure est un simple comptage reproductible ; aucune ne juge le code. Les dossiers, les fichiers de code
// et les mesures propres au projet viennent de harness.config.mjs (scripts/quality/config.mjs).
import fs from "node:fs";
import path from "node:path";

// Les tests du harnais lui-même : leur qualité se tient dans evolutive-harness, pas dans les mesures du projet.
export const HARNESS_TESTS = "tests/harness";
const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
// Un fichier de test porte le nom d'un comportement, pas celui d'un chantier ou d'une revue.
// Visés : « architecture-f07 », « t012-… », « issue-9 », « review-regressions », « refactor-boundaries ».
export const TICKET_NAMED_TEST = /(^|[-_.])(f\d{2}|t\d{3}|(ticket|issue)-?\d+|review|refactor)([-_.]|$)/i;

/** Sens des mesures du noyau : "max" ne peut que baisser, "min" ne peut que monter. */
export const CORE_DIRECTIONS = {
  lignes_longues_prod: "max",
  lignes_longues_tests: "max",
  catch_vides_prod: "max",
  tests_nommes_par_chantier: "max",
  cas_de_test: "min",
};

/** Sens de chaque mesure : celles du noyau, puis celles que le projet déclare dans sa configuration. */
export function directions(config) {
  const own = Object.entries(config.measures || {}).map(([key, measure]) => [key, measure.direction || "max"]);
  return { ...CORE_DIRECTIONS, ...Object.fromEntries(own) };
}

// `search` ignore le drapeau « g » et l'état d'une expression : une expression de la configuration peut l'avoir.
const matches = (pattern, text) => text.search(pattern) !== -1;

function count(text, pattern) {
  const global = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  return (text.match(global) || []).length;
}

export const isCode = (config, file) => matches(config.codeFiles, path.basename(file));
export const isTest = (config, file) => matches(config.testFiles, path.basename(file));
export const isProduction = (config, file) => config.productionDirs.some((dir) => file.startsWith(dir + "/"));

function walk(root, dir, config, out = []) {
  const abs = path.join(root, dir);
  if (dir === HARNESS_TESTS || !fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, rel, config, out);
    else if (isCode(config, rel)) out.push(rel);
  }
  return out;
}

export function longLines(text, max) {
  let lines = 0;
  for (const line of text.split("\n")) if (line.length > max) lines++;
  return lines;
}

export function emptyCatches(text) {
  return count(text, EMPTY_CATCH);
}

/** Mesures d'un seul fichier, utilisées par le contrôle rapide après chaque édition. */
export function measureText(text, config) {
  return { lignes_longues: longLines(text, config.maxLineLength), catch_vides: emptyCatches(text) };
}

export function measure(root, config) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const prod = [...new Set(config.productionDirs.flatMap((dir) => walk(root, dir, config)))].sort();
  const tests = walk(root, config.testDir, config).sort();
  const m = Object.fromEntries(Object.keys(directions(config)).map((key) => [key, 0]));
  for (const rel of prod) {
    const text = read(rel);
    m.lignes_longues_prod += longLines(text, config.maxLineLength);
    m.catch_vides_prod += emptyCatches(text);
    for (const [key, own] of Object.entries(config.measures || {})) {
      if ((own.except || []).includes(rel)) continue;
      m[key] += own.perFile ? Number(matches(own.pattern, text)) : count(text, own.pattern);
    }
  }
  for (const rel of tests) {
    const text = read(rel);
    m.lignes_longues_tests += longLines(text, config.maxLineLength);
    if (!isTest(config, rel)) continue;
    if (TICKET_NAMED_TEST.test(path.basename(rel))) m.tests_nommes_par_chantier++;
    m.cas_de_test += count(text, config.testCase);
  }
  return m;
}
