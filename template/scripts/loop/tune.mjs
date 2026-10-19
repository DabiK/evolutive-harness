// Harmonisation des consignes du harnais : tous les N tickets intégrés, la boucle reprend les problèmes qui reviennent
// dans les rétrospectives et lance une session qui corrige les skills et les agents. Le code choisit ce qui est traité ;
// la session ne touche jamais aux contrôles ni à ses arbitres, et la boucle revérifie tout avant de committer.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closedLine, INSTRUCTIONS_SCOPE, inScope, scopeDirs } from "./harness-scopes.mjs";
import { displayName, modelSettings } from "./models.mjs";
import { decide, pendingObservations } from "./retro.mjs";
import { lastReviewReport, statusEntries, ticketDir, unacceptedReview, unreviewedChange, untrackedPaths, writeUntrackedBefore } from "./reviewed-state.mjs";

// Un sujet est retenu s'il revient sur au moins MIN_TICKETS tickets distincts, ou si l'une de ses observations a l'impact
// STRONG_IMPACT. MAX_SUBJECTS sujets au plus par harmonisation : une session courte, un commit relisible.
const MIN_TICKETS = 2;
const STRONG_IMPACT = "fort";
const MAX_SUBJECTS = 3;
// Les seules cibles qu'une harmonisation peut corriger. Les autres (hook, boucle, controle, ticket, autre) restent au
// propriétaire : les retenir occuperait une place pour une observation que la session ne pourrait que différer.
const TUNABLE_TARGETS = new Set(["skill", "agent"]);
const OBSERVATIONS_FILE = "observations.json";
// Écrit par tout refus : l'harmonisation suivante y lit pourquoi la précédente a échoué.
const REFUSAL_FILE = "refus.txt";
// Sous-dossier du dossier d'état où un refus range les fichiers nouveaux de la session, sous leur chemin relatif.
const SET_ASIDE_DIR = "mis-de-cote";
const TUNE_ID = /^H(\d+)$/;
const TUNE_ID_DIGITS = 3;
const MAX_OUTPUT = 256 * 1024 * 1024;
const MAX_EVENT_TEXT = 2000;
// Code de sortie de la boucle quand une harmonisation refusée n'a pas pu être défaite : distinct de 0 à 3 (run.mjs).
const DIRTY_TREE_EXIT = 4;

/**
 * Regroupe par sujet les problèmes en attente qu'une harmonisation peut corriger (TUNABLE_TARGETS), dans l'ordre de leur
 * première apparition dans le journal. Le filtre passe avant le regroupement : un sujet ne compte que ces observations-là.
 */
function pendingProblemsBySubject(observations) {
  const subjects = new Map();
  for (const o of observations) {
    if (o.statut !== "propose" || o.type !== "probleme" || !TUNABLE_TARGETS.has(o.cible)) continue;
    const sujet = String(o.sujet ?? "").trim();
    if (!subjects.has(sujet)) subjects.set(sujet, { sujet, order: subjects.size, tickets: new Set(), strong: false, observations: [] });
    const subject = subjects.get(sujet);
    subject.tickets.add(o.ticket);
    subject.strong ||= o.impact === STRONG_IMPACT;
    subject.observations.push(o);
  }
  return [...subjects.values()];
}

/**
 * Sujets à harmoniser, choisis par le code et non par un modèle : les problèmes en attente qui reviennent sur
 * MIN_TICKETS tickets distincts ou qui ont une observation d'impact fort. Les plus fréquents d'abord, à égalité le
 * premier apparu ; MAX_SUBJECTS au plus. Un sujet retenu apporte toutes ses observations de problème en attente dont la
 * cible est une skill ou un agent.
 */
export function selectSubjects(observations) {
  return pendingProblemsBySubject(observations)
    .filter((s) => s.tickets.size >= MIN_TICKETS || s.strong)
    .sort((a, b) => b.tickets.size - a.tickets.size || a.order - b.order)
    .slice(0, MAX_SUBJECTS)
    .map(({ sujet, tickets, observations: chosen }) => ({ sujet, tickets: [...tickets], observations: chosen }));
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT });
  return { code: result.status ?? 1, out: (result.stdout || "") + (result.stderr || "") };
}

const tuneId = (number) => `H${String(number).padStart(TUNE_ID_DIGITS, "0")}`;
const stateFile = (id, name) => path.posix.join(".harness-state", "tickets", id, name);

