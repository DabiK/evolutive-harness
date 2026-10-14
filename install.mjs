#!/usr/bin/env node
// Installe le harnais dans un projet, le met à jour, compare les deux, ou reprend dans le modèle une
// amélioration faite dans un projet.
//
//   node install.mjs <projet>                       installe ; refuse si un fichier du noyau existe déjà et diffère
//   node install.mjs <projet> --update              met à jour le noyau ; un fichier modifié dans le projet est gardé
//   node install.mjs <projet> --compare [--diff]    ce qui a divergé entre le projet et le modèle, dans les deux sens
//   node install.mjs <projet> --pull <fichier>...   reprend dans le modèle la version du projet de ces fichiers
//   --dry-run  montre ce qui serait fait, sans rien écrire
//   --force    installe ou met à jour aussi par-dessus un fichier du noyau modifié dans le projet
//   --from <dossier>  modèle à utiliser (par défaut : template/, à côté de ce script)
//
// Trois sortes de fichiers. Le noyau est remplacé par --update. Les fichiers du projet (PROJECT_FILES) sont
// installés une fois puis ne sont plus jamais touchés. `.claude/settings.json` et `.gitignore` sont fusionnés.
// Le verrou `.claude/harness.lock.json` garde l'empreinte de chaque fichier du noyau tel qu'il a été installé :
// c'est lui qui distingue un fichier modifié dans le projet d'un fichier modifié dans le modèle.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_FILES = ["CLAUDE.md", "harness.config.mjs", "docs/standards.md"];
const SETTINGS = ".claude/settings.json";
const LOCK = ".claude/harness.lock.json";
const GITIGNORE_LINE = ".harness-state/";
// Fichiers qu'un projet ne remonte jamais dans le modèle : ses données, son verrou, ses réglages.
const NEVER_PULLED = [LOCK, SETTINGS, ".claude/settings.local.json", "scripts/quality/baseline.json", ...PROJECT_FILES];

const say = (message = "") => console.log(message);
const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

function parseArgs(argv) {
  const options = { target: null, mode: "install", files: [], dryRun: false, force: false, diff: false, from: path.join(HERE, "template") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update" || arg === "--compare") options.mode = arg.slice(2);
    else if (arg === "--pull") options.mode = "pull";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--from") options.from = path.resolve(argv[++i] || "");
    else if (arg.startsWith("--")) fail(2, `Option inconnue : ${arg}`);
    else if (!options.target) options.target = path.resolve(arg);
    else options.files.push(arg);
  }
  if (!options.target) fail(2, "Usage : node install.mjs <projet> [--update | --compare [--diff] | --pull <fichier>...] [--dry-run] [--force]");
  return options;
}

const toPosix = (p) => p.split(path.sep).join("/");

function walk(root, dir = "", out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Version du modèle : celle du package.json qui l'accompagne, et le commit du dépôt s'il y en a un. */
function templateVersion(from) {
  const pkg = path.join(from, "..", "package.json");
  const version = fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, "utf8")).version : null;
  const git = (...args) => spawnSync("git", ["-C", from, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "--short", "HEAD");
  const commit = head.status === 0 ? head.stdout.trim() : null;
  const dirty = commit && git("status", "--porcelain", "--", ".").stdout.trim() ? "+modifié" : "";
  return { version, commit: commit ? commit + dirty : null };
}

/**
 * Le modèle, classé : noyau, fichiers du projet, fichiers fusionnés. La liste du noyau est celle du modèle
 * lui-même (scripts/loop/harness-files.mjs) : un fichier du modèle qui n'entre dans aucune des trois sortes est
 * une erreur du modèle, signalée avant d'écrire quoi que ce soit.
 */
async function readTemplate(from) {
  const listFile = path.join(from, "scripts/loop/harness-files.mjs");
  if (!fs.existsSync(listFile)) fail(2, `Modèle introuvable ou incomplet : ${from}`);
  const { isCoreFile } = await import(pathToFileURL(listFile).href);
  const files = walk(from).map(toPosix);
  const project = PROJECT_FILES.filter((f) => files.includes(f));
  const core = files.filter((f) => isCoreFile(f));
  const stray = files.filter((f) => !isCoreFile(f) && !PROJECT_FILES.includes(f) && f !== SETTINGS);
  if (stray.length) fail(2, `Fichiers du modèle hors du noyau (scripts/loop/harness-files.mjs) : ${stray.join(", ")}`);
  const settings = JSON.parse(fs.readFileSync(path.join(from, SETTINGS), "utf8"));
  return { from, core, project, settings, isCoreFile };
}

