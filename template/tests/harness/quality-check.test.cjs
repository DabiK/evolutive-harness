const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { harnessRepo } = require("./helpers/harness-repo.cjs");

const load = (rel) => import(pathToFileURL(path.join(__dirname, "..", "..", rel)).href);
const LONG = "const value = '" + "x".repeat(170) + "';\n";

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