/** Identifiant de la prochaine harmonisation : un de plus que la plus haute déjà lancée, pour ne jamais en réutiliser un. */
function nextTuneId(root) {
  const dir = path.join(root, ".harness-state", "tickets");
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const used = names.map((name) => TUNE_ID.exec(name)).filter(Boolean).map((match) => Number(match[1]));
  return tuneId(Math.max(0, ...used) + 1);
}

/**
 * Ce que laisse l'harmonisation précédente, celle au numéro juste inférieur, si elle a été refusée : la raison du refus
 * et le dernier rapport de son relecteur, s'il y en a un. Chemins relatifs à la racine ; null après une intégration ou
 * pour la première. Seul un refus écrit REFUSAL_FILE, y compris celui que la boucle n'a pas pu défaire.
 */
function previousRefusal(root, id) {
  const previous = tuneId(Number(TUNE_ID.exec(id)[1]) - 1);
  if (!fs.existsSync(path.join(ticketDir(root, previous), REFUSAL_FILE))) return null;
  const report = lastReviewReport(ticketDir(root, previous));
  return { id: previous, refusal: stateFile(previous, REFUSAL_FILE), report: report && stateFile(previous, report) };
}

/**
 * Le palier du relecteur d'un ticket standard (Opus avec l'échelle par défaut), relecteur compris : `--model` et `--effort`
 * ne valent que pour les tickets.
 */
function tunePlan(settings) {
  const palier = Math.min(settings.levels.standard.reviewFloor, settings.ladder.length - 1);
  const rung = settings.ladder[palier];
  return { modele: rung.model, effort: rung.effort, palier, relecteur: rung.alias };
}

/** Crée le dossier d'état de l'harmonisation : observations retenues, et fichiers non suivis d'avant la session. */
function prepare(root, subjects, settings) {
  const id = nextTuneId(root);
  const dir = ticketDir(root, id);
  const file = stateFile(id, OBSERVATIONS_FILE);
  const observations = subjects.flatMap((s) => s.observations);
  // Lus par `git status -z`, comme l'état relu : la remise à HEAD et la relecture partent de la même liste.
  const before = new Set(untrackedPaths(root));
  writeUntrackedBefore(dir, before);
  fs.writeFileSync(path.join(root, file), JSON.stringify(observations, null, 2) + "\n");
  return { id, dir, file, observations, before, step: tunePlan(settings), previous: previousRefusal(root, id) };
}

/** Phrase de la consigne qui nomme ce qu'a laissé l'harmonisation précédente refusée ; vide sinon. */
function resumeAfterRefusal(previous) {
  if (!previous) return "";
  const report = previous.report ? `, puis le dernier rapport de son relecteur, ${previous.report}` : "";
  return ` L'harmonisation précédente (${previous.id}) a été refusée : lis d'abord la raison du refus, ${previous.refusal}${report}.`;
}

function tunePrompt({ id, file, previous }) {
  return (
    `Harmonise les consignes du harnais (${id}) en suivant la skill « harmonisation » : lis d'abord` +
    ` .claude/skills/harmonisation/SKILL.md. Les observations retenues par la boucle sont dans ${file}.` +
    resumeAfterRefusal(previous) +
    ` Avant de terminer, écris ton verdict dans .harness-state/tickets/${id}/verdict.json.` +
    " Tu ne committes pas et tu ne pousses pas : la boucle le fait après ses propres contrôles."
  );
}

/** Variables propres à la session d'harmonisation : le harnais ouvert, mais sur les seules consignes. */
const tuneEnv = ({ file }) => ({
  HARNESS_TICKET_FILE: file,
  HARNESS_TUNE: "1",
  HARNESS_EDIT: "1",
  HARNESS_EDIT_SCOPE: INSTRUCTIONS_SCOPE,
  HARNESS_ALLOW_INSTALL: "0",
});

function readVerdict(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
  } catch (error) {
    // Pas de verdict lisible : la session s'est arrêtée sans conclure, ce qui vaut un refus.
    return null;
  }
}

/** Les observations que la session déclare différées, avec leur raison. */
function deferredOf(verdict) {
  const list = Array.isArray(verdict?.differees) ? verdict.differees : [];
  return list.filter((d) => typeof d?.id === "string");
}

/** Les observations traitées : celles que le verdict déclare, parmi celles que la boucle a retenues et hors différées. */
function handledOf(verdict, run) {
  const selected = new Set(run.observations.map((o) => o.id));
  const deferred = new Set(deferredOf(verdict).map((d) => d.id));
  const declared = Array.isArray(verdict.observations) ? verdict.observations : [];
  return [...new Set(declared)].filter((id) => selected.has(id) && !deferred.has(id));
}