/** Le projet doit être la racine d'un dépôt Git : le contrôle et la boucle lisent ses chemins depuis la racine. */
function requireGitRoot(target) {
  const prefix = spawnSync("git", ["-C", target, "rev-parse", "--show-prefix"], { encoding: "utf8" });
  if (prefix.status !== 0) fail(1, `${target} n'est pas un dépôt Git : lancer git init d'abord.`);
  if (prefix.stdout.trim()) fail(1, `${target} est un sous-dossier d'un dépôt Git : installer le harnais à la racine du dépôt.`);
}

function readLock(target) {
  const file = path.join(target, LOCK);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(1, `${LOCK} est illisible (${error.message}) : le restaurer depuis Git avant de continuer.`);
  }
  return null;
}

/** Noms des hooks du harnais, ceux du modèle et ceux déjà installés : leurs entrées de réglages sont les nôtres. */
function harnessHookNames(template, lock) {
  const hooks = [...template.core, ...Object.keys(lock?.files || {})].filter((f) => f.startsWith(".claude/hooks/"));
  return [...new Set(hooks.map((f) => path.posix.basename(f)))];
}

/**
 * Réglages du projet avec les hooks du harnais : les entrées qui appellent un hook du harnais sont retirées puis
 * remplacées par celles du modèle ; les autres hooks et réglages du projet restent tels quels.
 */
export function mergeSettings(project, template, hookNames) {
  const merged = structuredClone(project || {});
  const ours = (hook) => hookNames.some((name) => String(hook.command || "").includes(`.claude/hooks/${name}`));
  merged.hooks = merged.hooks || {};
  for (const [event, groups] of Object.entries(merged.hooks)) {
    const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !ours(hook)) })).filter((g) => g.hooks.length);
    if (kept.length) merged.hooks[event] = kept;
    else delete merged.hooks[event];
  }
  for (const [event, groups] of Object.entries(template.hooks || {})) merged.hooks[event] = [...(merged.hooks[event] || []), ...structuredClone(groups)];
  const deny = [...new Set([...(merged.permissions?.deny || []), ...(template.permissions?.deny || [])])];
  if (deny.length) merged.permissions = { ...merged.permissions, deny };
  return merged;
}

/** Les actions sur les fichiers, écrites seulement hors --dry-run. */
function writer(options) {
  const done = [];
  const copy = (fromRoot, toRoot, rel, label) => {
    done.push(`${label} ${rel}`);
    if (options.dryRun) return;
    fs.mkdirSync(path.dirname(path.join(toRoot, rel)), { recursive: true });
    fs.copyFileSync(path.join(fromRoot, rel), path.join(toRoot, rel));
  };
  const remove = (root, rel) => {
    done.push(`retiré ${rel}`);
    if (!options.dryRun) fs.rmSync(path.join(root, rel));
  };
  const writeText = (root, rel, text, label) => {
    done.push(`${label} ${rel}`);
    if (options.dryRun) return;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { done, copy, remove, writeText };
}

function readSettings(target) {
  const file = path.join(target, SETTINGS);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(1, `${SETTINGS} du projet est illisible (${error.message}) : le corriger avant d'installer.`);
  }
  return null;
}

/** Réglages, .gitignore et fichiers du projet manquants : communs à l'installation et à la mise à jour. */
function shared(template, options, lock, write) {
  const { target } = options;
  const before = readSettings(target);
  const merged = mergeSettings(before, template.settings, harnessHookNames(template, lock));
  if (JSON.stringify(merged) !== JSON.stringify(before)) {
    write.writeText(target, SETTINGS, JSON.stringify(merged, null, 2) + "\n", before ? "fusionné" : "ajouté");
  }
  const ignore = path.join(target, ".gitignore");
  const text = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  if (!text.split("\n").some((line) => line.trim() === GITIGNORE_LINE)) {
    const separator = text && !text.endsWith("\n") ? "\n" : "";
    const block = `# État local de la boucle (evolutive-harness)\n${GITIGNORE_LINE}\n`;
    write.writeText(target, ".gitignore", `${text}${separator}${block}`, text ? "complété" : "ajouté");
  }
  for (const rel of template.project) if (!fs.existsSync(path.join(target, rel))) write.copy(template.from, target, rel, "ajouté");
}

