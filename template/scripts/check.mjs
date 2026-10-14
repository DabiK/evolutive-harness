#!/usr/bin/env node
// Contrôle qualité unique du projet. Les hooks, la boucle de tickets et la CI appellent ce script :
// une règle s'écrit ici une seule fois. Ce qui est propre au projet vient de harness.config.mjs.
//
//   node scripts/check.mjs                 tout : règles, format, lint, cliquet, suites de tests (séquentielles)
//   node scripts/check.mjs --changed       fichiers modifiés depuis HEAD : règles, format, lint, cliquet, tests modifiés
//   node scripts/check.mjs --file <chemin> un fichier : règles, format, lint (contrôle rapide après une édition)
//   --no-tests  ne lance aucun test        --json  sortie structurée
//
// Un outil absent (Prettier, ESLint) est signalé « non lancé », jamais compté comme réussi.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isCoreFile } from "./loop/harness-files.mjs";
import { loadConfig } from "./quality/config.mjs";
import { directions, isCode, isProduction, isTest, measure, measureText, TICKET_NAMED_TEST } from "./quality/metrics.mjs";
import { compare, readBaseline } from "./quality/ratchet.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;
const steps = [];
const step = (name, status, detail = "") => steps.push({ name, status, detail });

// Durée maximale d'une suite de tests. Sans elle, un fichier de test qui ne se termine pas bloque le contrôle,
// donc la boucle, sans fin et sans message.
const TEST_BUDGET_MS = Number(process.env.HARNESS_TEST_BUDGET_MS) || 20 * 60 * 1000;
// Les tests du harnais lui-même, toujours lancés, quelle que soit la configuration du projet.
const HARNESS_SUITE = { name: "tests du harnais", command: ["node", "--test", "--test-concurrency=1"], files: /^tests\/harness\/[^/]+\.test\.cjs$/ };
// Fichiers passés à ESLint : JavaScript et TypeScript, même quand `codeFiles` couvre d'autres langages.
const LINTED = /\.(cjs|mjs|js|jsx|ts|tsx)$/;

if (!fs.existsSync(path.join(root, "scripts/check.mjs"))) {
  console.error("check : à lancer depuis la racine du projet.");
  process.exit(2);
}
let config;
try {
  config = await loadConfig(root);
} catch (error) {
  console.error(`check : harness.config.mjs est illisible : ${error.message}`);
  process.exit(2);
}

function run(command, commandArgs, budgetMs = 0) {
  const options = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  // Avec un budget, la commande mène son propre groupe de processus : à l'échéance tout le groupe est arrêté,
  // y compris les fichiers de test que le lanceur a démarrés et qui ne rendraient jamais la main.
  if (budgetMs) Object.assign(options, { timeout: budgetMs, killSignal: "SIGKILL", detached: true });
  const result = spawnSync(command, commandArgs, options);
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut && result.pid) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      // Le groupe a déjà disparu : il n'y a plus rien à arrêter.
    }
  }
  const missing = result.error?.code === "ENOENT" ? `commande introuvable : ${command}\n` : "";
  return { code: timedOut ? 1 : (result.status ?? 1), out: missing + (result.stdout || "") + (result.stderr || ""), timedOut };
}
const overBudget = (what) => `Délai dépassé (${Math.round(TEST_BUDGET_MS / 1000)} s) : ${what} ne se termine pas. Ses processus ont été arrêtés.`;
const git = (...gitArgs) => run("git", gitArgs);
const tail = (text, lines) => text.trimEnd().split("\n").slice(-lines).join("\n");
const bin = (name) => path.join(root, "node_modules", ".bin", name);

/** Fichiers modifiés ou ajoutés par rapport à HEAD (les suppressions sont ignorées). */
function changedFiles() {
  const { out } = git("status", "--porcelain", "--untracked-files=all");
  const files = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status.includes("D")) continue;
    const file = line.slice(3).split(" -> ").pop().replace(/^"|"$/g, "");
    files.push({ file, added: status.includes("?") || status.includes("A") });
  }
  return files;
}

/** Fichiers du projet, suivis ou non, hors fichiers ignorés par Git. */
function projectFiles() {
  return git("ls-files", "--cached", "--others", "--exclude-standard").out.split("\n").filter((f) => f && fs.existsSync(path.join(root, f)));
}

function inHead(file) {
  const result = git("show", `HEAD:${file}`);
  return result.code === 0 ? result.out : null;
}

/** Règles par fichier : comparent le fichier à sa version de HEAD, pour ne juger que ce qui a été ajouté. */
function fileRules(files) {
  const problems = [];
  for (const { file, added } of files) {
    if (!isCode(config, file) || !fs.existsSync(path.join(root, file))) continue;
    if (added && isTest(config, file) && TICKET_NAMED_TEST.test(path.basename(file)))
      problems.push(`${file} : un fichier de test porte le nom du comportement testé, pas celui d'un ticket ou d'une revue.`);
    const before = measureText(inHead(file) ?? "", config);
    const now = measureText(fs.readFileSync(path.join(root, file), "utf8"), config);
    if (now.lignes_longues > before.lignes_longues) {
      const extra = now.lignes_longues - before.lignes_longues;
      problems.push(`${file} : ${extra} ligne(s) de plus de ${config.maxLineLength} caractères ajoutée(s). Une instruction par ligne.`);
    }
    if (isProduction(config, file) && now.catch_vides > before.catch_vides)
      problems.push(`${file} : catch vide ajouté. Traiter l'erreur, ou la laisser passer avec un commentaire qui dit pourquoi.`);
  }
  step("règles par fichier", problems.length ? "ko" : "ok", problems.join("\n"));
}

