const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harnessRepo } = require("./helpers/harness-repo.cjs");

const LOOP = { HARNESS_LOOP: "1", HARNESS_TICKET: "T001", HARNESS_TICKET_FILE: "docs/travail/tickets/001-sample.md" };
const INTERACTIVE = { HARNESS_LOOP: "0" };

/** Lance un hook comme le fait Claude Code : entrée JSON sur stdin, décision JSON sur stdout. */
function hook(repo, name, input, env, args = []) {
  const result = repo.node(`.claude/hooks/${name}.mjs`, args, {
    input: JSON.stringify(input),
    env: { CLAUDE_PROJECT_DIR: repo.root, ...env },
  });
  assert.equal(result.code, 0, result.out);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const bash = (repo, command, env) => hook(repo, "guard-bash", { tool_name: "Bash", tool_input: { command } }, env);
const write = (repo, file, env) => hook(repo, "guard-write", { tool_name: "Write", tool_input: { file_path: `${repo.root}/${file}` } }, env);
const decision = (output) => output?.hookSpecificOutput?.permissionDecision ?? "none";

test("a guard run by these tests ignores the mode of the session that launched the tests", (t) => {
  const repo = harnessRepo();
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
    repo.cleanup();
  });
  Object.assign(process.env, { HARNESS_LOOP: "1", HARNESS_EDIT: "1", HARNESS_ALLOW_INSTALL: "1", CLAUDE_PROJECT_DIR: "/elsewhere" });
  assert.equal(decision(bash(repo, "git commit -m done", INTERACTIVE)), "none");
  assert.equal(decision(write(repo, ".claude/hooks/lib.mjs", LOOP)), "deny");
  assert.equal(decision(bash(repo, "npm install left-pad", LOOP)), "deny");
});

test("in a ticket session, integration commands and destructive commands are denied", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const command of [
    "git commit -m done",
    "git push origin work",
    "git push --force",
    "git reset --hard HEAD~1",
    "git checkout main",
    "git switch -c other",
    "git stash",
    "rm -rf ..",
    "claude -p 'do it'",
    "gh pr create",
    "npm install left-pad",
    "pnpm add left-pad",
    "pip install requests",
    "cargo add serde",
    "yarn",
    "poetry install",
    "uv sync",
    "git commit --no-verify -m x",
  ]) {
    assert.equal(decision(bash(repo, command, LOOP)), "deny", command);
  }
});

test("in a ticket session, ordinary work commands pass", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const command of [
    "node --test tests/session.test.cjs",
    "node scripts/check.mjs --changed",
    "git status --porcelain",
    "git diff HEAD",
    "git checkout -- core/a.cjs",
    "rm -rf .harness-state/tmp",
    "npm test",
  ]) {
    assert.equal(decision(bash(repo, command, LOOP)), "none", command);
  }
});

test("a ticket that allows installs lets npm install through", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(decision(bash(repo, "npm install --save-dev prettier", { ...LOOP, HARNESS_ALLOW_INSTALL: "1" })), "none");
});

test("in an interactive session, a destructive command is asked rather than denied, and a commit passes", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(decision(bash(repo, "git reset --hard HEAD~1", INTERACTIVE)), "ask");
  assert.equal(decision(bash(repo, "git commit -m done", INTERACTIVE)), "none");
});

test("the harness cannot be edited from a ticket session unless the ticket allows it", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const files = [".claude/settings.json", "scripts/check.mjs", "scripts/quality/baseline.json", "scripts/loop/run.mjs", "CLAUDE.md"];
  for (const file of [...files, "harness.config.mjs", "docs/standards.md", "tests/harness/guards.test.cjs"]) {
    assert.equal(decision(write(repo, file, LOOP)), "deny", file);
    assert.equal(decision(write(repo, file, INTERACTIVE)), "ask", file);
    assert.equal(decision(write(repo, file, { ...LOOP, HARNESS_EDIT: "1" })), "none", file);
  }
  assert.equal(decision(write(repo, "core/session.cjs", LOOP)), "none");
});

test("the owner can open the harness for a bounded time in an interactive session; a ticket session ignores it", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const now = Math.floor(Date.now() / 1000);
  const openUntil = (seconds) => repo.write(".harness-state/harnais-ouvert", String(seconds) + "\n");
  openUntil(now + 3600);
  assert.equal(decision(write(repo, "scripts/check.mjs", INTERACTIVE)), "none");
  assert.equal(decision(write(repo, ".claude/settings.json", INTERACTIVE)), "none");
  assert.equal(decision(write(repo, "scripts/check.mjs", LOOP)), "deny");
  openUntil(now - 1);
  assert.equal(decision(write(repo, "scripts/check.mjs", INTERACTIVE)), "ask");
  openUntil(now + 48 * 3600);
  assert.equal(decision(write(repo, "scripts/check.mjs", INTERACTIVE)), "ask");
  repo.write(".harness-state/harnais-ouvert", "toujours\n");
  assert.equal(decision(write(repo, "scripts/check.mjs", INTERACTIVE)), "ask");
});