/** Écrit le verrou, sauf s'il dirait la même chose que l'actuel : une mise à jour sans effet ne laisse pas de diff. */
function writeLock(template, options, files, write, current = null) {
  const sorted = Object.fromEntries(Object.entries(files).sort());
  const version = templateVersion(template.from);
  const same = current && current.version === version.version && current.commit === version.commit;
  if (same && JSON.stringify(current.files) === JSON.stringify(sorted)) return;
  const lock = { ...version, date: new Date().toISOString(), files: sorted };
  write.writeText(options.target, LOCK, JSON.stringify(lock, null, 2) + "\n", "verrou");
}

function report(write, conflicts, options) {
  for (const line of write.done) say(`  ${line}`);
  if (conflicts.length) {
    say(`\n${conflicts.length} fichier(s) laissé(s) tel(s) quel(s) :`);
    for (const c of conflicts) say(`  ${c.rel} : ${c.why}`);
    say("Voir l'écart : node install.mjs <projet> --compare --diff. Remonter la version du projet : --pull ; l'écraser : --force.");
  }
  if (options.dryRun) say("\n(--dry-run : rien n'a été écrit)");
}

function install(template, options) {
  const { target } = options;
  if (readLock(target)) fail(1, `Le harnais est déjà installé dans ${target} : utiliser --update.`);
  const conflicts = [];
  const toCopy = [];
  for (const rel of template.core) {
    const ours = fingerprint(path.join(template.from, rel));
    const theirs = fingerprint(path.join(target, rel));
    if (theirs === null) toCopy.push(rel);
    else if (theirs !== ours) conflicts.push({ rel, why: "existe déjà dans le projet, avec un autre contenu" });
  }
  if (conflicts.length && !options.force) {
    say(`Installation refusée, rien n'a été écrit : ${conflicts.length} fichier(s) du projet seraient écrasés.`);
    for (const c of conflicts) say(`  ${c.rel} : ${c.why}`);
    fail(1, "Les renommer ou les retirer, ou relancer avec --force pour les remplacer.");
  }
  const write = writer(options);
  for (const rel of [...toCopy, ...conflicts.map((c) => c.rel)]) write.copy(template.from, target, rel, "ajouté");
  shared(template, options, null, write);
  const installed = template.core.map((rel) => [rel, fingerprint(path.join(template.from, rel))]);
  writeLock(template, options, Object.fromEntries(installed), write);
  say(`Harnais installé dans ${target} :`);
  report(write, [], options);
  say(`
À faire maintenant, dans le projet :
  1. Adapter harness.config.mjs (dossiers, suites de tests, mesures), CLAUDE.md et docs/standards.md.
  2. node scripts/quality/ratchet.mjs --init      plancher du cliquet
  3. node scripts/check.mjs                        doit être vert
  4. Committer, puis écrire un premier ticket avec la skill decoupage (docs/travail/README.md).`);
}

function update(template, options) {
  const { target } = options;
  const lock = readLock(target);
  if (!lock) fail(1, `Aucun ${LOCK} dans ${target} : le harnais n'y a pas été installé par ce script (lancer sans --update).`);
  const write = writer(options);
  const conflicts = [];
  const next = {};
  for (const rel of template.core) {
    const ours = fingerprint(path.join(template.from, rel));
    const theirs = fingerprint(path.join(target, rel));
    const installed = lock.files[rel];
    if (theirs === ours) next[rel] = ours;
    else if (installed === undefined && theirs !== null && !options.force) {
      conflicts.push({ rel, why: "nouveau dans le modèle, mais existe déjà dans le projet" });
    }
    else if (installed !== undefined && theirs === null && !options.force) {
      conflicts.push({ rel, why: "supprimé dans le projet" });
      next[rel] = installed;
    } else if (installed !== undefined && theirs !== installed && !options.force) {
      conflicts.push({ rel, why: "modifié dans le projet depuis l'installation" });
      next[rel] = installed;
    } else {
      write.copy(template.from, target, rel, theirs === null ? "ajouté" : "mis à jour");
      next[rel] = ours;
    }
  }
  for (const [rel, installed] of Object.entries(lock.files)) {
    if (template.core.includes(rel)) continue;
    const theirs = fingerprint(path.join(target, rel));
    if (theirs === null) continue;
    if (theirs === installed || options.force) write.remove(target, rel);
    else {
      conflicts.push({ rel, why: "retiré du modèle, mais modifié dans le projet" });
      next[rel] = installed;
    }
  }
  shared(template, options, lock, write);
  writeLock(template, options, next, write, lock);
  const from = lock.commit ? ` (installé depuis ${lock.version || "?"} ${lock.commit})` : "";
  say(`Mise à jour du harnais dans ${target}${from} :`);
  report(write, conflicts, options);
}