/**
 * Fichiers que le format et le lint du projet jugent : les fichiers donnés, ou tout le projet, sans le noyau du
 * harnais. Le noyau suit son propre style, tenu dans evolutive-harness : la largeur de ligne ou les règles ESLint
 * d'un projet ne doivent pas rendre le contrôle rouge dès l'installation.
 */
const styledFiles = (files) => (files ?? projectFiles()).filter((f) => !isCoreFile(f) && fs.existsSync(path.join(root, f)));

/** Lance un outil sur des fichiers, par lots, pour ne jamais dépasser la longueur maximale d'une ligne de commande. */
function runInBatches(tool, toolArgs, files) {
  const outputs = [];
  let code = 0;
  for (let i = 0; i < files.length; i += 500) {
    const result = run(tool, [...toolArgs, ...files.slice(i, i + 500)]);
    if (result.code !== 0) code = result.code;
    outputs.push(result.out);
  }
  return { code, out: outputs.join("") };
}

function format(files) {
  if (!fs.existsSync(bin("prettier"))) return step("format", "skip", "Prettier n'est pas installé");
  const targets = styledFiles(files);
  if (!targets.length) return step("format", "ok");
  const result = runInBatches(bin("prettier"), ["--check", "--ignore-unknown"], targets);
  step("format", result.code === 0 ? "ok" : "ko", result.code === 0 ? "" : tail(result.out, 20));
}

function lint(files) {
  const configured = ["eslint.config.mjs", "eslint.config.js", "eslint.config.cjs"].some((f) => fs.existsSync(path.join(root, f)));
  if (!fs.existsSync(bin("eslint")) || !configured) return step("lint", "skip", "ESLint n'est pas installé ou pas configuré");
  const targets = styledFiles(files).filter((f) => LINTED.test(f));
  if (!targets.length) return step("lint", "ok");
  const result = runInBatches(bin("eslint"), [], targets);
  step("lint", result.code === 0 ? "ok" : "ko", result.code === 0 ? "" : tail(result.out, 30));
}

function ratchet() {
  const baseline = readBaseline(root);
  if (!baseline) return step("cliquet", "skip", "aucun plancher (node scripts/quality/ratchet.mjs --init)");
  const { regressions, improvements } = compare(baseline, measure(root, config), directions(config));
  const line = ({ key, before, now }) => `${key} : ${before} → ${now}`;
  if (regressions.length) return step("cliquet", "ko", "Mesures dégradées :\n" + regressions.map(line).join("\n"));
  step("cliquet", "ok", improvements.length ? "Mesures améliorées : " + improvements.map(line).join(", ") : "");
}

/** Résumé d'une sortie de `node --test` ; vide pour un autre lanceur. */
const nodeSummary = (out) => out.split("\n").filter((l) => /^ℹ (tests|pass|fail)|^✖/.test(l)).slice(0, 40).join("\n");

/** Une suite de tests : tous ses fichiers, ou seulement ceux qui ont changé. */
function testSuite(suite, all, changed) {
  // `search` plutôt que `test` : une expression de la configuration peut porter le drapeau « g ».
  const inSuite = all.filter((f) => f.search(suite.files) !== -1);
  const targets = changed ? inSuite.filter((f) => changed.includes(f)) : inSuite;
  if (!targets.length) return step(suite.name, changed ? "ok" : "skip", changed ? "" : "aucun test");
  // Séquentiel : sous charge, les fichiers lancés en parallèle se perturbent (échecs intermittents déjà observés).
  const [command, ...commandArgs] = suite.command;
  const result = run(command === "node" ? process.execPath : command, [...commandArgs, ...targets], TEST_BUDGET_MS);
  const ok = result.code === 0;
  const summary = nodeSummary(result.out) || tail(result.out, ok ? 3 : 25);
  const detail = result.timedOut ? overBudget(`un test de « ${suite.name} »`) + "\n" + tail(result.out, 15) : summary;
  step(`${suite.name} (${targets.length} fichier(s))`, ok ? "ok" : "ko", detail);
}

// Les chemins de Git sont relatifs à la racine du dépôt : le harnais ne travaille que depuis celle-ci.
const prefix = git("rev-parse", "--show-prefix");
if (prefix.code !== 0 || prefix.out.trim()) {
  console.error("check : le projet doit être la racine d'un dépôt Git (git init).");
  process.exit(2);
}

if (fileArg) {
  const file = path.relative(root, path.resolve(root, fileArg)).split(path.sep).join("/");
  if (!file.startsWith("..")) {
    const added = git("ls-files", "--error-unmatch", file).code !== 0;
    fileRules([{ file, added }]);
    format([file]);
    lint([file]);
  }
} else {
  const changed = flag("--changed") ? changedFiles() : null;
  const names = changed ? changed.map((c) => c.file) : null;
  fileRules(changed ?? changedFiles());
  format(names);
  lint(names);
  ratchet();
  if (!flag("--no-tests")) {
    const all = projectFiles();
    for (const suite of [...config.suites, HARNESS_SUITE]) testSuite(suite, all, names);
  }
}

const ok = steps.every((s) => s.status !== "ko");
if (flag("--json")) {
  console.log(JSON.stringify({ ok, steps }, null, 2));
} else {
  const mark = { ok: "✔", ko: "✖", skip: "–" };
  for (const s of steps) {
    console.log(`${mark[s.status]} ${s.name}${s.status === "skip" ? " : non lancé (" + s.detail + ")" : ""}`);
    if (s.status !== "skip" && s.detail) console.log(s.detail.split("\n").map((l) => "    " + l).join("\n"));
  }
  console.log(ok ? "check : vert" : "check : ROUGE");
}
process.exit(ok ? 0 : 1);
