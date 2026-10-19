// Le manifeste est une trace ; seule son empreinte transmise par IPC autorise la reprise de ce travail.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readUntrackedBefore, statusEntries, ticketDir } from "./reviewed-state.mjs";
import { describe, spec } from "./tickets.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const refuse = (reason) => {
  throw Object.assign(new Error(`Relève après quota refusée : ${reason}. Le travail est conservé.`), { code: "QUOTA_HANDOFF_REFUSED" });
};

function git(root, args, allowed = [0]) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
  });
  if (!allowed.includes(result.status)) refuse(`lecture Git impossible (${args[0]})`);
  return result.stdout;
}

function fingerprint(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { deleted: true };
  if (stat.isDirectory()) refuse("un dépôt imbriqué ne peut pas être transmis comme un fichier");
  const content = stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file);
  return { mode: stat.mode, hash: hash(content) };
}

export function fingerprintUntracked(root, paths) {
  return Object.fromEntries([...paths].sort().map(file => [file, fingerprint(path.join(root, file))]));
}

export function preexistingChange(root, paths, expected) {
  const untracked = new Set(statusEntries(root).filter(entry => entry.status === "??").flatMap(entry => entry.paths));
  if (paths.some(file => !untracked.has(file)) || !same(fingerprintUntracked(root, paths), expected)) {
    return "Les fichiers non suivis préexistants ont changé de contenu ou de statut Git.";
  }
  return null;
}

export function reviewFingerprint(root, ticket) {
  const file = path.join(ticketDir(root, ticket.id), "relectures.jsonl");
  return hash(fs.existsSync(file) ? fs.readFileSync(file) : "");
}

function snapshot(root, ticket, untrackedBefore) {
  const entries = statusEntries(root);
  const files = [...new Set(entries.flatMap(entry => entry.paths))];
  const diffArgs = ["--binary", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const parts = [git(root, ["diff", ...diffArgs, "HEAD", "--"])];
  for (const entry of entries) {
    if (entry.status !== "??") continue;
    const file = entry.paths[0];
    if (!untrackedBefore.includes(file)) parts.push(git(root, ["diff", ...diffArgs, "--no-index", "--", "/dev/null", file], [0, 1]));
  }
  const text = fs.readFileSync(path.join(root, ticket.file), "utf8");
  const diff = parts.join("");
  const state = {
    repository: fs.realpathSync(root), branch: git(root, ["branch", "--show-current"]).trim(),
    head: git(root, ["rev-parse", "HEAD"]).trim(), ticket: describe(ticket.file, text), specification: spec(text),
    entries, files: fingerprintUntracked(root, files), preexisting: fingerprintUntracked(root, untrackedBefore),
    index: hash(git(root, ["diff", ...diffArgs, "--cached", "--"])), diff: hash(diff), review: reviewFingerprint(root, ticket),
  };
  return { state, diff };
}

function validateExpected(root, state, expected) {
  if (state.repository !== fs.realpathSync(root)) refuse("dépôt changé");
  if (state.head !== expected.head || state.branch !== expected.branch) refuse("HEAD ou branche changé");
  if (state.ticket.id !== expected.ticket.id || state.ticket.file !== expected.ticket.file) refuse("ticket changé");
  if (state.ticket.statut !== "a-faire" || state.specification !== expected.specification) refuse("statut ou spécification du ticket changé");
  if (!same(state.preexisting, expected.preexisting)) refuse("fichiers non suivis préexistants changés");
  const changed = preexistingChange(root, expected.untrackedBefore, expected.preexisting);
  if (changed) refuse(changed);
  const before = readUntrackedBefore(ticketDir(root, expected.ticket.id));
  if (before.missing || before.problem || !same(before.paths, expected.untrackedBefore)) refuse("liste des non-suivis initiaux perdue ou changée");
}

function paths(root, ticket, token) {
  if (!/^T\d{3}$/.test(ticket?.id) || !/^[0-9a-f-]{36}$/.test(token ?? "")) refuse("état de relève incomplet");
  const base = path.join(ticketDir(root, ticket.id), `releve-quota-${token}`);
  return { manifest: `${base}.json`, diff: `${base}.diff`, consumed: `${base}.consumed` };
}

export function captureQuotaHandoff(root, expected) {
  const captured = snapshot(root, expected.ticket, expected.untrackedBefore);
  validateExpected(root, captured.state, expected);
  const token = randomUUID();
  const files = paths(root, expected.ticket, token);
  const manifest = JSON.stringify(captured.state, null, 2) + "\n";
  fs.writeFileSync(files.manifest, manifest, { flag: "wx" });
  fs.writeFileSync(files.diff, captured.diff, { flag: "wx" });
  return { token, manifestHash: hash(manifest) };
}

/** Le marqueur exclusif vient après toutes les validations ; ni le diff ni l'index réel ne sont réécrits. */
export function consumeQuotaHandoff(root, handoff, expected) {
  const files = paths(root, expected.ticket, handoff?.token);
  if (fs.existsSync(files.consumed)) refuse("état de relève déjà consommé");
  let recorded;
  try {
    const manifest = fs.readFileSync(files.manifest, "utf8");
    if (hash(manifest) !== handoff.manifestHash) refuse("empreinte du manifeste changée");
    recorded = JSON.parse(manifest);
    if (hash(fs.readFileSync(files.diff)) !== recorded.diff) refuse("empreinte du diff transmis changée");
  } catch (error) {
    if (error.code === "QUOTA_HANDOFF_REFUSED") throw error;
    refuse("état de relève absent ou illisible");
  }
  const current = snapshot(root, expected.ticket, expected.untrackedBefore);
  validateExpected(root, current.state, expected);
  if (!same(recorded, current.state)) refuse("état du travail changé depuis la capture");
  fs.writeFileSync(files.consumed, handoff.manifestHash + "\n", { flag: "wx" });
  return { diff: path.relative(root, files.diff), manifest: path.relative(root, files.manifest), review: recorded.review };
}
