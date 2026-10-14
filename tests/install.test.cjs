const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(ROOT, "template");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Un projet Git jetable, et une copie du modèle que le test peut modifier. */
function setup(t, files = {}) {
  const project = tempDir("harness-project-");
  const template = path.join(tempDir("harness-template-"), "template");
  fs.cpSync(TEMPLATE, template, { recursive: true });
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(path.dirname(template), { recursive: true, force: true });
  });
  const write = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(project, rel, text);
  spawnSync("git", ["init", "-q", "-b", "work"], { cwd: project });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "install.mjs"), project, "--from", template, ...args], { encoding: "utf8" });
    return { code: result.status, out: (result.stdout || "") + (result.stderr || "") };
  };
  const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const exists = (root, rel) => fs.existsSync(path.join(root, rel));
  return { project, template, run, write, read, exists };
}

const settingsOf = (env) => JSON.parse(env.read(env.project, ".claude/settings.json"));
const commands = (settings) => Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

test("installing copies the core and the project files, merges settings and .gitignore, and locks the core", (t) => {
  const own = { permissions: { allow: ["Bash(make test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo own" }] }] } };
  const env = setup(t, { ".claude/settings.json": JSON.stringify(own), ".gitignore": "node_modules/" });
  const result = env.run();
  assert.equal(result.code, 0, result.out);
  for (const rel of ["scripts/check.mjs", "scripts/loop/run.mjs", ".claude/hooks/guard-bash.mjs", ".claude/agents/relecteur.md", "tests/harness/ticket-loop.test.cjs"])
    assert.equal(env.read(env.project, rel), env.read(env.template, rel), rel);
  for (const rel of ["CLAUDE.md", "harness.config.mjs", "docs/standards.md"]) assert.ok(env.exists(env.project, rel), rel);
  const lock = JSON.parse(env.read(env.project, ".claude/harness.lock.json"));
  assert.ok(lock.files["scripts/check.mjs"]);
  assert.equal(lock.files["CLAUDE.md"], undefined);
  assert.equal(lock.files[".claude/settings.json"], undefined);
  const settings = settingsOf(env);
  assert.deepEqual(settings.permissions.allow, ["Bash(make test)"]);
  assert.ok(settings.permissions.deny.includes("Bash(git push --force*)"));
  assert.ok(commands(settings).includes("echo own"));
  assert.ok(commands(settings).some((c) => c.includes(".claude/hooks/stop-gate.mjs")));
  assert.equal(env.read(env.project, ".gitignore").match(/^\.harness-state\/$/gm).length, 1);
  assert.equal(env.run().code, 1, "a second install is refused: the update is the way forward");
});

test("installing over a different core file writes nothing; --force replaces it; an existing project file is kept", (t) => {
  const env = setup(t, { "scripts/check.mjs": "// the project's own check\n", "CLAUDE.md": "# Mine\n" });
  const refused = env.run();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /scripts\/check\.mjs : existe déjà dans le projet/);
  assert.equal(env.exists(env.project, "scripts/loop/run.mjs"), false);
  assert.equal(env.exists(env.project, ".claude/harness.lock.json"), false);
  assert.equal(env.run("--force").code, 0);
  assert.equal(env.read(env.project, "scripts/check.mjs"), env.read(env.template, "scripts/check.mjs"));
  assert.equal(env.read(env.project, "CLAUDE.md"), "# Mine\n");
});

test("a dry run lists what would be installed and writes nothing", (t) => {
  const env = setup(t);
  const result = env.run("--dry-run");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /ajouté scripts\/check\.mjs/);
  assert.match(result.out, /rien n'a été écrit/);
  assert.deepEqual(fs.readdirSync(env.project), [".git"]);
});

