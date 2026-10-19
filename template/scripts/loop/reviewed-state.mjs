#!/usr/bin/env node
// État relu d'un ticket : ce que le dernier relecteur a lu, fichier par fichier. La session l'enregistre
// avant chaque relecture ; la boucle le recalcule après la session et refuse un changement qui en diffère.
//
//   node scripts/loop/reviewed-state.mjs record                 ticket de la session (HARNESS_TICKET)
//   node scripts/loop/reviewed-state.mjs record --ticket T003   hors boucle
//
// Le journal du ticket et les fichiers non suivis présents avant la session n'entrent pas dans l'état.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { list } from "./tickets.mjs";

export const UNTRACKED_BEFORE = "untracked-before.json";
const REVIEWED_STATE = "reviewed-state.json";
const REVIEWS = "relectures.jsonl";
// Le rapport de chaque relecteur, numéroté comme sa ligne dans REVIEWS.
const reviewReport = (rank) => `relecture-${rank}.md`;
const REVIEW_REPORT = /^relecture-(\d+)\.md$/;
const DELETED = "deleted";
const RECORD_COMMAND = "node scripts/loop/reviewed-state.mjs record";

export const ticketDir = (root, id) => path.join(root, ".harness-state", "tickets", id);

function git(root, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
  return { code: result.status ?? 1, stdout: result.stdout || "" };
}

/** Les fichiers non suivis avant la première session, écrits par la boucle ; aucun hors boucle. */
export function writeUntrackedBefore(dir, paths) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, UNTRACKED_BEFORE), JSON.stringify([...paths], null, 2) + "\n");
}

/** Contenu JSON d'un fichier d'état : `missing` s'il n'existe pas, `unreadable` (la cause) s'il ne se lit pas. */
function readStateFile(dir, name, isValid) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return { missing: true };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // Tronqué ou réécrit à la main : l'appelant refuse en nommant le fichier, la boucle ne s'arrête pas sur une exception.
    return { unreadable: `${name} est illisible (${error.message})` };
  }
  return isValid(value) ? { value } : { unreadable: `${name} est illisible (contenu inattendu)` };
}

const isPathList = (value) => Array.isArray(value) && value.every((p) => typeof p === "string");
const isRecordedState = (value) =>
  typeof value?.revue === "string" && typeof value.fichiers === "object" && value.fichiers !== null && !Array.isArray(value.fichiers);

/**
 * Les non suivis d'avant la session ; `missing` distingue une absence permise hors boucle.
 * Une liste illisible rend `problem` et son diagnostic `unreadable` : son exclusion ne peut pas s'appliquer,
 * on refuse plutôt que de montrer au relecteur des fichiers qui ne sont pas du ticket.
 */
export function readUntrackedBefore(dir) {
  const read = readStateFile(dir, UNTRACKED_BEFORE, isPathList);
  if (read.missing) return { paths: [], missing: true };
  if (!read.unreadable) return { paths: read.value || [] };
  const problem =
    `La liste des fichiers non suivis d'avant la session est perdue : ${read.unreadable}.` +
    " La boucle l'écrit au début du ticket ; une session n'y touche pas.";
  return { problem, unreadable: read.unreadable };
}

/** Entrées de `git status -z` : chemins bruts, sans guillemets ni échappement, même hors ASCII. */
export function statusEntries(root) {
  const fields = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout.split("\0");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const status = fields[i].slice(0, 2);
    const paths = [fields[i].slice(3)];
    // Renommage ou copie : le chemin d'origine suit, dans son propre champ.
    if (/[RC]/.test(status)) paths.push(fields[++i]);
    entries.push({ status, paths });
  }
  return entries;
}

/** Fichiers non suivis du dépôt, lus comme l'état relu les lit : la liste d'avant la session s'exclut ainsi telle quelle. */
export function untrackedPaths(root) {
  return statusEntries(root).filter((e) => e.status === "??").flatMap((e) => e.paths);
}

