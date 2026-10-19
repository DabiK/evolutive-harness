const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { harnessRepo } = require("./helpers/harness-repo.cjs");

const load = (rel) => import(pathToFileURL(path.join(__dirname, "..", "..", rel)).href);
const LONG = "const value = '" + "x".repeat(170) + "';\n";
const testSource = (count) => "const { test } = require('node:test');\n" +
  Array.from({ length: count }, (_, index) => `test('case ${index}', () => {});\n`).join("");

for (const mode of [[], ["--changed"]]) {
  test(`the ${mode.length ? "changed" : "full"} green check keeps its existing output`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    repo.write("tests/sample.test.cjs", testSource(2));
    const text = repo.node("scripts/check.mjs", mode);
    assert.equal(text.code, 0, text.out);
    assert.equal(text.out, [
      "✔ règles par fichier",
      "– format : non lancé (Prettier n'est pas installé)",
      "– lint : non lancé (ESLint n'est pas installé ou pas configuré)",
      "✔ gel du lint",
      "– cliquet : non lancé (aucun plancher (node scripts/quality/ratchet.mjs --init))",
      "✔ tests JS (1 fichier(s))",
      "    ℹ tests 2",
      "    ℹ pass 2",
      "    ℹ fail 0",
      mode.length ? "✔ tests du harnais" : "– tests du harnais : non lancé (aucun test)",
      "check : vert",
      "",
    ].join("\n"));
    const json = repo.node("scripts/check.mjs", [...mode, "--json"]);
    assert.equal(json.code, 0, json.out);
    const report = JSON.parse(json.out);
    assert.equal(report.ok, true);
    assert.deepEqual(report.steps.find((step) => step.name.startsWith("tests JS")), {
      name: "tests JS (1 fichier(s))", status: "ok", detail: "ℹ tests 2\nℹ pass 2\nℹ fail 0",
    });
  });
}

for (const mode of [[], ["--changed"]]) {
  for (const json of [false, true]) {
    const label = `${mode.length ? "changed" : "full"} ${json ? "JSON" : "text"}`;
    test(`the ${label} check retains every failing assertion with its location and values`, (t) => {
      const repo = harnessRepo();
      t.after(repo.cleanup);
      repo.write("tests/assertion.test.cjs", [
        "const { test } = require('node:test');",
        "const assert = require('node:assert/strict');",
        "test('compares numbers', () => {",
        "  assert.equal(1, 2);",
        "});",
        "test('explains another comparison', () => {",
        "  assert.equal(3, 4, 'the second comparison failed');",
        "});",
      ].join("\n") + "\n");
      const result = repo.node("scripts/check.mjs", [...mode, ...(json ? ["--json"] : [])]);
      assert.equal(result.code, 1, result.out);
      const report = json ? JSON.parse(result.out) : null;
      if (json) assert.equal(report.ok, false);
      const step = report?.steps.find((entry) => entry.name.startsWith("tests JS"));
      if (json) assert.equal(step.status, "ko");
      const detail = json ? step.detail : result.out;
      assert.match(detail, /compares numbers/);
      assert.match(detail, /explains another comparison/);
      assert.match(detail, /tests\/assertion\.test\.cjs:4:\d+/);
      assert.match(detail, /tests\/assertion\.test\.cjs:7:\d+/);
      assert.match(detail, /AssertionError \[ERR_ASSERTION\]/);
      assert.match(detail, /the second comparison failed/);
      assert.match(detail, /actual: 1,\s+expected: 2/);
      assert.match(detail, /actual: 3,\s+expected: 4/);
    });
  }
}

for (const json of [false, true]) {
  test(`the ${json ? "JSON" : "text"} check bounds many failing assertions and announces truncation`, (t) => {
    const source = [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      ...Array.from({ length: 50 }, (_, index) =>
        `test('comparison ${index}', () => assert.equal(${index}, ${index + 1}));`),
    ].join("\n") + "\n";
    const repo = harnessRepo({ "tests/assertion.test.cjs": source });
    t.after(repo.cleanup);
    const result = repo.node("scripts/check.mjs", json ? ["--json"] : []);
    assert.equal(result.code, 1, result.out);
    let detail;
    if (json) detail = JSON.parse(result.out).steps.find((step) => step.name.startsWith("tests JS")).detail;
    else {
      const block = result.out.match(/✖ tests JS \(2 fichier\(s\)\)\n([\s\S]*?)\n– tests du harnais/);
      assert.ok(block, result.out);
      detail = block[1].replace(/^ {4}/gm, "");
    }
    const lines = detail.split("\n");
    assert.ok(lines.length <= 120, `expected at most 120 lines, got ${lines.length}`);
    assert.match(lines.at(-1), /tronqué.*120 lignes/);
    assert.match(detail, /comparison 0/);
    assert.match(detail, /tests\/assertion\.test\.cjs:3:\d+/);
    assert.match(detail, /actual: 0,\s+expected: 1/);
  });
}