/**
 * Fichiers changés depuis le début de la session : suivis modifiés (index compris), et nouveaux absents de la liste
 * d'avant (`paths`). `problem` si Git ne peut pas lire l'état de l'arbre : on ne conclut jamais « rien n'a changé » sans lui.
 */
function changedSince(root, before) {
  const status = git(root, ["status", "--porcelain"]);
  if (status.code !== 0) return { problem: `git status a échoué : ${status.out.trim()}` };
  const paths = statusEntries(root)
    .filter((e) => e.status !== "??" || !before.has(e.paths[0]))
    .flatMap((e) => e.paths);
  return { paths };
}

/**
 * Raison de refuser l'harmonisation, ou null. Les contrôles se suivent dans cet ordre : le périmètre passe avant
 * `scripts/check.mjs`, pour qu'un contrôle modifié par la session ne soit jamais exécuté.
 */
function refusal(root, run, session, verdict, changed) {
  if (!verdict) return `La session d'harmonisation s'est terminée sans verdict (code de sortie ${session.code}).`;
  if (verdict.statut !== "TERMINÉ") return `La session d'harmonisation s'est déclarée ${verdict.statut ?? "sans statut"} : ${verdict.resume ?? ""}`;
  const outside = changed.filter((p) => !inScope(INSTRUCTIONS_SCOPE, p));
  if (outside.length) {
    const first = `Le diff sort des consignes (${scopeDirs(INSTRUCTIONS_SCOPE).join(", ")}) : ${outside.join(", ")}`;
    return [first, closedLine(INSTRUCTIONS_SCOPE)].filter(Boolean).join("\n");
  }
  const reviewed = { id: run.id, file: run.file };
  const review = unreviewedChange(root, reviewed) || unacceptedReview(root, reviewed);
  if (review) return review;
  const check = spawnSync(process.execPath, ["scripts/check.mjs"], { cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT });
  if (check.status !== 0) return "Le contrôle qualité complet est rouge :\n" + (check.stdout || "") + (check.stderr || "");
  return null;
}

/**
 * Met de côté les fichiers nouveaux de la session, sous `<dossier d'état>/mis-de-cote/<leur chemin>`, hors Git. La boucle
 * ne sait pas qui les a créés pendant la session : les déplacer nettoie l'arbre sans rien perdre. Renvoie les chemins
 * déplacés (`moved`) et les erreurs de déplacement (`errors`).
 */
function setAsideAdded(root, run) {
  const moved = [];
  const errors = [];
  const added = statusEntries(root).filter((e) => e.status === "??" && !run.before.has(e.paths[0]));
  for (const p of added.flatMap((e) => e.paths)) {
    const target = path.join(run.dir, SET_ASIDE_DIR, p);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(root, p), target);
      moved.push(p);
    } catch (error) {
      // Droits, fichier occupé : la vérification qui suit le retrouvera ; l'erreur dit pourquoi.
      errors.push(`mise de côté de ${p} : ${error.message}`);
    }
  }
  return { moved, errors };
}

/**
 * Défait la session : désindexe, remet les fichiers suivis dans leur état de HEAD, met de côté les nouveaux fichiers, puis
 * vérifie. Renvoie les fichiers mis de côté (`setAside`), les commandes en échec (`errors`) et les fichiers de la session
 * encore là (`left`) ; l'arbre est revenu à son état d'avant quand ces deux derniers sont vides.
 */
function restore(root, run) {
  const errors = [];
  const step = (label, args) => {
    const result = git(root, args);
    if (result.code !== 0) errors.push(`${label} a échoué : ${result.out.trim()}`);
  };
  step("git reset", ["reset", "-q"]);
  const tracked = statusEntries(root).filter((e) => e.status !== "??").flatMap((e) => e.paths);
  if (tracked.length) step("git checkout HEAD", ["--literal-pathspecs", "checkout", "HEAD", "--", ...tracked]);
  const aside = setAsideAdded(root, run);
  errors.push(...aside.errors);
  const after = changedSince(root, run.before);
  if (after.problem) errors.push(after.problem);
  return { setAside: aside.moved, errors, left: after.paths ?? [] };
}

