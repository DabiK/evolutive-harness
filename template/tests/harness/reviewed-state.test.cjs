const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const reviewedState = () => import(pathToFileURL(path.join(__dirname, "..", "..", "scripts/loop/reviewed-state.mjs")).href);

// Rapports de relecteur tels que le hook les reçoit, et le verdict que la boucle doit en retenir.
const reports = [
  {
    behaviour: "a report that accepts with only out-of-scope findings counts as accepted",
    report: "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre\n- adapters/config.cjs:40 : out of scope.",
    verdict: "accepté",
  },
  {
    behaviour: "a report that accepts while counting a minor finding counts as to be fixed",
    report: "VERDICT : accepté\nCONSTATS : 0 bloquant, 1 mineur, 0 hors périmètre\n- core/greeting.cjs:3 : unclear name, mineur.",
    verdict: "à corriger",
  },
  {
    behaviour: "a report that accepts while counting a blocking finding counts as to be fixed",
    report: "VERDICT : accepté\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\n- core/greeting.cjs:3 : untested, bloquant.",
    verdict: "à corriger",
  },
  {
    behaviour: "a report that accepts without a findings line is unreadable",
    report: "VERDICT : accepté\nRien à signaler.",
    verdict: "illisible",
  },
  {
    behaviour: "a report that accepts with a malformed findings line is unreadable",
    report: "VERDICT : accepté\nCONSTATS : aucun\nRien à signaler.",
    verdict: "illisible",
  },
  {
    behaviour: "a report that accepts is judged on its first findings line only",
    report: "VERDICT : accepté\nCONSTATS : 0 bloquant, 1 mineur, 0 hors périmètre\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre",
    verdict: "à corriger",
  },
  {
    behaviour: "the verdict and findings lines are read anywhere, ignoring case, extra spaces and plurals",
    report: "Relecture de revue-2.diff.\n  verdict :  Accepté\n\n  constats:0 bloquants ,  0 mineurs,3   hors périmètre  \n",
    verdict: "accepté",
  },
  {
    behaviour: "a report that asks for fixes with a findings line counts as to be fixed",
    report: "VERDICT : à corriger\nCONSTATS : 2 bloquants, 1 mineur, 0 hors périmètre\n- core/greeting.cjs:3 : untested, bloquant.",
    verdict: "à corriger",
  },
  {
    behaviour: "a report that asks for fixes without a findings line still counts as to be fixed",
    report: "VERDICT : à corriger\n- core/greeting.cjs:3 : untested, bloquant.",
    verdict: "à corriger",
  },
  {
    behaviour: "a report without a verdict line is unreadable, even with a findings line",
    report: "Le diff me semble correct.\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre",
    verdict: "illisible",
  },
];

for (const { behaviour, report, verdict } of reports) {
  test(behaviour, async () => {
    const { reviewVerdict } = await reviewedState();
    assert.equal(reviewVerdict(report), verdict);
  });
}
