// Lecture et sélection des tickets de docs/travail/tickets/. Aucun effet de bord hors `list`, qui lit le disque.
import fs from "node:fs";
import path from "node:path";
import { LEVELS } from "./models.mjs";

export const TICKETS_DIR = "docs/travail/tickets";
export const STATUSES = ["a-faire", "en-cours", "termine", "bloque"];
const JOURNAL = "\n## Journal";

/** En-tête « clé: valeur » entre deux lignes « --- ». Volontairement pas du YAML complet. */
export function parse(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const at = line.indexOf(":");
      if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return { meta, body: match ? text.slice(match[0].length) : text };
}

/** Ce que le traitement n'a pas le droit de changer : tout ce qui précède le journal, statut mis à part. */
export function spec(text) {
  const at = text.indexOf(JOURNAL);
  return (at < 0 ? text : text.slice(0, at)).replace(/^statut:.*$/m, "statut:");
}

export function setStatus(text, status) {
  if (!STATUSES.includes(status)) throw new Error(`Statut inconnu : ${status}`);
  if (!/^statut:.*$/m.test(text)) throw new Error("Le ticket n'a pas de champ « statut ».");
  return text.replace(/^statut:.*$/m, `statut: ${status}`);
}

const yes = (value) => value === "oui";

const ASSUMPTIONS = /^## Hypothèses bloquantes[ \t]*$/m;
const ASKS_OWNER = "Décision attendue du propriétaire";
// Une demande sans question reste une demande : une valeur vide ferait passer le ticket pour tranché.
const UNWRITTEN_QUESTION = "(question non écrite dans le ticket)";

/** Question que le ticket pose encore au propriétaire, ou "" : seul le début de la section « Hypothèses bloquantes » compte. */
function pendingDecision(body) {
  const title = ASSUMPTIONS.exec(body);
  if (!title) return "";
  const rest = body.slice(title.index + title[0].length);
  const end = rest.search(/^## /m);
  const section = (end < 0 ? rest : rest.slice(0, end)).trim();
  if (!section.startsWith(ASKS_OWNER)) return "";
  return section.slice(ASKS_OWNER.length).replace(/^\s*:/, "").replace(/\s+/g, " ").trim() || UNWRITTEN_QUESTION;
}

export function describe(file, text) {
  const { meta, body } = parse(text);
  return {
    file,
    id: meta.id || "",
    titre: meta.titre || "",
    statut: meta.statut || "",
    bloquePar: (meta.bloque_par || "").split(",").map((s) => s.trim()).filter(Boolean),
    adr: yes(meta.adr),
    installe: yes(meta.installe),
    harnais: yes(meta.harnais),
    supprimeTests: yes(meta.supprime_tests),
    niveau: meta.niveau || "",
    decisionAttendue: pendingDecision(body),
  };
}

/** Tickets numérotés (NNN-slug.md), dans l'ordre de leur numéro. Le gabarit et les autres fichiers sont ignorés. */
export function list(root) {
  const dir = path.join(root, TICKETS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{3}-.+\.md$/.test(name))
    .sort()
    .map((name) => describe(`${TICKETS_DIR}/${name}`, fs.readFileSync(path.join(dir, name), "utf8")));
}

/** Problèmes de forme qui empêchent de faire confiance à la file de tickets. */
export function validate(tickets, levels = LEVELS) {
  const problems = [];
  const ids = new Set();
  for (const t of tickets) {
    if (!/^T\d{3}$/.test(t.id)) problems.push(`${t.file} : identifiant « ${t.id} » invalide (attendu : T suivi de trois chiffres).`);
    if (ids.has(t.id)) problems.push(`${t.file} : identifiant ${t.id} déjà utilisé.`);
    ids.add(t.id);
    if (!t.titre) problems.push(`${t.file} : titre manquant.`);
    if (!STATUSES.includes(t.statut)) problems.push(`${t.file} : statut « ${t.statut} » inconnu.`);
    if (t.niveau && !levels[t.niveau]) problems.push(`${t.file} : niveau « ${t.niveau} » inconnu (${Object.keys(levels).join(", ")}).`);
  }
  for (const t of tickets) for (const b of t.bloquePar) if (!ids.has(b)) problems.push(`${t.file} : bloqué par ${b}, qui n'existe pas.`);
  return problems;
}

const waitsForOwner = (t) => t.statut === "a-faire" && Boolean(t.decisionAttendue);

/** Identifiants des tickets à faire qui attendent une décision du propriétaire : la boucle ne les lance pas. */
export function awaitingDecision(tickets) {
  return tickets.filter(waitsForOwner).map((t) => t.id);
}

/** Pourquoi aucun ticket n'est prêt. Les tickets qui attendent une décision sont nommés : c'est au propriétaire d'agir. */
function nothingReady(tickets) {
  const todo = tickets.filter((t) => t.statut === "a-faire");
  if (!todo.length) return "Plus aucun ticket à faire.";
  const asking = awaitingDecision(tickets);
  if (!asking.length) return `${todo.length} ticket(s) à faire, tous bloqués par un ticket non terminé.`;
  return (
    `${todo.length} ticket(s) à faire, aucun n'est prêt. Ces tickets attendent une décision du propriétaire : ${asking.join(", ")}.` +
    " La décision s'écrit à la place de la question, au début de leur section « Hypothèses bloquantes »."
  );
}

/**
 * Prochain ticket à traiter : le premier « a-faire » dont tous les bloqueurs sont terminés et qui n'attend
 * aucune décision. Un ticket « en-cours » ou « bloque » arrête la file : il attend une décision humaine.
 */
export function next(tickets, wanted = null) {
  const stuck = tickets.find((t) => t.statut === "en-cours" || t.statut === "bloque");
  if (stuck) return { reason: `${stuck.id} est « ${stuck.statut} » : à reprendre ou à trancher avant de continuer.` };
  const done = new Set(tickets.filter((t) => t.statut === "termine").map((t) => t.id));
  const ready = (t) => t.statut === "a-faire" && !t.decisionAttendue && t.bloquePar.every((b) => done.has(b));
  if (wanted) {
    const ticket = tickets.find((t) => t.id === wanted);
    if (!ticket) return { reason: `${wanted} n'existe pas.` };
    if (waitsForOwner(ticket)) return { reason: `${wanted} attend une décision du propriétaire : ${ticket.decisionAttendue}` };
    if (!ready(ticket)) return { reason: `${wanted} n'est pas prêt (statut « ${ticket.statut} », bloqué par ${ticket.bloquePar.join(", ") || "rien"}).` };
    return { ticket };
  }
  const ticket = tickets.find(ready);
  return ticket ? { ticket } : { reason: nothingReady(tickets) };
}