/** Dit ce qui a été mis de côté, et où : le propriétaire y récupère à la main ce qui ne venait pas de la session. */
function saySetAside(root, run, moved, io) {
  if (!moved.length) return;
  const dir = path.relative(root, path.join(run.dir, SET_ASIDE_DIR)).split(path.sep).join("/");
  io.say(`Fichiers nouveaux de la session mis de côté dans ${dir}/ : ${moved.join(", ")}. À récupérer à la main s'il le faut.`);
}

/** Remise à HEAD incomplète : la boucle s'arrête plutôt que de lancer un ticket sur un arbre que la session a laissé sale. */
function stopOnDirtyTree(root, run, reason, { setAside, errors, left }, io) {
  const refusal = path.join(run.dir, REFUSAL_FILE);
  const details = ["", "Remise à HEAD incomplète :", ...errors, ...left.map((p) => `reste : ${p}`)];
  fs.writeFileSync(refusal, [reason, ...details].join("\n") + "\n");
  const cut = (text) => text.slice(0, MAX_EVENT_TEXT);
  const stopped = { id: run.id, raison: cut(reason), reste: left, erreurs: errors.map(cut) };
  io.event("harmonisation-non-defaite", setAside.length ? { ...stopped, mis_de_cote: setAside } : stopped);
  io.say(`Harmonisation ${run.id} refusée, et sa remise à HEAD est incomplète : la boucle s'arrête, aucun ticket n'est lancé.`);
  io.say(`Raison du refus : ${reason.split("\n")[0]}`);
  if (left.length) io.say(`Restent de la session : ${left.join(", ")}`);
  for (const error of errors) io.say(error.split("\n")[0]);
  saySetAside(root, run, setAside, io);
  io.say(`À examiner : git status, un .git/index.lock resté en place, ${path.relative(root, refusal)}. Remettre l'arbre à HEAD, puis relancer.`);
  return DIRTY_TREE_EXIT;
}

/**
 * Refus : la session est défaite, ses fichiers nouveaux mis de côté, ses observations restent en attente, et la file
 * continue ; sinon la boucle s'arrête.
 */
function refuse(root, run, reason, io) {
  const undone = restore(root, run);
  if (undone.errors.length || undone.left.length) return stopOnDirtyTree(root, run, reason, undone, io);
  fs.writeFileSync(path.join(run.dir, REFUSAL_FILE), reason + "\n");
  io.event("harmonisation-refusee", { id: run.id, raison: reason.slice(0, MAX_EVENT_TEXT), mis_de_cote: undone.setAside });
  io.say(`Harmonisation ${run.id} refusée, consignes remises à HEAD ; la file continue. ${reason.split("\n")[0]}`);
  saySetAside(root, run, undone.setAside, io);
  return 0;
}

const firstLine = (text) => String(text ?? "").trim().split("\n")[0].trim();

/** Les problèmes en attente du journal des retours, ou `problem` s'il ne se lit pas. */
function readPending(root) {
  try {
    return { observations: pendingObservations(root) };
  } catch (error) {
    // Ligne tronquée ou écrite à la main : sans journal lisible il n'y a rien à choisir, la file de tickets continue.
    return { problem: error.message };
  }
}

/** Marque les observations traitées du commit ; renvoie la raison d'un échec, ou null. Le commit reste fait. */
function markHandled(root, handled, head, note) {
  if (!handled.length) return null;
  try {
    return decide(root, handled, `harmonisation:${head}`, note).error ?? null;
  } catch (error) {
    // Journal devenu illisible pendant la session (il est hors Git et hors du harnais protégé) : le marquage se fait à la main.
    return error.message;
  }
}

/**
 * Marque `differee:<id de l'harmonisation>` chaque observation retenue que la session a différée, une à une pour que
 * chacune garde sa raison en note : elle attend le propriétaire, et la sélection ne la reprend plus. Un identifiant
 * hors de la sélection n'est jamais marqué. Un échec se dit, avec la commande à lancer à la main.
 */
function markDeferred(root, run, verdict, io) {
  const selected = new Set(run.observations.map((o) => o.id));
  const deferred = new Map(deferredOf(verdict).filter((d) => selected.has(d.id)).map((d) => [d.id, d]));
  const decision = `differee:${run.id}`;
  let failed = null;
  try {
    for (const d of deferred.values()) {
      failed = decide(root, [d.id], decision, typeof d.raison === "string" ? d.raison : "").error ?? null;
      if (failed) break;
    }
  } catch (error) {
    // Journal devenu illisible pendant la session (il est hors Git et hors du harnais protégé) : le marquage se fait à la main.
    failed = error.message;
  }
  if (failed) {
    const by = `node scripts/loop/retro.mjs decider <id> ${decision} <raison>`;
    io.say(`Les observations différées n'ont pas pu être marquées (${failed}) : ${[...deferred.keys()].join(", ")}. À marquer à la main : ${by}`);
  }
}