test("an update replaces a core file changed upstream, keeps one changed in the project, and never touches project files", (t) => {
  const env = setup(t);
  assert.equal(env.run().code, 0);
  fs.appendFileSync(path.join(env.template, "scripts/check.mjs"), "// upstream change\n");
  fs.appendFileSync(path.join(env.template, "CLAUDE.md"), "upstream wording\n");
  fs.appendFileSync(path.join(env.project, "scripts/loop/models.mjs"), "// local change\n");
  fs.appendFileSync(path.join(env.project, "harness.config.mjs"), "// local config\n");
  const result = env.run("--update");
  assert.equal(result.code, 0, result.out);
  assert.match(env.read(env.project, "scripts/check.mjs"), /upstream change/);
  assert.match(env.read(env.project, "scripts/loop/models.mjs"), /local change/);
  assert.match(result.out, /scripts\/loop\/models\.mjs : modifié dans le projet depuis l'installation/);
  assert.doesNotMatch(env.read(env.project, "CLAUDE.md"), /upstream wording/);
  assert.match(env.read(env.project, "harness.config.mjs"), /local config/);
  assert.equal(env.run("--update", "--force").code, 0);
  assert.equal(env.read(env.project, "scripts/loop/models.mjs"), env.read(env.template, "scripts/loop/models.mjs"));
});

test("an update adds new core files, removes dropped ones left unchanged, and swaps the harness hooks without duplicates", (t) => {
  const env = setup(t);
  assert.equal(env.run().code, 0);
  const before = commands(settingsOf(env)).length;
  // Un hook renommé en amont : l'ancienne entrée des réglages doit disparaître avec lui.
  const settings = settingsOf(env);
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/old-gate.mjs"' }] });
  env.write(env.project, ".claude/settings.json", JSON.stringify(settings));
  env.write(env.project, ".claude/hooks/old-gate.mjs", "// old\n");
  const lock = JSON.parse(env.read(env.project, ".claude/harness.lock.json"));
  lock.files[".claude/hooks/old-gate.mjs"] = require("node:crypto").createHash("sha256").update("// old\n").digest("hex");
  env.write(env.project, ".claude/harness.lock.json", JSON.stringify(lock));
  env.write(env.template, "scripts/loop/budget.mjs", "export const BUDGET = 1;\n");
  fs.rmSync(path.join(env.template, "docs/adr/0000-gabarit.md"));
  const result = env.run("--update");
  assert.equal(result.code, 0, result.out);
  assert.ok(env.exists(env.project, "scripts/loop/budget.mjs"));
  assert.equal(env.exists(env.project, "docs/adr/0000-gabarit.md"), false);
  assert.equal(env.exists(env.project, ".claude/hooks/old-gate.mjs"), false);
  const after = commands(settingsOf(env));
  assert.equal(after.length, before);
  assert.ok(!after.some((c) => c.includes("old-gate")));
});

test("compare tells which side changed, and pull brings a project improvement back into the template", (t) => {
  const env = setup(t);
  assert.equal(env.run().code, 0);
  fs.appendFileSync(path.join(env.project, "scripts/loop/models.mjs"), "// better ladder\n");
  fs.appendFileSync(path.join(env.template, "scripts/check.mjs"), "// upstream change\n");
  const compared = env.run("--compare");
  assert.equal(compared.code, 0, compared.out);
  assert.match(compared.out, /modifié dans le projet \(1\) — --pull le reprend dans le modèle\n {2}scripts\/loop\/models\.mjs/);
  assert.match(compared.out, /modifié dans le modèle \(1\) — --update l'apporte au projet\n {2}scripts\/check\.mjs/);
  assert.equal(env.run("--pull", "scripts/loop/models.mjs").code, 0);
  assert.match(env.read(env.template, "scripts/loop/models.mjs"), /better ladder/);
  assert.equal(env.run("--update").code, 0);
  const synced = env.run("--compare").out;
  assert.doesNotMatch(synced, /modifié/);
});

test("pull refuses the project's own files and anything outside the harness", (t) => {
  const env = setup(t, { "src/app.js": "module.exports = 1;\n" });
  assert.equal(env.run().code, 0);
  const own = ["CLAUDE.md", "harness.config.mjs", "scripts/quality/baseline.json", ".claude/settings.json", "src/app.js"];
  for (const rel of [...own, "docs/travail/tickets/012-a-ticket.md", "docs/travail/notes.md"]) {
    env.write(env.project, rel, "{}\n");
    assert.equal(env.run("--pull", rel).code, 2, rel);
  }
});

test("the project must be the root of a Git repository", (t) => {
  const env = setup(t);
  fs.mkdirSync(path.join(env.project, "pkg"));
  const nested = spawnSync(process.execPath, [path.join(ROOT, "install.mjs"), path.join(env.project, "pkg"), "--from", env.template], { encoding: "utf8" });
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /sous-dossier d'un dépôt Git/);
  fs.rmSync(path.join(env.project, ".git"), { recursive: true });
  const bare = env.run();
  assert.equal(bare.code, 1);
  assert.match(bare.out, /n'est pas un dépôt Git/);
});

test("an update with nothing new leaves the lock as it was", (t) => {
  const env = setup(t);
  assert.equal(env.run().code, 0);
  const lock = env.read(env.project, ".claude/harness.lock.json");
  const result = env.run("--update");
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /verrou/);
  assert.equal(env.read(env.project, ".claude/harness.lock.json"), lock);
});

test("a template file that belongs to no kind of file is refused before anything is written", (t) => {
  const env = setup(t);
  env.write(env.template, "notes.txt", "draft\n");
  const result = env.run();
  assert.equal(result.code, 2);
  assert.match(result.out, /hors du noyau.*notes\.txt/);
  assert.deepEqual(fs.readdirSync(env.project), [".git"]);
});