/** Fichiers du changement, séparés en suivis et nouveaux, exclusions appliquées. */
function changedFiles(root, { ticketFile, untrackedBefore }) {
  const excluded = new Set([ticketFile, ...untrackedBefore]);
  const tracked = [];
  const added = [];
  for (const { status, paths } of statusEntries(root)) {
    for (const p of paths) if (!excluded.has(p)) (status === "??" ? added : tracked).push({ status, path: p });
  }
  return { tracked, added };
}

function fingerprint(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return DELETED;
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update("link:" + fs.readlinkSync(file));
  // Un dossier listé par Git est un dépôt imbriqué : son contenu n'est pas celui du changement.
  else if (stat.isDirectory()) hash.update("directory");
  else hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** L'état relu : pour chaque fichier du changement, l'empreinte de son contenu ou « deleted ». */
export function reviewedState(root, { ticketFile, untrackedBefore = [] }) {
  const { tracked, added } = changedFiles(root, { ticketFile, untrackedBefore });
  return Object.fromEntries([...tracked, ...added].map((f) => [f.path, fingerprint(path.join(root, f.path))]));
}

/** Chemins qui diffèrent entre deux états : ajoutés, retirés ou de contenu différent. Triés. */
export function differences(recorded, current) {
  const paths = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...paths].filter((p) => recorded[p] !== current[p]).sort();
}

/** Raison de refuser l'intégration si le changement final n'est pas celui que le dernier relecteur a lu ; null sinon. */
export function unreviewedChange(root, ticket) {
  const dir = ticketDir(root, ticket.id);
  const read = readStateFile(dir, REVIEWED_STATE, isRecordedState);
  if (read.missing) return `Aucune relecture n'est enregistrée : la session lance \`${RECORD_COMMAND}\` avant chaque relecture.`;
  if (read.unreadable) return `Aucune relecture lisible n'est enregistrée : ${read.unreadable}. La session relance \`${RECORD_COMMAND}\` puis fait relire.`;
  const before = readUntrackedBefore(dir);
  if (before.problem) return before.problem;
  const recorded = read.value;
  const changed = differences(recorded.fichiers, reviewedState(root, { ticketFile: ticket.file, untrackedBefore: before.paths }));
  if (!changed.length) return null;
  return (
    `Le changement a été modifié depuis la dernière relecture : ${changed.join(", ")}.` +
    ` Dernière relecture enregistrée : ${recorded.revue}. Toute modification autre que le journal du ticket demande une nouvelle relecture.`
  );
}

const VERDICT_LINE = /^\s*VERDICT\s*:\s*(accepté|à corriger)(?!\p{L})/imu;
const FINDINGS_LINE = /^\s*CONSTATS\s*:.*$/imu;
const FINDINGS_COUNTS = /^\s*CONSTATS\s*:\s*(\d+)\s+bloquants?\s*,\s*(\d+)\s+mineurs?\s*,\s*\d+\s+hors\s+périmètre\s*$/iu;

/**
 * Verdict d'un rapport de relecteur, lu sur ses lignes « VERDICT : … » et « CONSTATS : … » ; « illisible » sans
 * ligne VERDICT. Un relecteur peut se contredire : « accepté » n'est retenu que si la première ligne CONSTATS compte
 * zéro bloquant et zéro mineur. Avec un bloquant ou un mineur compté, le rapport vaut « à corriger » ; sans ligne
 * CONSTATS lisible, « illisible ».
 */
export function reviewVerdict(report) {
  const verdict = VERDICT_LINE.exec(report || "");
  if (!verdict) return "illisible";
  if (verdict[1].toLowerCase() === "à corriger") return "à corriger";
  const counts = FINDINGS_COUNTS.exec(FINDINGS_LINE.exec(report)?.[0] ?? "");
  if (!counts) return "illisible";
  const [, blocking, minor] = counts.map(Number);
  return blocking + minor > 0 ? "à corriger" : "accepté";
}

