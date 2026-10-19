// Relecture par Claude du travail d'un moteur externe (Codex, OpenCode) : la boucle enregistre l'état relu, lance un
// processus Claude séparé (`--agent relecteur`) et redemande au moteur, au plus deux fois, de corriger. Le moteur ne
// fournit que sa session de correction ; tout le reste est commun aux moteurs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lastReviewReport, record, recordReview, reviewVerdict, uncorrectedFindings } from "./reviewed-state.mjs";

const MAX_REVIEW_OUTPUT = 64 * 1024 * 1024;
export const MAX_CORRECTIONS = 2;

/** Le verdict écrit par la session ; null s'il est absent ou illisible. */
export function sessionVerdict(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
  } catch (error) {
    // Un arrêt sans verdict lisible ne peut pas déclencher une relecture du changement.
    return null;
  }
}

function reviewRequest(root, ticket, dir, correction) {
  const previousReport = correction ? lastReviewReport(dir) : null;
  const snapshot = record(root, ticket);
  if (snapshot.problem) return { problem: snapshot.problem };
  const files = snapshot.written.slice(0, 2).map((file) => path.relative(root, file));
  let prompt = `Relis le ticket ${ticket.id} (${ticket.file}), ${files.join(" et ")}` +
    ` et, s'il existe, ${path.relative(root, path.join(dir, "ecarts.md"))}.`;
  if (correction) {
    const previous = path.relative(root, path.join(dir, previousReport));
    const interdiffFile = snapshot.written.find((file) => file.endsWith(".interdiff"));
    if (!interdiffFile) {
      const state = path.relative(root, path.join(dir, "reviewed-state.json"));
      return { problem: `Relecture de correction impossible : interdiff absent après reconstruction de ${state}. La tentative est refusée.` };
    }
    const interdiff = path.relative(root, interdiffFile);
    prompt += ` Fais une relecture de correction contre ${previous} et ${interdiff}, selon la section correspondante de tes consignes.`;
  }
  return { prompt };
}

/** Enregistre l'état relu, le fait relire par Claude au modèle `step.relecteur` et garde son verdict. */
export function review(root, ticket, dir, env, step, timeoutMs, correction) {
  const request = reviewRequest(root, ticket, dir, correction);
  if (request.problem) return request;
  const { prompt } = request;
  const args = ["-p", prompt, "--agent", "relecteur", "--model", step.relecteur, "--output-format", "json", "--strict-mcp-config"];
  const reviewEnv = { ...env };
  // Les hooks de ticket exigeraient du relecteur un verdict d'implémentation et remplaceraient son rapport.
  delete reviewEnv.HARNESS_LOOP;
  delete reviewEnv.HARNESS_ENGINE;
  const result = spawnSync(process.env.HARNESS_CLAUDE_BIN || "claude", args, {
    cwd: root, env: reviewEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: MAX_REVIEW_OUTPUT,
  });
  let report;
  let failed = result.status !== 0;
  try {
    const output = JSON.parse(result.stdout);
    report = typeof output.result === "string" ? output.result : "";
    failed ||= Boolean(output.is_error);
    if (failed) report = `Relecteur en échec : ${result.stderr || ""}\n${report}`;
  } catch (error) {
    // Un processus interrompu ou une sortie non JSON ne peut jamais accepter une revue.
    report = `Relecteur illisible : ${result.error?.message || result.stderr || result.stdout || error.message}`;
    failed = true;
  }
  const uncorrected = correction ? uncorrectedFindings(report) : 0;
  let verdict = failed ? "illisible" : reviewVerdict(report);
  if (!failed && uncorrected > 0) verdict = "à corriger";
  recordReview(root, ticket.id, { verdict, modele: step.relecteur, report });
  return { verdict, report, uncorrected };
}

function locations(text) {
  return text.match(/[^\s`]+:\d+/gu) || [];
}

function findingForm(line, section, current) {
  if (/^#{1,2}\s+/u.test(line)) return (/^#{1,2}\s+\d+[.)]\s+/u.test(line) || locations(line).length > 0) && "title";
  if (/^(?:#{3,6}\s+|\*\*(?:\d+[.)]\s+|constat\s+\d+\b))/iu.test(line)) return "title";
  if (/^\d+[.)]\s+/u.test(line)) return (!current || current.form === "numbered") && "numbered";
  const bullet = /^[-*+]\s+(.+)$/u.exec(line)?.[1];
  if (!bullet || (current && current.form !== "bullet")) return false;
  const located = locations(bullet).some(ref => bullet.replace(/^`/u, "").startsWith(ref));
  if (located || /^(?:\(\d+\)\s+|hors\s+périmètre\b)/iu.test(bullet)) return "bullet";
  if (!current && /^\*\*[^*:]+\*\*(?:\s|$)/u.test(bullet)) return "title";
  return section === "reserves" && !current && "bullet";
}