test("a new test file named after a ticket is denied; an existing one can still be edited", (t) => {
  const repo = harnessRepo({ "tests/architecture-f04.test.cjs": "" });
  t.after(repo.cleanup);
  assert.equal(decision(write(repo, "tests/architecture-f11.test.cjs", INTERACTIVE)), "deny");
  assert.equal(decision(write(repo, "tests/review-regressions.test.cjs", LOOP)), "deny");
  assert.equal(decision(write(repo, "tests/architecture-f04.test.cjs", LOOP)), "none");
  assert.equal(decision(write(repo, "tests/session-archive.test.cjs", LOOP)), "none");
});

test("a ticket session writes only its own ticket, and nothing outside the project", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(decision(write(repo, "docs/travail/tickets/001-sample.md", LOOP)), "none");
  assert.equal(decision(write(repo, "docs/travail/tickets/002-other.md", LOOP)), "deny");
  assert.equal(decision(write(repo, "../elsewhere.txt", LOOP)), "deny");
});

test("only a harness ticket edits the ticket template, and it still writes no other ticket", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const harness = { ...LOOP, HARNESS_EDIT: "1" };
  assert.equal(decision(write(repo, "docs/travail/tickets/_gabarit.md", LOOP)), "deny");
  assert.equal(decision(write(repo, "docs/travail/tickets/_gabarit.md", harness)), "none");
  assert.equal(decision(write(repo, "docs/travail/tickets/002-other.md", harness)), "deny");
  assert.equal(decision(write(repo, "docs/travail/tickets/INDEX.md", harness)), "deny");
});

test("a ticket session runs its sub-agents in the foreground and its reviewer on the model the loop chose; an interactive session is left alone", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const launch = (extra, env) => {
    const call = { tool_name: "Agent", tool_input: { subagent_type: "explorateur", prompt: "explore the ticket", ...extra } };
    return hook(repo, "guard-agent", call, env);
  };
  const rewritten = (output) => output.hookSpecificOutput.updatedInput;
  for (const extra of [{}, { run_in_background: true }, { run_in_background: false }]) {
    const output = launch(extra, LOOP);
    assert.equal(decision(output), "allow");
    assert.deepEqual(rewritten(output), { subagent_type: "explorateur", prompt: "explore the ticket", run_in_background: false });
  }
  const reviewer = launch({ subagent_type: "relecteur", model: "sonnet" }, { ...LOOP, HARNESS_REVIEW_MODEL: "opus" });
  assert.equal(rewritten(reviewer).model, "opus");
  const explorer = launch({}, { ...LOOP, HARNESS_REVIEW_MODEL: "opus" });
  assert.equal(rewritten(explorer).model, undefined);
  assert.equal(launch({}, INTERACTIVE), null);
  assert.equal(launch({ run_in_background: true }, INTERACTIVE), null);
});

test("in a ticket session, each reviewer verdict is recorded against the review it read; other sub-agents and interactive sessions record nothing", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const reviews = ".harness-state/tickets/T001/relectures.jsonl";
  const recorded = () => repo.read(reviews).trim().split("\n").map((line) => JSON.parse(line));
  const handback = (agent, text, response = { handbackReport: { text }, resolvedModel: "claude-opus-5-5" }) =>
    hook(repo, "record-review", { tool_name: "Agent", tool_input: { subagent_type: agent }, tool_response: response }, LOOP);
  repo.write(".harness-state/tickets/T001/reviewed-state.json", JSON.stringify({ revue: "revue-2.diff", fichiers: {} }));

  handback("relecteur", "VERDICT : à corriger\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\n- constat");
  handback("relecteur", "VERDICT : accepté", {
    content: [{ type: "text", text: "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre\nRien à signaler." }],
  });
  handback("relecteur", "Le diff me semble correct.");
  handback("explorateur", "VERDICT : accepté");
  const interactive = { tool_name: "Agent", tool_input: { subagent_type: "relecteur" }, tool_response: { handbackReport: { text: "VERDICT : accepté" } } };
  hook(repo, "record-review", interactive, INTERACTIVE);

  assert.deepEqual(
    recorded().map(({ revue, verdict, modele }) => ({ revue, verdict, modele })),
    [
      { revue: "revue-2.diff", verdict: "à corriger", modele: "claude-opus-5-5" },
      { revue: "revue-2.diff", verdict: "accepté", modele: null },
      { revue: "revue-2.diff", verdict: "illisible", modele: "claude-opus-5-5" },
    ],
  );
});