/** Une correction sans compte entier lisible vaut au moins un constat non corrigé. Seule la première ligne compte. */
export function uncorrectedFindings(report) {
  const line = /^[\t ]*NON CORRIGÉS[\t ]*:[^\r\n]*$/imu.exec(report || "")?.[0];
  const count = /^[\t ]*NON CORRIGÉS[\t ]*:[\t ]*(\d+)[\t ]*$/iu.exec(line || "");
  const value = count ? Number(count[1]) : NaN;
  return Number.isSafeInteger(value) ? value : 1;
}

/**
 * Ajoute au journal des relectures le verdict rendu sur la dernière revue enregistrée, et garde le texte du rapport dans
 * `relecture-<n>.md`, `n` étant le rang de la ligne ajoutée : une harmonisation qui suit un refus lit le dernier.
 */
export function recordReview(root, id, { verdict, modele, report = "" }) {
  const dir = ticketDir(root, id);
  const state = readStateFile(dir, REVIEWED_STATE, isRecordedState);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { at: new Date().toISOString(), revue: state.value?.revue ?? null, verdict, modele: modele ?? null };
  const reviews = path.join(dir, REVIEWS);
  fs.appendFileSync(reviews, JSON.stringify(entry) + "\n");
  const rank = fs.readFileSync(reviews, "utf8").split("\n").filter(Boolean).length;
  fs.writeFileSync(path.join(dir, reviewReport(rank)), report);
  return entry;
}

/** Nom du dernier rapport de relecteur gardé dans un dossier d'état (`relecture-<n>.md` de plus grand rang), ou null. */
export function lastReviewReport(dir) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const ranks = names.map((name) => REVIEW_REPORT.exec(name)).filter(Boolean).map((match) => Number(match[1]));
  return ranks.length ? reviewReport(Math.max(...ranks)) : null;
}

/** Raison de refuser l'intégration si la dernière relecture n'a pas accepté la dernière revue enregistrée ; null sinon. */
export function unacceptedReview(root, ticket) {
  const dir = ticketDir(root, ticket.id);
  const file = path.join(dir, REVIEWS);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  if (!lines.length) return "Aucun verdict de relecteur n'est enregistré : la boucle n'intègre qu'un changement qu'un relecteur a accepté.";
  let last;
  try {
    last = JSON.parse(lines.at(-1));
  } catch (error) {
    // Ligne tronquée ou écrite à la main : on refuse en le disant, sans exception.
    return `La dernière ligne de ${REVIEWS} est illisible (${error.message}).`;
  }
  const state = readStateFile(dir, REVIEWED_STATE, isRecordedState);
  const current = state.value?.revue ?? "aucune";
  if (last.revue !== state.value?.revue) {
    return `Le dernier verdict porte sur ${last.revue ?? "aucune revue"}, pas sur la dernière revue enregistrée (${current}) : la faire relire.`;
  }
  if (last.verdict !== "accepté") {
    return `Le dernier relecteur n'a pas accepté ${last.revue} (verdict : ${last.verdict}). Corriger, enregistrer une nouvelle revue et la faire relire.`;
  }
  return null;
}

/** Le diff relu : fichiers suivis par rapport à HEAD, puis chaque fichier nouveau en entier. */
function reviewDiff(root, { tracked, added }) {
  const parts = [];
  if (tracked.length) parts.push(git(root, ["diff", "HEAD", "--", ...tracked.map((f) => f.path)]).stdout);
  for (const f of added) parts.push(git(root, ["diff", "--no-index", "--", "/dev/null", f.path]).stdout);
  return parts.join("");
}

