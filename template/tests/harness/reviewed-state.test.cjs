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

for (const [name, content] of [
  ["missing", undefined], ["valid", '["notes/café.md"]'], ["empty", "[]"],
  ["malformed JSON", "{ not json"], ["unexpected object", "{}"], ["non-string path", '["notes.md", 2]'],
]) {
  test(`the shared untracked reader distinguishes an absent file from an unreadable list: ${name}`, async (t) => {
    const fs = require("node:fs");
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-state-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { readUntrackedBefore, UNTRACKED_BEFORE } = await reviewedState();
    if (content !== undefined) fs.writeFileSync(path.join(dir, UNTRACKED_BEFORE), content);
    const read = readUntrackedBefore(dir);
    if (name === "missing") assert.deepEqual(read, { paths: [], missing: true });
    else if (name === "valid" || name === "empty") assert.deepEqual(read, { paths: JSON.parse(content) });
    else {
      assert.match(read.unreadable, /untracked-before\.json est illisible/);
      assert.ok(read.problem.includes(read.unreadable), read.problem);
      assert.equal(read.paths, undefined);
    }
  });
}

for (const [report, expected] of [
  ["NON CORRIGÉS : 0", 0], ["NON CORRIGÉS : 2", 2], ["", 1], ["NON CORRIGÉS : inconnu", 1],
  ["NON CORRIGÉS : -1", 1], ["NON CORRIGÉS : 0.5", 1], ["NON CORRIGÉS : 0 restant", 1],
  ["NON CORRIGÉS : 9007199254740992", 1], ["NON CORRIGÉS :\n0", 1],
  ["NON CORRIGÉS : inconnu\nNON CORRIGÉS : 0", 1], ["  non corrigés: 0  \r\n", 0],
]) {
  test(`the correction counter requires a safe integer on its first line: ${JSON.stringify(report)}`, async () => {
    const { uncorrectedFindings } = await reviewedState();
    assert.equal(uncorrectedFindings(report), expected);
  });
}