for (const mode of [[], ["--changed"]]) {
  const label = mode.length ? "changed" : "full";
  const frozen = { "core/legacy.cjs": { complexity: { count: 3 } } };
  for (const [name, current, file, rule, before, now] of [
    ["a higher count", { "core/legacy.cjs": { complexity: { count: 4 } } }, "core/legacy.cjs", "complexity", 3, 4],
    ["a new rule", { "core/legacy.cjs": { complexity: { count: 3 }, "no-empty": { count: 1 } } }, "core/legacy.cjs", "no-empty", 0, 1],
    ["a new file", { ...frozen, "core/new.cjs": { complexity: { count: 1 } } }, "core/new.cjs", "complexity", 0, 1],
  ]) {
    test(`the ${label} check refuses ${name} in the lint freeze without ESLint`, (t) => {
      const repo = harnessRepo({ "eslint-suppressions.json": JSON.stringify(frozen) });
      t.after(repo.cleanup);
      repo.write("eslint-suppressions.json", JSON.stringify(current));
      const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
      assert.equal(result.code, 1, result.out);
      const report = JSON.parse(result.out);
      assert.equal(report.steps.find((step) => step.name === "lint").status, "skip");
      const freeze = report.steps.find((step) => step.name === "gel du lint");
      assert.equal(freeze.status, "ko");
      assert.ok(freeze.detail.includes(`${file} : ${rule} : ${before} → ${now}`), freeze.detail);
      assert.match(freeze.detail, /infraction nouvelle se corrige au lieu de se geler/);
    });
  }

  for (const [name, current] of [
    ["a lower count", { "core/legacy.cjs": { complexity: { count: 2 } } }],
    ["a removed rule", { "core/legacy.cjs": {} }],
    ["a removed entry", {}],
    ["a removed freeze file", null],
  ]) {
    test(`the ${label} check accepts ${name} in the lint freeze without ESLint`, (t) => {
      const repo = harnessRepo({ "eslint-suppressions.json": JSON.stringify(frozen) });
      t.after(repo.cleanup);
      if (current === null) fs.unlinkSync(path.join(repo.root, "eslint-suppressions.json"));
      else repo.write("eslint-suppressions.json", JSON.stringify(current));
      const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
      assert.equal(result.code, 0, result.out);
      const report = JSON.parse(result.out);
      assert.equal(report.steps.find((step) => step.name === "lint").status, "skip");
      assert.equal(report.steps.find((step) => step.name === "gel du lint").status, "ok");
    });
  }

  test(`the ${label} check accepts an absent lint freeze in both the tree and HEAD`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.steps.find((step) => step.name === "lint").status, "skip");
    assert.equal(report.steps.find((step) => step.name === "gel du lint").status, "ok");
  });

  for (const version of ["tree", "HEAD"]) {
    test(`the ${label} check explicitly refuses invalid lint freeze JSON in ${version}`, (t) => {
      const initial = version === "HEAD" ? "{" : JSON.stringify(frozen);
      const repo = harnessRepo({ "eslint-suppressions.json": initial });
      t.after(repo.cleanup);
      repo.write("eslint-suppressions.json", version === "HEAD" ? JSON.stringify(frozen) : "{");
      const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
      assert.equal(result.code, 1, result.out);
      const freeze = JSON.parse(result.out).steps.find((step) => step.name === "gel du lint");
      assert.equal(freeze.status, "ko");
      assert.match(freeze.detail, /eslint-suppressions\.json.*JSON invalide/);
      if (version === "HEAD") assert.match(freeze.detail, /HEAD:eslint-suppressions\.json/);
    });
  }

  test(`the ${label} check explicitly refuses an unreadable lint freeze`, (t) => {
    const repo = harnessRepo({ "eslint-suppressions.json": JSON.stringify(frozen) });
    t.after(repo.cleanup);
    const file = path.join(repo.root, "eslint-suppressions.json");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
    assert.equal(result.code, 1, result.out);
    const freeze = JSON.parse(result.out).steps.find((step) => step.name === "gel du lint");
    assert.equal(freeze.status, "ko");
    assert.match(freeze.detail, /eslint-suppressions\.json.*illisible/);
  });

  test(`the ${label} check reports every new lint freeze pair when HEAD has no freeze`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    const current = { "core/legacy.cjs": { complexity: { count: 3 }, "no-empty": { count: 1 } } };
    repo.write("eslint-suppressions.json", JSON.stringify(current));
    const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
    assert.equal(result.code, 1, result.out);
    const freeze = JSON.parse(result.out).steps.find((step) => step.name === "gel du lint");
    assert.equal(freeze.status, "ko");
    assert.ok(freeze.detail.includes("core/legacy.cjs : complexity : 0 → 3"), freeze.detail);
    assert.ok(freeze.detail.includes("core/legacy.cjs : no-empty : 0 → 1"), freeze.detail);
  });

  test(`the ${label} check refuses an unknown baseline key instead of dropping its protection`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    assert.equal(repo.node("scripts/quality/ratchet.mjs", ["--init"]).code, 0);
    const baseline = JSON.parse(repo.read("scripts/quality/baseline.json"));
    repo.write("scripts/quality/baseline.json", JSON.stringify({ ...baseline, mesure_retiree: 1 }));
    const result = repo.node("scripts/check.mjs", [...mode, "--json"]);
    assert.equal(result.code, 1, result.out);
    const ratchet = JSON.parse(result.out).steps.find((step) => step.name === "cliquet");
    assert.equal(ratchet.status, "ko");
    assert.match(ratchet.detail, /Mesures inconnues du plancher : mesure_retiree/);
  });

}