function reviewSection(title) {
  if (/^(?:\d+[.)]\s+|constat\s+\d+\b)/iu.test(title)) return null;
  if (/(?:^|\s)[ée]carts\b/iu.test(title)) return "deviations";
  if (/^réserves(?:\s+hors\s+périmètre|$)/iu.test(title)) return "reserves";
  if (/^(?:suivi|synthèse|critères|régressions|code\s+changé)\b/iu.test(title)) return "other";
  if (/^constats?\s+du\s+rapport\s+précédent\b/iu.test(title)) return "tracking";
  if (/constats?\b/iu.test(title) && !/de\s+la\s+relecture/iu.test(title)) return "findings";
  return null;
}

/** Les champs et paragraphes restent attachés au titre, même si le repère est dans le corps. */
function reviewBlocks(report) {
  const blocks = [];
  let section = "findings";
  let current = null;
  for (const line of report.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(?:VERDICT|CONSTATS|NON CORRIGÉS)\s*:/iu.test(line)) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    const nextSection = heading && reviewSection(heading[1]);
    const title = line.replace(/^(?:#{1,6}|[-*+]|\d+[.)])\s+/u, "");
    const deviation = section !== "other" && /^(?:\*\*)?[ée]carts?\s+acceptés?(?!\p{L})/iu.test(title);
    const form = !nextSection && ["findings", "tracking", "reserves"].includes(section) && findingForm(line, section, current);
    if (deviation || form) {
      current = {
        kind: deviation ? "deviation" : "finding", form, tracking: section === "tracking", listed: /^[-*+]\s/u.test(line), lines: [title],
      };
      blocks.push(current);
    } else if (heading) {
      current = null;
      section = nextSection || "other";
    } else if (current?.kind === "deviation" && current.listed && /^(?:[-*+]|\d+[.)])\s/u.test(line)) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map(({ kind, tracking, lines }) => ({ kind, tracking, text: lines.join("\n").trim() }));
}

function outOfScopeFindings(blocks) {
  const findings = blocks.filter(block => block.kind === "finding" && /hors\s+périmètre/iu.test(block.text));
  const references = findings.filter(block => !block.tracking).flatMap(block => locations(block.text));
  // Un suivi peut rappeler un constat développé plus loin ; seule sa version complète est transmise.
  return findings.filter(block => !block.tracking || !locations(block.text).some(ref => references.includes(ref)));
}

/** Les réserves du rapport accepté restent référencées sans réécrire le verdict ni l'état relu. */
export function reviewReserves(report, reference) {
  const blocks = reviewBlocks(report);
  const findings = outOfScopeFindings(blocks);
  const deviations = blocks.filter((block) => block.kind === "deviation").map((block) => block.text);
  const expected = Number(/^\s*CONSTATS\s*:.*?(\d+)\s+hors\s+périmètre/imu.exec(report)?.[1]);
  // Un compte discordant rend l'extraction incertaine : le rapport entier reste la référence des constats.
  const kept = findings.length === expected ? findings.map((block) => block.text) : [
    `Nombre de constats discordant : CONSTATS annonce ${expected} hors périmètre ; ${findings.length} constat(s) extrait(s).` +
    " Consulter le rapport pour l'ensemble des constats hors périmètre.",
  ];
  return [...kept, ...deviations].map((text) => `${reference} : ${text}`);
}

/**
 * Relit chaque verdict TERMINÉ et redemande au moteur, par `correct(prompt)`, de corriger une relecture refusée. `code` est
 * celui de la première session ; `correct` rend celui de chaque correction. `problem` n'est fixé que si la relecture refuse
 * la tentative ; le moteur garde sinon le diagnostic de sa dernière session.
 */
export async function reviewAndCorrect({ root, ticket, dir, env, step, timeoutMs, skill, code, correct }) {
  let relectures = 0;
  let reserves = [];
  let problem = null;
  for (let correction = 0; code === 0; correction++) {
    if (sessionVerdict(dir)?.statut !== "TERMINÉ") break;
    const reviewed = review(root, ticket, dir, env, step, timeoutMs, correction > 0);
    relectures++;
    if (reviewed.uncorrected > 0) {
      const reference = path.relative(root, path.join(dir, lastReviewReport(dir)));
      problem = `Un constat non corrigé (ou une ligne NON CORRIGÉS absente ou illisible) dans ${reference}` +
        ` refuse la tentative : la boucle passe au palier suivant.\n\n${reviewed.report}`;
      code = 1;
      break;
    }
    if (reviewed.verdict === "accepté") {
      const reference = path.relative(root, path.join(dir, lastReviewReport(dir)));
      reserves = reviewReserves(reviewed.report, reference);
      break;
    }
    if (reviewed.problem || correction >= MAX_CORRECTIONS) {
      problem = reviewed.problem || reviewed.report;
      code = 1;
      break;
    }
    const reportFile = path.relative(root, path.join(dir, lastReviewReport(dir)));
    const fix = `Reprends le ticket ${ticket.id} (${ticket.file}) en suivant ${skill}.` +
      ` Lis ${reportFile}, le ticket et son journal, les écarts, git status et git diff, puis reprends le travail présent dans l'arbre.` +
      ` Corrige chaque constat bloquant et mineur de cette relecture, tests d'abord, puis rends un nouveau verdict.\n\n${reviewed.report}`;
    fs.rmSync(path.join(dir, "verdict.json"), { force: true });
    code = await correct(fix);
  }
  return { code, relectures, reserves, problem };
}