test("after an edit, a file that breaks a rule is reported back and a clean one is silent", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  const edit = () => hook(repo, "after-edit", { tool_name: "Edit", tool_input: { file_path: `${repo.root}/core/a.cjs` } }, INTERACTIVE);
  assert.equal(edit(), null);
  repo.write("core/a.cjs", "const a = '" + "x".repeat(170) + "';\n");
  const reported = edit();
  assert.equal(reported.decision, "block");
  assert.match(reported.reason, /160 caractères/);
});

test("a ticket session cannot stop without a verdict, nor claim it is done on a red check", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  const stop = (session) => hook(repo, "stop-gate", { hook_event_name: "Stop", session_id: session }, LOOP);
  assert.match(stop("s1").reason, /Aucun verdict pour T001/);

  repo.write(".harness-state/tickets/T001/verdict.json", JSON.stringify({ statut: "BLOQUÉ", resume: "décision attendue" }));
  assert.equal(stop("s2"), null);

  repo.write(".harness-state/tickets/T001/verdict.json", JSON.stringify({ statut: "TERMINÉ", resume: "fait" }));
  assert.equal(stop("s3"), null);
  repo.write("core/a.cjs", "const a = '" + "x".repeat(170) + "';\n");
  assert.match(stop("s4").reason, /TERMINÉ mais le contrôle qualité est rouge/);
});

test("the stop gate gives up after two blocks so a session can never loop forever", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const stop = () => hook(repo, "stop-gate", { hook_event_name: "Stop", session_id: "same" }, LOOP);
  assert.equal(stop().decision, "block");
  assert.equal(stop().decision, "block");
  assert.equal(stop(), null);
});

test("the implementer cannot hand back an increment that fails the check", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  const end = (agent) => hook(repo, "stop-gate", { hook_event_name: "SubagentStop", agent_id: agent }, LOOP, ["--subagent"]);
  assert.equal(end("a1"), null);
  repo.write("core/a.cjs", "const a = 1;\ntry {\n  a();\n} catch {}\n");
  assert.match(end("a2").reason, /ne passe pas le contrôle qualité/);
});

test("in an interactive session the stop gate never blocks: a red check is only shown", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "const a = 1;\n" });
  t.after(repo.cleanup);
  repo.write("core/a.cjs", "const a = '" + "x".repeat(170) + "';\n");
  const output = hook(repo, "stop-gate", { hook_event_name: "Stop", session_id: "i1" }, INTERACTIVE);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /Contrôle qualité rouge/);
});

test("a compaction during a ticket session is recorded and told what to keep; an interactive one is left alone", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const input = JSON.stringify({ hook_event_name: "PreCompact", trigger: "auto", session_id: "s1" });
  const compact = (env) => repo.node(".claude/hooks/record-compaction.mjs", [], { input, env: { CLAUDE_PROJECT_DIR: repo.root, ...env } });
  const kept = compact(LOOP);
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.stdout, /critères d'acceptation/);
  assert.match(kept.stdout, /\.harness-state\/tickets\/T001\/verdict\.json/);
  const recorded = repo.read(".harness-state/tickets/T001/compactions.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(recorded.map((r) => [r.trigger, r.session]), [["auto", "s1"]]);
  const alone = compact(INTERACTIVE);
  assert.equal(alone.code, 0, alone.out);
  assert.equal(alone.stdout, "");
});

test("an interactive session is told how many retrospective proposals wait for the owner; a ticket session is not", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const lines = [{ statut: "propose" }, { statut: "accepte" }, { statut: "propose" }].map((entry) => JSON.stringify(entry));
  repo.write(".harness-state/retours/observations.jsonl", [...lines, "{ broken"].join("\n") + "\n");
  const context = (env) => hook(repo, "session-context", { hook_event_name: "SessionStart" }, env).hookSpecificOutput.additionalContext;
  assert.match(context(INTERACTIVE), /2 proposition\(s\) de la rétrospective à trancher/);
  assert.doesNotMatch(context(LOOP), /proposition/);
});

test("the session start hook gives the branch and the mode", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const output = hook(repo, "session-context", { hook_event_name: "SessionStart" }, LOOP);
  assert.match(output.hookSpecificOutput.additionalContext, /Branche work/);
  assert.match(output.hookSpecificOutput.additionalContext, /Mode boucle : ticket T001/);
});