test("measures count long lines, empty catches, env reads, innerHTML, ticket-named tests and test cases", async (t) => {
  const { measure } = await load("scripts/quality/metrics.mjs");
  const { loadConfig } = await load("scripts/quality/config.mjs");
  const repo = harnessRepo({
    "core/a.cjs": "const x = 1;\n" + LONG + "try { x(); } catch {}\n",
    "adapters/b.cjs": "const home = process.env.HOME;\n",
    "adapters/config.cjs": "module.exports = process.env;\n",
    "app/view.js": "node.innerHTML = '';\n",
    "tests/session.test.cjs": "test('a', () => {});\ntest('b', () => {});\n",
    "tests/architecture-f04.test.cjs": "test('c', () => {});\n",
  });
  t.after(repo.cleanup);
  assert.deepEqual(measure(repo.root, await loadConfig(repo.root)), {
    lignes_longues_prod: 1,
    lignes_longues_tests: 0,
    catch_vides_prod: 1,
    tests_nommes_par_chantier: 1,
    process_env_hors_config: 1,
    inner_html: 1,
    cas_de_test: 4,
  });
});

test("a measure that gets worse is a regression whichever way it is meant to move", async () => {
  const { compare } = await load("scripts/quality/ratchet.mjs");
  const { CORE_DIRECTIONS } = await load("scripts/quality/metrics.mjs");
  const worse = compare({ catch_vides_prod: 2, cas_de_test: 10 }, { catch_vides_prod: 3, cas_de_test: 9 }, CORE_DIRECTIONS);
  assert.deepEqual(worse.regressions.map((r) => r.key), ["catch_vides_prod", "cas_de_test"]);
  const better = compare({ catch_vides_prod: 2, cas_de_test: 10 }, { catch_vides_prod: 1, cas_de_test: 12 }, CORE_DIRECTIONS);
  assert.equal(better.regressions.length, 0);
  assert.deepEqual(better.improvements.map((r) => r.key), ["catch_vides_prod", "cas_de_test"]);
});

