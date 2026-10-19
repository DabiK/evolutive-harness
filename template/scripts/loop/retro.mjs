#!/usr/bin/env node
// Rétrospective d'un ticket : après l'intégration ou le blocage, une courte session en lecture seule relit ce
// que la boucle a observé et propose des améliorations du harnais. Les propositions s'accumulent dans un
// journal ; le propriétaire les tranche après un lot de tickets. L'harmonisation des consignes (tune.mjs) marque
// `harmonisation:<commit>` celles qu'elle a traitées dans les skills et les agents, et `differee:<H…>` celles qu'elle
// laisse au propriétaire.
//
//   node scripts/loop/retro.mjs liste [--tous]      propositions à trancher (ouvertes ou différées), groupées par cible
//   node scripts/loop/retro.mjs decider <id> accepte|refuse|ticket:T012|harmonisation:<commit>|differee:H001 [note]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Modèle par défaut de la rétrospective ; le projet le remplace par `models.retro` dans harness.config.mjs.
export const RETRO_MODEL = "claude-sonnet-5-5";
const TARGETS = ["skill", "agent", "hook", "boucle", "ticket", "controle", "autre"];
const IMPACTS = ["fort", "moyen", "faible"];
const MAX_OBSERVATIONS = 8;

const SCHEMA = {
  type: "object",
  required: ["observations"],
  properties: {
    observations: {
      type: "array",
      maxItems: MAX_OBSERVATIONS,
      items: {
        type: "object",
        required: ["type", "sujet", "constat", "preuve", "proposition", "cible", "impact"],
        properties: {
          type: { enum: ["bien", "probleme"] },
          sujet: { type: "string" },
          constat: { type: "string" },
          preuve: { type: "string" },
          proposition: { type: "string" },
          cible: { enum: TARGETS },
          impact: { enum: IMPACTS },
        },
      },
    },
  },
};

const journalFile = (root) => path.join(root, ".harness-state", "retours", "observations.jsonl");