/** État d'un fichier du noyau entre le modèle, le projet et le verrou. */
function state(ours, theirs, installed, locked) {
  if (ours === theirs) return "identique";
  if (!locked) return ours === null ? "absent du modèle" : theirs === null ? "absent du projet" : "différent";
  if (installed === undefined) return theirs === null ? "nouveau dans le modèle" : "nouveau dans le modèle, déjà présent dans le projet";
  if (theirs === null) return "supprimé dans le projet";
  if (ours === null) return theirs === installed ? "retiré du modèle" : "retiré du modèle, modifié dans le projet";
  if (theirs === installed) return "modifié dans le modèle";
  if (ours === installed) return "modifié dans le projet";
  return "modifié des deux côtés";
}

const ADVICE = {
  "modifié dans le modèle": "--update l'apporte au projet",
  "nouveau dans le modèle": "--update l'apporte au projet",
  "retiré du modèle": "--update le retire du projet",
  "modifié dans le projet": "--pull le reprend dans le modèle",
  "modifié des deux côtés": "à fusionner à la main",
};

function compare(template, options) {
  const { target } = options;
  const lock = readLock(target);
  const paths = [...new Set([...template.core, ...Object.keys(lock?.files || {})])].sort();
  const groups = new Map();
  for (const rel of paths) {
    const ours = template.core.includes(rel) ? fingerprint(path.join(template.from, rel)) : null;
    const status = state(ours, fingerprint(path.join(target, rel)), lock?.files[rel], Boolean(lock));
    groups.set(status, [...(groups.get(status) || []), rel]);
  }
  const now = templateVersion(template.from);
  if (!lock) say(`Pas de verrou dans ${target} : comparaison directe des fichiers.`);
  else say(`Installé : ${lock.version || "?"} ${lock.commit || ""} le ${lock.date}. Modèle : ${now.version || "?"} ${now.commit || ""}.`);
  for (const [status, files] of groups) {
    if (status === "identique") continue;
    say(`\n${status} (${files.length})${ADVICE[status] ? ` — ${ADVICE[status]}` : ""}`);
    for (const rel of files) say(`  ${rel}`);
  }
  say(`\n${(groups.get("identique") || []).length} fichier(s) du noyau identique(s).`);
  if (!options.diff) return;
  for (const [status, files] of groups) {
    if (status === "identique") continue;
    for (const rel of files) {
      const a = path.join(template.from, rel);
      const b = path.join(target, rel);
      const side = (file) => (fs.existsSync(file) ? file : "/dev/null");
      spawnSync("git", ["--no-pager", "diff", "--no-index", "--", side(a), side(b)], { stdio: "inherit" });
    }
  }
}

function pull(template, options) {
  const { target, files } = options;
  if (!files.length) fail(2, "Préciser les fichiers à reprendre : node install.mjs <projet> --pull scripts/loop/run.mjs …");
  const write = writer(options);
  for (const file of files) {
    const rel = toPosix(path.normalize(file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) fail(2, `${file} : chemin relatif au projet attendu.`);
    if (NEVER_PULLED.includes(rel)) fail(2, `${rel} est propre au projet : il ne remonte pas dans le modèle.`);
    if (!template.isCoreFile(rel)) fail(2, `${rel} ne fait pas partie du noyau du harnais (scripts/loop/harness-files.mjs).`);
    if (!fs.existsSync(path.join(target, rel))) fail(2, `${rel} n'existe pas dans ${target}.`);
    write.copy(target, template.from, rel, "repris dans le modèle :");
  }
  report(write, [], options);
  say("\nLancer les tests du modèle (npm test), relire le diff (git diff), puis committer dans evolutive-harness.");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!fs.existsSync(options.target) || !fs.statSync(options.target).isDirectory()) fail(2, `Projet introuvable : ${options.target}`);
  if (options.mode === "install" || options.mode === "update") requireGitRoot(options.target);
  const template = await readTemplate(options.from);
  ({ install, update, compare, pull })[options.mode](template, options);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