/** Commit des consignes, marquage des observations traitées et différées, puis push. Renvoie le code de sortie de la boucle. */
function integrateTuning(root, run, { verdict, changed, session }, io) {
  const handled = handledOf(verdict, run);
  const paragraphs = [
    `Tune the harness: ${firstLine(verdict.resume) || "update the skills and agents"}`,
    `Observations: ${handled.join(", ") || "none"}`,
    `Co-Authored-By: ${displayName(run.step.modele)} <noreply@anthropic.com>`,
  ];
  const committed = io.commit(changed, paragraphs);
  if (committed.problem) return refuse(root, run, "Le commit de l'harmonisation a échoué :\n" + committed.problem, io);
  const unmarked = markHandled(root, handled, committed.head, firstLine(verdict.resume));
  if (unmarked) {
    const by = `node scripts/loop/retro.mjs decider <id> harmonisation:${committed.head}`;
    io.say(`Les observations traitées n'ont pas pu être marquées (${unmarked}) : ${handled.join(", ")}. À marquer à la main : ${by}`);
  }
  markDeferred(root, run, verdict, io);
  const integrated = { id: run.id, commit: committed.head, observations: handled, cout_usd: session.report.cout_usd };
  io.event("harmonisation-integree", unmarked ? { ...integrated, marquage_echoue: unmarked } : integrated);
  io.say(`Harmonisation ${run.id} intégrée (${committed.head}) : ${handled.length} observation(s) traitée(s).`);
  return io.push(run.id);
}

/**
 * Étape d'harmonisation, entre deux tickets intégrés. Renvoie le code de sortie de la boucle : 0 pour continuer la
 * file (refus défait et journal des retours illisible compris), 3 si le push est refusé, DIRTY_TREE_EXIT si un refus
 * n'a pas pu être défait. `io` apporte ce que la boucle partage avec les tickets : `say`, `event`, `launch` (une session
 * `claude -p`), `commit` et `push`, ainsi que le nom du projet (`project`) et ses échelles de modèles (`models`).
 */
export async function tuneInstructions(root, io) {
  const pending = readPending(root);
  if (pending.problem) {
    io.event("harmonisation-sautee", { raison: pending.problem.slice(0, MAX_EVENT_TEXT) });
    io.say(`Harmonisation sautée : le journal des retours est illisible (${pending.problem}). La file continue.`);
    return 0;
  }
  const subjects = selectSubjects(pending.observations);
  if (!subjects.length) {
    io.say("Rien à harmoniser : aucun problème en attente sur une skill ou un agent ne revient sur deux tickets ni n'a un impact fort.");
    return 0;
  }
  const run = prepare(root, subjects, io.models ?? modelSettings());
  const ids = run.observations.map((o) => o.id);
  io.event("harmonisation", { id: run.id, sujets: subjects.map((s) => s.sujet), observations: ids });
  io.say(`Harmonisation ${run.id} : ${subjects.map((s) => `« ${s.sujet} »`).join(", ")} (${ids.join(", ")}).`);
  io.say(`Session d'harmonisation, une tentative : ${run.step.modele}, effort ${run.step.effort}, relecteur ${run.step.relecteur}.`);
  const name = `${io.project ?? "projet"} ${run.id} harmonisation`;
  const session = await io.launch({ id: run.id, attempt: 1, dir: run.dir, prompt: tunePrompt(run), name, step: run.step, env: tuneEnv(run) });
  const verdict = readVerdict(run.dir);
  for (const d of deferredOf(verdict)) io.say(`Différée par l'harmonisation : ${d.id} — ${d.raison ?? "sans raison donnée"}`);
  const changed = changedSince(root, run.before);
  if (changed.problem) return refuse(root, run, changed.problem, io);
  if (verdict?.statut === "TERMINÉ" && !changed.paths.length) {
    io.event("harmonisation-sans-changement", { id: run.id });
    io.say(`Harmonisation ${run.id} sans changement : rien à committer ; les différées attendent le propriétaire, les autres restent en attente.`);
    markDeferred(root, run, verdict, io);
    return 0;
  }
  const reason = refusal(root, run, session, verdict, changed.paths);
  if (reason) return refuse(root, run, reason, io);
  return integrateTuning(root, run, { verdict, changed: changed.paths, session }, io);
}