function readJournal(root) {
  const file = journalFile(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeJournal(root, entries) {
  fs.mkdirSync(path.dirname(journalFile(root)), { recursive: true });
  fs.writeFileSync(journalFile(root), entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

const usd = (n) => (typeof n === "number" ? `${n.toFixed(2)} $` : "inconnu");

/** Ce que la boucle sait du ticket, en Markdown : la rétrospective part de là et va lire les fichiers cités. */
export function digest(root, ticket, dir, { outcome, reason, history }) {
  const rel = (p) => path.relative(root, p);
  const lines = [`# Rétrospective ${ticket.id} — ${ticket.titre}`, "", `- Ticket : ${ticket.file}`];
  lines.push(`- Issue : ${outcome}${reason ? ` (${reason})` : ""}`);
  lines.push(`- Coût total des sessions : ${usd(history.reduce((sum, h) => sum + (h.report.cout_usd || 0), 0))}`, "");
  for (const { attempt, plan, report, failure } of history) {
    lines.push(`## Tentative ${attempt}`, "");
    const model = `modèle ${plan.modele || "par défaut"}, effort ${plan.effort || "par défaut"}`;
    lines.push(`- Niveau ${plan.niveau}, ${model}, relecteur ${plan.relecteur || "hérité"}`);
    const compactions = Number.isFinite(report.compactions) ? `, ${report.compactions} compaction(s)` : "";
    lines.push(`- ${report.tours ?? "?"} tours, ${report.duree_s ?? "?"} s, ${usd(report.cout_usd)}${compactions}`);
    for (const agent of report.sous_agents || []) {
      lines.push(`- Sous-agent ${agent.role} (${agent.modele}) : ${agent.tokens} tokens, ${agent.outils} outils, ${Math.round(agent.duree_ms / 1000)} s`);
    }
    for (const denial of report.refus || []) lines.push(`- Refus de permission : ${denial}`);
    const stream = report.moteur === "codex" ? "codex" : "session";
    lines.push(`- Flux complet : ${rel(path.join(dir, `${stream}-${attempt}.jsonl`))}`);
    if (failure) lines.push("", "Refus de la boucle :", "", "```", failure.trim(), "```");
    lines.push("");
  }
  for (const name of ["verdict.json", "relectures.jsonl"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) lines.push(`## ${name}`, "", "```", fs.readFileSync(file, "utf8").trim(), "```", "");
  }
  const reviews = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^revue-\d+\.diff$/.test(f)) : [];
  if (reviews.length) lines.push(`Revues enregistrées : ${reviews.map((f) => rel(path.join(dir, f))).join(", ")}`, "");
  return lines.join("\n");
}

function prompt(root, input, project) {
  const journal = path.relative(root, journalFile(root));
  return (
    `Fais la rétrospective d'une session de ticket menée par la boucle de ${project}. Lis ${input} : ce que la boucle a observé.` +
    " Va lire les fichiers qu'il cite quand une preuve te manque (flux de session, refus, revues, journal du ticket)," +
    " ainsi que .claude/skills/ticket/SKILL.md, .claude/agents/ et scripts/loop/ quand ta proposition les vise." +
    " Tu juges le harnais, pas le code du ticket : ce qui a fait perdre des tours, des tokens ou de la justesse," +
    " et ce qui a bien marché et doit être gardé. Chaque observation s'appuie sur une preuve précise (fichier, ligne," +
    " événement, chiffre) ; pas de conseil générique. Une proposition dit quoi changer et où." +
    ` Les propositions déjà ouvertes sont dans ${journal} : si ton constat en répète une, reprends son sujet mot pour mot.` +
    ` ${MAX_OBSERVATIONS} observations au plus, en français.`
  );
}

/** Lance la rétrospective ; renvoie les observations ajoutées au journal, ou `problem`. Ne lève jamais d'exception. */
export function runRetro(root, ticket, dir, run, options = {}) {
  const { bin = "claude", permissionMode = "auto", timeoutMin = 20, model = RETRO_MODEL, project = "ce projet" } = options;
  try {
    const input = path.join(dir, "retro-entree.md");
    fs.writeFileSync(input, digest(root, ticket, dir, run));
    const args = ["-p", prompt(root, path.relative(root, input), project), "--model", model, "--effort", "medium"];
    args.push("--tools", "Read,Grep,Glob", "--permission-mode", permissionMode, "--setting-sources", "user");
    // Sans serveurs MCP ni commandes slash du compte : mesuré, 0,57 $ → 0,02 $ pour un appel vide.
    args.push("--strict-mcp-config", "--disable-slash-commands");
    args.push("--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--no-session-persistence");
    const env = { ...process.env, HARNESS_RETRO: "1", HARNESS_TICKET: ticket.id };
    delete env.HARNESS_LOOP;
    const result = spawnSync(bin, args, { cwd: root, env, encoding: "utf8", timeout: timeoutMin * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) return { problem: `session en échec (code ${result.status}) : ${(result.stderr || result.stdout || "").slice(-500)}` };
    const output = JSON.parse(result.stdout);
    const observations = output.structured_output?.observations;
    if (!Array.isArray(observations)) return { problem: "la session n'a pas rendu d'observations structurées" };
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "retro.json"), JSON.stringify({ at, cout_usd: output.total_cost_usd, observations }, null, 2) + "\n");
    const journal = readJournal(root);
    const first = journal.filter((e) => e.ticket === ticket.id).length + 1;
    const added = observations.map((o, i) => ({ id: `R-${ticket.id}-${first + i}`, ticket: ticket.id, at, statut: "propose", ...o }));
    writeJournal(root, [...journal, ...added]);
    return { added, cost: output.total_cost_usd };
  } catch (error) {
    // Sortie illisible, journal corrompu, disque plein : la rétrospective est un bonus, la boucle continue.
    return { problem: error.message };
  }
}

const ORDER = Object.fromEntries(IMPACTS.map((impact, i) => [impact, i]));

/** Différée par une harmonisation : elle attend une décision du propriétaire, mais la sélection ne la reprend plus. */
const DEFERRED = /^differee:/;

function listCommand(root, all) {
  const entries = all ? readJournal(root) : readJournal(root).filter((e) => e.statut === "propose" || DEFERRED.test(e.statut));
  if (!entries.length) return console.log(all ? "Aucune observation." : "Aucune proposition à trancher.");
  for (const target of TARGETS) {
    const group = entries.filter((e) => e.cible === target).sort((a, b) => ORDER[a.impact] - ORDER[b.impact]);
    if (!group.length) continue;
    console.log(`\n## ${target}`);
    for (const e of group) {
      const decision = e.statut === "propose" ? "" : ` → ${e.statut}${e.note ? ` (${e.note})` : ""}`;
      console.log(`- ${e.id} [${e.type}, ${e.impact}] ${e.sujet}${decision}\n    ${e.constat}\n    Preuve : ${e.preuve}\n    Proposition : ${e.proposition}`);
    }
  }
}

/**
 * Décisions possibles : `harmonisation:<commit>` marque une observation traitée par une harmonisation des consignes,
 * `differee:<H…>` une observation que cette harmonisation a laissée au propriétaire.
 */
const DECISION = /^(accepte|refuse|ticket:T\d+|harmonisation:[0-9a-f]{7,40}|differee:H\d+)$/;
const DECIDE_USAGE = "decider <id> accepte|refuse|ticket:T012|harmonisation:<commit>|differee:H001 [note]";

/** Les observations encore à trancher (`statut: propose`), dans l'ordre du journal. */
export function pendingObservations(root) {
  return readJournal(root).filter((e) => e.statut === "propose");
}

/**
 * Tranche des observations du journal. Renvoie `{ decided }`, ou `{ error }` sans rien écrire :
 * `invalid-decision`, ou `unknown-observation` avec les identifiants absents du journal (`unknown`).
 */
export function decide(root, ids, decision, note = "") {
  if (!DECISION.test(decision || "")) return { error: "invalid-decision" };
  const journal = readJournal(root);
  const unknown = ids.filter((id) => !journal.some((e) => e.id === id));
  if (unknown.length) return { error: "unknown-observation", unknown };
  const at = new Date().toISOString();
  for (const entry of journal.filter((e) => ids.includes(e.id))) Object.assign(entry, { statut: decision, decide_le: at, note: note || undefined });
  writeJournal(root, journal);
  return { decided: ids };
}

function decideCommand(root, [id, decision, ...note]) {
  const result = id ? decide(root, [id], decision, note.join(" ")) : { error: "invalid-decision" };
  if (result.error === "invalid-decision") {
    console.error(`Usage : node scripts/loop/retro.mjs ${DECIDE_USAGE}`);
    process.exit(2);
  }
  if (result.error) {
    console.error(`Observation inconnue : ${id}.`);
    process.exit(2);
  }
  console.log(`${id} : ${decision}.`);
}

function main(argv) {
  const root = process.cwd();
  if (argv[0] === "liste") return listCommand(root, argv.includes("--tous"));
  if (argv[0] === "decider") return decideCommand(root, argv.slice(1));
  console.error(`Usage : node scripts/loop/retro.mjs liste [--tous] | ${DECIDE_USAGE}`);
  process.exit(2);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
