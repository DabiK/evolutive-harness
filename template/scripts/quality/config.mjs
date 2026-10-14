// Configuration du harnais pour le projet : `harness.config.mjs` à la racine, fusionné avec les valeurs par défaut.
// Le noyau du harnais ne porte rien de propre à un projet : dossiers, suites de tests, mesures et modèles viennent d'ici.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_FILE = "harness.config.mjs";

export const DEFAULTS = {
  // Nom affiché dans le nom des sessions de la boucle et dans la rétrospective.
  project: "projet",
  // Fichiers de code soumis aux règles par fichier et comptés par le cliquet.
  codeFiles: /\.(cjs|mjs|js|jsx|ts|tsx|py)$/,
  // Fichiers de test, reconnus à leur nom (sans le dossier).
  testFiles: /(\.(test|spec)\.(cjs|mjs|js|jsx|ts|tsx)|^test_.*\.py)$/,
  // Une ligne qui déclare un cas de test, comptée par le cliquet (`cas_de_test`).
  testCase: /^\s*(test|it)\(|^\s*def test_/gm,
  // Dossiers du code de production.
  productionDirs: ["src"],
  // Dossier des tests du projet. Les tests du harnais (tests/harness/) n'entrent pas dans ses mesures.
  testDir: "tests",
  // Longueur maximale d'une ligne de code.
  maxLineLength: 160,
  // Suites de tests du projet : `files` choisit les fichiers (chemin relatif), `command` les reçoit en arguments.
  suites: [],
  // Mesures propres au projet, ajoutées à celles du cliquet.
  measures: {},
  // Échelle de modèles de la boucle, niveaux de ticket et modèle de la rétrospective (scripts/loop/models.mjs).
  models: {},
};

/** Configuration du projet fusionnée avec les valeurs par défaut ; les valeurs par défaut seules sans fichier. */
export async function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  const { default: project = {} } = await import(pathToFileURL(file).href);
  const config = { ...DEFAULTS, ...project, models: { ...DEFAULTS.models, ...project.models } };
  if (!Array.isArray(config.suites)) throw new Error(`${CONFIG_FILE} : « suites » doit être une liste.`);
  for (const suite of config.suites) {
    if (!suite.name || !Array.isArray(suite.command) || !(suite.files instanceof RegExp))
      throw new Error(`${CONFIG_FILE} : chaque suite a un « name », une « command » (liste) et des « files » (expression régulière).`);
  }
  if (!Array.isArray(config.productionDirs) || !config.productionDirs.every((dir) => typeof dir === "string"))
    throw new Error(`${CONFIG_FILE} : « productionDirs » doit être une liste de dossiers.`);
  for (const key of ["codeFiles", "testFiles", "testCase"])
    if (!(config[key] instanceof RegExp)) throw new Error(`${CONFIG_FILE} : « ${key} » doit être une expression régulière.`);
  for (const [key, measure] of Object.entries(config.measures || {})) {
    if (!(measure?.pattern instanceof RegExp) || !["max", "min", undefined].includes(measure.direction))
      throw new Error(`${CONFIG_FILE} : la mesure « ${key} » a un « pattern » (expression régulière) et une « direction » "max" ou "min".`);
  }
  return config;
}