test("the baseline only ever tightens, never loosens", async () => {
  const { tighten } = await load("scripts/quality/ratchet.mjs");
  const { CORE_DIRECTIONS } = await load("scripts/quality/metrics.mjs");
  const next = tighten({ catch_vides_prod: 5, cas_de_test: 10 }, { catch_vides_prod: 7, cas_de_test: 8 }, CORE_DIRECTIONS);
  assert.deepEqual(next, { catch_vides_prod: 5, cas_de_test: 10 });
  const improved = tighten({ catch_vides_prod: 5, cas_de_test: 10 }, { catch_vides_prod: 3, cas_de_test: 14 }, CORE_DIRECTIONS);
  assert.deepEqual(improved, { catch_vides_prod: 3, cas_de_test: 14 });
});

test("the check tolerates long lines already committed and refuses a new one", (t) => {
  const repo = harnessRepo({ "core/legacy.cjs": LONG });
  t.after(repo.cleanup);
  repo.write("core/legacy.cjs", LONG + "const added = 1;\n");
  assert.equal(repo.node("scripts/check.mjs", ["--file", "core/legacy.cjs"]).code, 0);
  repo.write("core/legacy.cjs", LONG + LONG);
  const refused = repo.node("scripts/check.mjs", ["--file", "core/legacy.cjs"]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /1 ligne\(s\) de plus de 160 caractères/);
});

test("the check refuses an empty catch added to production code", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  repo.write("core/a.cjs", "const a = 1;\ntry {\n  a();\n} catch {}\n");
  const refused = repo.node("scripts/check.mjs", ["--file", "core/a.cjs"]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /catch vide ajouté/);
});

test("the check refuses a new test file named after a ticket", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  repo.write("tests/architecture-f11.test.cjs", "const { test } = require('node:test');\ntest('x', () => {});\n");
  const refused = repo.node("scripts/check.mjs", ["--changed", "--no-tests"]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /porte le nom du comportement testé/);
});

test("the full check fails when a measure regresses against the baseline and reports skipped tools as not run", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  assert.equal(repo.node("scripts/quality/ratchet.mjs", ["--init"]).code, 0);
  const green = repo.node("scripts/check.mjs");
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /format : non lancé/);
  assert.match(green.out, /tests JS \(1 fichier\(s\)\)/);
  repo.write("app/view.js", "document.body.innerHTML = '';\n");
  const red = repo.node("scripts/check.mjs", ["--no-tests"]);
  assert.equal(red.code, 1);
  assert.match(red.out, /inner_html : 0 → 1/);
});

test("the baseline cannot be re-initialised once it exists", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(repo.node("scripts/quality/ratchet.mjs", ["--init"]).code, 0);
  assert.equal(repo.node("scripts/quality/ratchet.mjs", ["--init"]).code, 1);
});

test("a test file that never ends turns the check red within its time budget and leaves no process behind", async (t) => {
  const stuck = [
    "const { test } = require('node:test');",
    "require('node:fs').writeFileSync('stuck.pid', String(process.pid));",
    "test('never ends', () => new Promise(() => setInterval(() => {}, 1000)));",
  ];
  const repo = harnessRepo({ "tests/stuck.test.cjs": stuck.join("\n") + "\n" });
  t.after(repo.cleanup);
  const red = repo.node("scripts/check.mjs", [], { env: { HARNESS_TEST_BUDGET_MS: "4000" } });
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /Délai dépassé \(4 s\)/);
  const pid = Number(repo.read("stuck.pid"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // No such process: it was stopped.
      return false;
    }
  };
  for (let i = 0; i < 100 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the stuck test process was stopped along with the check");
});

test("each configured suite runs its own files with its own command, and a failing suite turns the check red", (t) => {
  const config = [
    "export default {",
    '  productionDirs: ["core"],',
    "  suites: [",
    '    { name: "tests JS", command: ["node", "--test"], files: /^tests\\/(?!harness\\/).*\\.test\\.cjs$/ },',
    '    { name: "contrôles maison", command: ["node", "tools/verify.cjs"], files: /^checks\\/.*\\.txt$/ },',
    "  ],",
    "};",
  ].join("\n");
  const verify = "const fs = require('node:fs');\nfor (const f of process.argv.slice(2)) if (fs.readFileSync(f, 'utf8').includes('KO')) process.exit(1);\n";
  const repo = harnessRepo({ "harness.config.mjs": config + "\n", "tools/verify.cjs": verify, "checks/a.txt": "OK\n", "checks/b.txt": "OK\n" });
  t.after(repo.cleanup);
  const green = repo.node("scripts/check.mjs");
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /✔ contrôles maison \(2 fichier\(s\)\)/);
  assert.match(green.out, /✔ tests JS \(1 fichier\(s\)\)/);
  repo.write("checks/b.txt", "KO\n");
  const red = repo.node("scripts/check.mjs", ["--changed"]);
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /✖ contrôles maison \(1 fichier\(s\)\)/);
});