/** Un index jetable part de HEAD : seuls les fichiers du ticket remplacent cet état de référence. */
function reviewTree(root, dir, { tracked, added }) {
  const head = git(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
  if (head.code !== 0) return { problem: "Impossible de lire les chemins Git de référence (ls-tree)." };
  const inHead = new Set(head.stdout.split("\0"));
  // AD et RD peuvent nommer une cible déjà supprimée, inconnue de l'index temporaire parti de HEAD.
  const paths = [...new Set([...tracked, ...added].map((file) => file.path))]
    .filter((file) => inHead.has(file) || fs.lstatSync(path.join(root, file), { throwIfNoEntry: false }));
  const temp = fs.mkdtempSync(path.join(dir, "index-"));
  const env = { GIT_INDEX_FILE: path.join(temp, "index"), GIT_LITERAL_PATHSPECS: "1" };
  const commands = [["read-tree", "HEAD"]];
  if (paths.length) commands.push(["add", "-A", "-f", "--", ...paths]);
  commands.push(["write-tree"]);
  let tree;
  try {
    for (const args of commands) {
      const result = git(root, args, env);
      if (result.code !== 0) return { problem: `Impossible d'enregistrer l'arbre Git de la relecture (${args[0]}).` };
      tree = result.stdout.trim();
    }
    return { tree };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Un historique perdu ou inutilisable n'empêche pas de reconstruire l'état pour une relecture complète. */
function reviewInterdiff(root, previousTree, currentTree) {
  if (typeof previousTree !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(previousTree)) return undefined;
  if (git(root, ["cat-file", "-e", `${previousTree}^{tree}`]).code !== 0) return undefined;
  const diff = git(root, ["diff", previousTree, currentTree, "--"]);
  return diff.code === 0 ? diff.stdout : undefined;
}

/** Enregistre la relecture suivante du ticket ; renvoie les fichiers écrits, ou `problem` sans rien écrire. */
export function record(root, ticket) {
  const dir = ticketDir(root, ticket.id);
  const before = readUntrackedBefore(dir);
  if (before.problem) return { problem: before.problem };
  fs.mkdirSync(dir, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(dir, `revue-${n}.diff`))) n++;
  const scope = { ticketFile: ticket.file, untrackedBefore: before.paths };
  const files = changedFiles(root, scope);
  const previous = readStateFile(dir, REVIEWED_STATE, isRecordedState);
  const snapshot = reviewTree(root, dir, files);
  if (snapshot.problem) return snapshot;
  const interdiff = n > 1 ? reviewInterdiff(root, previous.value?.arbre, snapshot.tree) : undefined;
  const written = [`revue-${n}.diff`, `revue-${n}.fichiers`, REVIEWED_STATE].map((name) => path.join(dir, name));
  fs.writeFileSync(written[0], reviewDiff(root, files));
  fs.writeFileSync(written[1], [...files.tracked, ...files.added].map((f) => `${f.status} ${f.path}\n`).join(""));
  const state = { revue: `revue-${n}.diff`, fichiers: reviewedState(root, scope), arbre: snapshot.tree };
  fs.writeFileSync(written[2], JSON.stringify(state, null, 2) + "\n");
  if (interdiff !== undefined) {
    const file = path.join(dir, `revue-${n}.interdiff`);
    fs.writeFileSync(file, interdiff);
    written.push(file);
  }
  return { written };
}

/** Le ticket visé : celui de la session, ou celui de `--ticket`, retrouvé dans la file. */
function ticketFromCommand(root, argv) {
  const id = argv.includes("--ticket") ? argv[argv.indexOf("--ticket") + 1] : process.env.HARNESS_TICKET;
  if (!id) return null;
  if (!argv.includes("--ticket") && process.env.HARNESS_TICKET_FILE) return { id, file: process.env.HARNESS_TICKET_FILE };
  return list(root).find((t) => t.id === id) || null;
}

function main(argv) {
  const root = process.cwd();
  if (argv[0] !== "record") {
    console.error(`Usage : ${RECORD_COMMAND} [--ticket <ID>]`);
    process.exit(2);
  }
  const ticket = ticketFromCommand(root, argv);
  if (!ticket) {
    console.error("Ticket inconnu : lancer depuis une session de la boucle, ou préciser --ticket <ID>.");
    process.exit(2);
  }
  const { written, problem } = record(root, ticket);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  for (const file of written) console.log(path.relative(root, file));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
