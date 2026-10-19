const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { harnessRepo } = require("./helpers/harness-repo.cjs");

const HOST = path.join(__dirname, "helpers", "opencode-host.cjs");
const LOOP = { HARNESS_LOOP: "1", HARNESS_TICKET: "T001", HARNESS_TICKET_FILE: "docs/travail/tickets/001-sample.md" };
const INTERACTIVE = { HARNESS_LOOP: "0" };

// Un processus neuf charge le plugin dans l'hôte factice et rejoue les actions : le plugin lit l'environnement du
// processus OpenCode, que le test fixe entièrement.
const DRIVER = `
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require(${JSON.stringify(HOST)});
const writeFile = async (input) => {
  fs.mkdirSync(path.dirname(input.path), { recursive: true });
  fs.writeFileSync(input.path, input.content);
  return "written";
};
(async () => {
  const actions = JSON.parse(fs.readFileSync(0, "utf8"));
  const host = await loadPlugin(process.cwd());
  const results = [];
  for (const action of actions) {
    const session = action.session || "ses_test";
    if (action.kind === "call") results.push(await host.call(session, action.tool, action.input, action.tool === "write" ? writeFile : undefined));
    if (action.kind === "prompt") results.push(await host.prompt(session, action.text));
    if (action.kind === "compaction") results.push(await host.compaction(session));
  }
  console.log(JSON.stringify({ id: host.id, hooks: host.hooks, results }));
})().catch((error) => {
  console.log(JSON.stringify({ crash: error.stack }));
  process.exit(1);
});
`;

function drive(repo, actions, env) {
  const result = repo.run(process.execPath, ["-e", DRIVER], { input: JSON.stringify(actions), env });
  assert.equal(result.code, 0, result.out);
  return JSON.parse(result.stdout);
}

const write = (file, content = "module.exports = 1;\n") => ({ kind: "call", tool: "write", input: { path: file, content } });
const shell = (command) => ({ kind: "call", tool: "shell", input: { command } });

test("the OpenCode plugin loads as an OpenCode 2 module and hooks tools, permissions, prompts and compactions", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const { id, hooks } = drive(repo, [], LOOP);
  assert.equal(id, "evolutive-harness");
  assert.deepEqual(hooks, ["permission.evaluate", "session.compaction", "session.prompt", "tool.execute.after", "tool.execute.before"]);
});

test("in a loop session, the plugin denies a harness write, a harness patch and an integration command with the guard's reason", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const before = repo.read("scripts/check.mjs");
  const patch = { kind: "call", tool: "patch", input: { patchText: "*** Begin Patch\n*** Update File: .claude/hooks/lib.mjs\n@@\n-a\n+b\n*** End Patch" } };
  const { results } = drive(repo, [write("scripts/check.mjs", "// weakened\n"), patch, shell("git push origin work"), write(".opencode/agents/x.md")], LOOP);
  const [harness, patched, pushed, agent] = results;
  for (const result of [harness, patched, pushed, agent]) assert.equal(result.effect, "deny", JSON.stringify(result));
  assert.match(harness.error, /scripts\/check\.mjs fait partie du harnais/);
  assert.match(patched.error, /\.claude\/hooks\/lib\.mjs fait partie du harnais/);
  assert.match(pushed.error, /la boucle committe et pousse elle-même/);
  assert.match(agent.error, /\.opencode\/agents\/x\.md fait partie du harnais/);
  assert.equal(repo.read("scripts/check.mjs"), before);
  assert.equal(fs.existsSync(path.join(repo.root, ".opencode/agents/x.md")), false);
});

test("in a loop session, ordinary writes and commands go through the plugin untouched", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const { results } = drive(repo, [write("core/greeting.cjs"), shell("node --version"), { kind: "call", tool: "read", input: { path: "README.md" } }], LOOP);
  assert.deepEqual(results.map((result) => result.status), ["completed", "completed", "completed"]);
  assert.deepEqual(results[0].content, ["written"]);
  assert.equal(repo.read("core/greeting.cjs"), "module.exports = 1;\n");
});

test("interactively, the plugin asks before a harness write or a risky command instead of refusing", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const { results } = drive(repo, [write("scripts/check.mjs", "// weakened\n"), shell("git reset --hard HEAD"), shell("git commit -m done")], INTERACTIVE);
  assert.deepEqual(results.map((result) => result.effect ?? result.status), ["ask", "ask", "completed"]);
  assert.match(results[0].error, /fait partie du harnais/);
});

test("after an edit, a failing quick check of the written file is added to the tool result", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const { results } = drive(repo, [write("core/long.cjs", `module.exports = '${"x".repeat(200)}';\n`), write("core/short.cjs")], LOOP);
  assert.equal(results[0].status, "completed");
  assert.equal(results[0].content[0], "written");
  assert.match(results[0].content[1], /Contrôle rapide en échec sur core\/long\.cjs/);
  assert.deepEqual(results[1].content, ["written"]);
});

test("on the first message of a loop session, the plugin adds the repository context and writes the startup witness", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const actions = [{ kind: "prompt", session: "ses_w", text: "Traite T001." }, { kind: "prompt", session: "ses_w", text: "Encore." }];
  const { results } = drive(repo, actions, { ...LOOP, HARNESS_HOOK_RUN: "run-1", CLAUDE_PROJECT_DIR: "/elsewhere" });
  assert.match(results[0], /^Traite T001\.\n\n/);
  assert.match(results[0], /Mode boucle : ticket T001/);
  assert.ok(results[0].includes("skill .agents/skills/ticket-opencode/SKILL.md"), results[0]);
  assert.equal(results[1], "Encore.");
  assert.deepEqual(JSON.parse(repo.read(".harness-state/tickets/T001/hooks-started.json")), { session: "ses_w", run: "run-1" });
});

test("a guard that cannot run refuses the call in a loop session and asks interactively", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  fs.rmSync(path.join(repo.root, ".claude/hooks/guard-write.mjs"));
  const [denied] = drive(repo, [write("core/greeting.cjs")], LOOP).results;
  assert.equal(denied.effect, "deny");
  assert.match(denied.error, /Garde-fou du harnais en échec \(guard-write\)/);
  assert.equal(fs.existsSync(path.join(repo.root, "core/greeting.cjs")), false);
  const [asked] = drive(repo, [write("core/greeting.cjs")], INTERACTIVE).results;
  assert.equal(asked.effect, "ask");
});

test("a compaction in a loop session is recorded and its summary instructions reach the compaction request", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const [system] = drive(repo, [{ kind: "compaction", session: "ses_c" }], LOOP).results;
  assert.equal(system.length, 1);
  assert.equal(system[0].type, "text");
  assert.match(system[0].text, /Session de ticket T001/);
  const lines = repo.read(".harness-state/tickets/T001/compactions.jsonl").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.session), ["ses_c"]);
});