test("the harness tests run as their own suite, whatever the project suites are", (t) => {
  const failing = "const { test } = require('node:test');\ntest('harness rule', () => { throw new Error('broken'); });\n";
  const repo = harnessRepo({ "harness.config.mjs": "export default { suites: [] };\n", "tests/harness/rule.test.cjs": failing });
  t.after(repo.cleanup);
  const red = repo.node("scripts/check.mjs");
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /✖ tests du harnais \(1 fichier\(s\)\)/);
  assert.doesNotMatch(red.out, /tests JS/);
});

test("the project's format and lint tools judge the project's files, never the harness core", (t) => {
  const tool = (name) => `#!/bin/sh\necho "$@" >> "${name}.args"\nexit 0\n`;
  const repo = harnessRepo({
    ".gitignore": ".harness-state/\nnode_modules/\n*.args\n",
    "eslint.config.mjs": "export default [];\n",
    "core/a.cjs": "const a = 1;\n",
    "node_modules/.bin/prettier": tool("prettier"),
    "node_modules/.bin/eslint": tool("eslint"),
  });
  t.after(repo.cleanup);
  for (const name of ["prettier", "eslint"]) require("node:fs").chmodSync(`${repo.root}/node_modules/.bin/${name}`, 0o755);
  const result = repo.node("scripts/check.mjs", ["--no-tests"]);
  assert.equal(result.code, 0, result.out);
  for (const name of ["prettier", "eslint"]) {
    const files = repo.read(`${name}.args`).split(/\s+/);
    assert.ok(files.includes("core/a.cjs"), `${name} : ${files.join(" ")}`);
    assert.ok(!files.some((f) => f.startsWith("scripts/") || f.startsWith(".claude/")), `${name} : ${files.join(" ")}`);
  }
});

test("the check runs only from the root of a Git repository", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  require("node:fs").rmSync(`${repo.root}/.git`, { recursive: true, force: true });
  const refused = repo.node("scripts/check.mjs", ["--no-tests"]);
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /racine d'un dépôt Git/);
});

test("a measure without a pattern makes the configuration unreadable, with the measure named", (t) => {
  const repo = harnessRepo({ "harness.config.mjs": "export default { measures: { todo: { direction: 'max' } } };\n" });
  t.after(repo.cleanup);
  const red = repo.node("scripts/check.mjs", ["--no-tests"]);
  assert.equal(red.code, 2, red.out);
  assert.match(red.out, /la mesure « todo »/);
});

test("an unreadable harness.config.mjs fails the check with its reason", (t) => {
  const repo = harnessRepo({ "harness.config.mjs": "export default { suites: [{ name: 'x' }] };\n" });
  t.after(repo.cleanup);
  const red = repo.node("scripts/check.mjs", ["--no-tests"]);
  assert.equal(red.code, 2, red.out);
  assert.match(red.out, /harness\.config\.mjs est illisible : .*chaque suite/);
});

test("a project measure declared in harness.config.mjs joins the ratchet, and the harness tests stay out of the measures", async (t) => {
  const { measure } = await load("scripts/quality/metrics.mjs");
  const { loadConfig } = await load("scripts/quality/config.mjs");
  const config = 'export default { productionDirs: ["src"], measures: { todo: { pattern: /TODO/, direction: "max" } } };\n';
  const harnessTest = "test('a', () => {});\nconst long = '" + "x".repeat(200) + "';\n";
  const repo = harnessRepo({ "harness.config.mjs": config, "src/a.js": "// TODO\n// TODO\n", "tests/harness/guard.test.cjs": harnessTest });
  t.after(repo.cleanup);
  const values = measure(repo.root, await loadConfig(repo.root));
  assert.equal(values.todo, 2);
  assert.equal(values.lignes_longues_tests, 0);
  assert.equal(values.cas_de_test, 1);
});
