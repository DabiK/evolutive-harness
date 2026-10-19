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
    "opencode run 'do it'",
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

test("lint and formatting configurations are protected while lint suppressions remain editable", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const file of ["eslint.config.mjs", ".prettierrc.json", ".prettierignore"]) {
    assert.equal(decision(write(repo, file, LOOP)), "deny", file);
    assert.equal(decision(write(repo, file, INTERACTIVE)), "ask", file);
    assert.equal(decision(write(repo, file, { ...LOOP, HARNESS_EDIT: "1" })), "none", file);
    assert.equal(decision(write(repo, file, TUNE)), "deny", file);
  }
  assert.equal(decision(write(repo, "eslint-suppressions.json", LOOP)), "none");
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

// Session d'harmonisation : le harnais est ouvert, mais seulement sur les consignes (skills et agents).
const TUNE = {
  HARNESS_LOOP: "1",
  HARNESS_TICKET: "H001",
  HARNESS_TICKET_FILE: ".harness-state/tickets/H001/observations.json",
  HARNESS_EDIT: "1",
  HARNESS_EDIT_SCOPE: "consignes",
};

test("a session scoped to the instructions writes the skills and the agents, but none of the checks, its reviewer or its own instructions", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const file of ["scripts/check.mjs", "scripts/loop/run.mjs", ".claude/hooks/guard-write.mjs", ".claude/settings.json"]) {
    assert.equal(decision(write(repo, file, TUNE)), "deny", file);
  }
  const closed = [".claude/agents/relecteur.md", ".claude/agents/harmoniseur.md", ".claude/skills/harmonisation/"];
  for (const file of [".claude/agents/relecteur.md", ".claude/agents/harmoniseur.md", ".claude/skills/harmonisation/SKILL.md"]) {
    const output = write(repo, file, TUNE);
    assert.equal(decision(output), "deny", file);
    const [first, ...next] = output.hookSpecificOutput.permissionDecisionReason.split("\n");
    assert.match(first, /ne modifie que \.claude\/skills\/ et \.claude\/agents\/ et \.agents\/skills\/\.$/, file);
    for (const entry of closed) assert.ok(next.join("\n").includes(entry), `${file}: ${next.join("\n")}`);
  }
  for (const file of [".claude/skills/ticket/SKILL.md", ".claude/agents/explorateur.md"]) {
    assert.equal(decision(write(repo, file, TUNE)), "none", file);
  }
});

test("a session scoped to the instructions cannot edit the ticket template, an unknown scope opens nothing, and unprotected files stay writable", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(decision(write(repo, "docs/travail/tickets/_gabarit.md", TUNE)), "deny");
  for (const file of [".claude/skills/ticket/SKILL.md", "scripts/check.mjs", "CLAUDE.md"]) {
    assert.equal(decision(write(repo, file, { ...TUNE, HARNESS_EDIT_SCOPE: "everything" })), "deny", file);
  }
  assert.equal(decision(write(repo, ".claude/skills/ticket/SKILL.md", { ...TUNE, HARNESS_EDIT_SCOPE: "constructor" })), "deny");
  for (const file of [".harness-state/tickets/H001/verdict.json", "core/session.cjs"]) {
    assert.equal(decision(write(repo, file, TUNE)), "none", file);
  }
});

test("the instructions scope opens the Codex skills and keeps the tuning arbiters closed", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  assert.equal(decision(write(repo, ".agents/skills/ticket-codex/SKILL.md", TUNE)), "none");
  for (const file of [".claude/agents/relecteur.md", ".claude/agents/harmoniseur.md", ".claude/skills/harmonisation/SKILL.md"]) {
    assert.equal(decision(write(repo, file, TUNE)), "deny", file);
  }
  assert.equal(decision(write(repo, ".codex/hooks.json", TUNE)), "deny");
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

test("in a ticket session, each reviewer verdict is recorded against the review it read, its report kept by rank; other sub-agents record nothing", (t) => {
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
  const report = (n) => repo.read(`.harness-state/tickets/T001/relecture-${n}.md`);
  assert.equal(report(1), "VERDICT : à corriger\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\n- constat");
  assert.equal(report(2), "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre\nRien à signaler.");
  assert.equal(report(3), "Le diff me semble correct.");
  assert.throws(() => report(4), { code: "ENOENT" });
});

const acceptedReport = "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre";
const correctionPrompt = "Fais une relecture de correction.\nLis relecture-1.md et revue-2.interdiff.";

for (const form of ["handbackReport", "content"]) {
  for (const [count, expected] of [["1", "à corriger"], [null, "à corriger"], ["inconnu", "à corriger"], ["0", "accepté"]]) {
    test(`the review hook enforces the explicit correction count and preserves the ${form} report: ${count}`, (t) => {
      const repo = harnessRepo();
      t.after(repo.cleanup);
      const report = acceptedReport + (count === null ? "" : `\nNON CORRIGÉS : ${count}`) + "\nDétail intégral du rapport.\n";
      const response = form === "handbackReport" ? { handbackReport: { text: report } } : { content: [{ type: "text", text: report }] };
      response.resolvedModel = "claude-opus-5-5";
      const input = { tool_input: { subagent_type: "relecteur", prompt: correctionPrompt }, tool_response: response };
      hook(repo, "record-review", input, LOOP);
      const dir = ".harness-state/tickets/T001/";
      const entry = JSON.parse(repo.read(dir + "relectures.jsonl"));
      assert.equal(entry.verdict, expected);
      assert.equal(entry.modele, "claude-opus-5-5");
      assert.equal(repo.read(dir + "relecture-1.md"), report);
    });
  }
}

for (const [report, expected] of [
  ["Rapport illisible.", "illisible"],
  ["VERDICT : accepté\nCONSTATS : illisibles", "illisible"],
  ["VERDICT : accepté\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre", "à corriger"],
  ["VERDICT : accepté\nCONSTATS : 0 bloquant, 1 mineur, 0 hors périmètre", "à corriger"],
]) {
  test(`a resolved correction cannot accept invalid verdicts or counted findings: ${report}`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    hook(repo, "record-review", {
      tool_input: { subagent_type: "relecteur", prompt: correctionPrompt },
      tool_response: { handbackReport: { text: report + "\nNON CORRIGÉS : 0" } },
    }, LOOP);
    assert.equal(JSON.parse(repo.read(".harness-state/tickets/T001/relectures.jsonl")).verdict, expected);
  });
}

for (const mode of [LOOP, TUNE]) {
  test(`a complete review after an earlier report ignores its rank, interdiff and response count: ${mode.HARNESS_TICKET}`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    const dir = `.harness-state/tickets/${mode.HARNESS_TICKET}/`;
    repo.write(dir + "reviewed-state.json", JSON.stringify({ revue: "revue-3.diff", fichiers: {} }));
    repo.write(dir + "relectures.jsonl", JSON.stringify({ verdict: "à corriger" }) + "\n");
    repo.write(dir + "revue-3.interdiff", "old interdiff");
    for (const suffix of ["", "\nNON CORRIGÉS : 1"]) {
      hook(repo, "record-review", {
        tool_input: { subagent_type: "relecteur", prompt: "Fais une relecture complète. Lis revue-3.diff et revue-3.interdiff." },
        tool_response: { handbackReport: { text: acceptedReport + suffix } },
      }, mode);
    }
    const entries = repo.read(dir + "relectures.jsonl").trim().split("\n").map(JSON.parse);
    assert.deepEqual(entries.map(entry => entry.verdict), ["à corriger", "accepté", "accepté"]);
  });
}

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

const patch = (repo, command, env = LOOP) => hook(repo, "guard-write", {
  tool_name: "apply_patch", cwd: repo.root, tool_input: { command },
}, env);

test("after a Codex patch every JavaScript destination is checked, including moved files", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "module.exports = 1;\n" });
  t.after(repo.cleanup);
  const edit = (command) => hook(repo, "after-edit", {
    cwd: repo.root, tool_name: "apply_patch", tool_input: { command },
  }, { ...INTERACTIVE, CLAUDE_PROJECT_DIR: "" });
  const command = "*** Begin Patch\n*** Update File: core/a.cjs\n*** Add File: core/b.js\n*** End Patch";
  repo.write("core/b.js", "const b = '" + "x".repeat(170) + "';\n");
  assert.match(edit(command)?.reason || "", /core\/b\.js.*[\s\S]*160 caractères/);
  repo.write("core/b.js", "module.exports = 2;\n");
  assert.equal(edit(command), null);
  repo.write("core/moved.mjs", "const b = '" + "x".repeat(170) + "';\n");
  const move = "*** Begin Patch\n*** Update File: core/gone.mjs\n  *** Move to: core/moved.mjs\n*** End Patch";
  assert.match(edit(move)?.reason || "", /core\/moved\.mjs/);
  repo.write("notes.md", "x".repeat(170));
  assert.equal(edit("*** Begin Patch\n*** Add File: notes.md\n*** End Patch"), null);
});

test("after a Codex patch non-JavaScript files bypass a failing formatter while JavaScript files are reported", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const repo = harnessRepo({ "notes.md": "notes\n", "core/a.cjs": "module.exports = 1;\n" });
  t.after(repo.cleanup);
  repo.write("node_modules/.bin/prettier", "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(repo.root, "node_modules/.bin/prettier"), 0o755);
  const edit = (file) => hook(repo, "after-edit", {
    cwd: repo.root, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` },
  }, { ...INTERACTIVE, CLAUDE_PROJECT_DIR: "" });
  assert.equal(edit("notes.md"), null);
  const reported = edit("core/a.cjs");
  assert.equal(reported?.decision, "block");
  assert.match(reported.reason, /core\/a\.cjs/);
});

test("Codex Stop accepts cwd and stop_hook_active while enforcing the verdict and quality gate", (t) => {
  const repo = harnessRepo({ "core/a.cjs": "module.exports = 1;\n" });
  t.after(repo.cleanup);
  const stop = (session, active = false) => hook(repo, "stop-gate", {
    cwd: repo.root, session_id: session, hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: "Fait.",
  }, { ...LOOP, HARNESS_ENGINE: "codex", CLAUDE_PROJECT_DIR: "" });
  assert.equal(stop("codex").decision, "block");
  assert.match(stop("codex", true).reason, /Aucun verdict/);
  repo.write(".harness-state/tickets/T001/verdict.json", JSON.stringify({ statut: "BLOQUÉ", resume: "décision attendue" }));
  assert.equal(stop("blocked", true), null);
  repo.write(".harness-state/tickets/T001/verdict.json", JSON.stringify({ statut: "TERMINÉ", resume: "fait" }));
  repo.write("core/a.cjs", "module.exports = '" + "x".repeat(170) + "';\n");
  assert.match(stop("red").reason, /TERMINÉ mais le contrôle qualité est rouge/);
});

test("the Codex start hook gives its skill and records its session and launch, while Claude keeps the ticket skill", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const input = { cwd: repo.root, session_id: "codex-start", hook_event_name: "SessionStart" };
  const output = hook(repo, "session-context", input, {
    ...LOOP, HARNESS_ENGINE: "codex", HARNESS_HOOK_RUN: "launch-1", CLAUDE_PROJECT_DIR: "",
  });
  assert.ok(output.hookSpecificOutput.additionalContext.includes(".agents/skills/ticket-codex/SKILL.md"));
  assert.deepEqual(JSON.parse(repo.read(".harness-state/tickets/T001/hooks-started.json")), { session: "codex-start", run: "launch-1" });
  const claude = hook(repo, "session-context", input, LOOP).hookSpecificOutput.additionalContext;
  assert.match(claude, /skill ticket/);
  assert.doesNotMatch(claude, /ticket-codex/);
});

for (const [name, engine, claudeRoot, skill] of [
  ["Codex interactive", "", "", ".agents/skills/ticket-codex/SKILL.md"],
  ["Claude interactive", "", "project", "ticket"],
  ["Codex explicit", "codex", "project", ".agents/skills/ticket-codex/SKILL.md"],
  ["OpenCode, whose plugin gives the project root", "opencode", "project", ".agents/skills/ticket-opencode/SKILL.md"],
  ["OpenCode without a project root", "opencode", "", ".agents/skills/ticket-opencode/SKILL.md"],
]) {
  test(`the startup and missing verdict messages name the receiving engine skill: ${name}`, (t) => {
    const repo = harnessRepo();
    t.after(repo.cleanup);
    const env = { HARNESS_ENGINE: engine, CLAUDE_PROJECT_DIR: claudeRoot ? repo.root : "" };
    const input = { cwd: repo.root, session_id: "engine-skill" };
    const context = hook(repo, "session-context", input, { ...INTERACTIVE, ...env }).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`skill ${skill}`), context);
    const loopContext = hook(repo, "session-context", input, { ...LOOP, ...env }).hookSpecificOutput.additionalContext;
    assert.ok(loopContext.includes(`skill ${skill}`), loopContext);
    const stopped = hook(repo, "stop-gate", input, { ...LOOP, ...env });
    assert.equal(stopped.decision, "block");
    assert.ok(stopped.reason.includes(`skill ${skill}`), stopped.reason);
    if (skill === "ticket") {
      assert.doesNotMatch(context, /ticket-codex/);
      assert.doesNotMatch(stopped.reason, /ticket-codex/);
    }
  });
}

test("a Codex patch is refused as a whole when any source or move destination belongs to the harness", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const body of [
    "*** Update File: scripts/check.mjs",
    "*** Add File: .codex/hooks.json",
    "*** Add File: .agents/skills/example/SKILL.md",
    "*** Update File: AGENTS.md",
    "*** Update File: core/session.cjs\n@@\n-old\n+new\n*** Delete File: scripts/loop/run.mjs",
    "*** Update File: core/session.cjs\n*** Move to: .codex/hooks.json",
  ]) assert.equal(decision(patch(repo, `*** Begin Patch\n${body}\n*** End Patch`)), "deny", body);
  assert.equal(decision(patch(repo, "*** Begin Patch\n*** Add File: core/greeting.cjs\n+hello\n*** End Patch")), "none");
});

test("Codex loads the shared instructions through a symlink and runs both configured guards without a Claude root variable", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..", "..");
  const agents = path.join(root, "AGENTS.md");
  assert.ok(fs.existsSync(agents), "Codex must find the shared instructions");
  assert.equal(fs.lstatSync(agents).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(agents), fs.realpathSync(path.join(root, "CLAUDE.md")));
  const hooksFile = path.join(root, ".codex/hooks.json");
  assert.ok(fs.existsSync(hooksFile), "Codex must load its project hooks");
  const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  const entries = config.hooks.PreToolUse;
  assert.equal(entries.length, 2);
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const [tool, tool_input] of [
    ["apply_patch", { command: "*** Begin Patch\n*** Update File: scripts/check.mjs\n*** End Patch" }],
    ["Edit", { file_path: "scripts/check.mjs" }],
    ["Write", { file_path: "scripts/check.mjs" }],
    ["Bash", { command: "git commit -m forbidden" }],
  ]) {
    const matching = entries.filter(entry => new RegExp(`^(?:${entry.matcher})$`).test(tool));
    assert.equal(matching.length, 1, tool);
    const result = repo.run("sh", ["-c", matching[0].hooks[0].command], {
      input: JSON.stringify({ cwd: repo.root, tool_name: tool, tool_input }), env: LOOP,
    });
    assert.equal(result.code, 0, result.out);
    assert.equal(decision(JSON.parse(result.stdout)), "deny", tool);
  }
});

test("indented Codex patch markers still enforce every path rule", (t) => {
  const repo = harnessRepo();
  t.after(repo.cleanup);
  for (const body of [
    "  *** Update File: scripts/check.mjs",
    "\t*** Add File: .codex/hooks.json",
    "  *** Update File: core/session.cjs\n \t*** Move to: scripts/loop/run.mjs",
    "  *** Update File: docs/travail/tickets/002-other.md",
    "  *** Add File: tests/review-regressions.test.cjs",
  ]) assert.equal(decision(patch(repo, `*** Begin Patch\n${body}\n*** End Patch`)), "deny", body);
  assert.equal(decision(patch(repo, "*** Begin Patch\n  *** Add File: core/greeting.cjs\n+hello\n*** End Patch")), "none");
});

test("Codex declares all six shared lifecycle hooks with executable commands independent of Claude", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..", "..");
  const config = JSON.parse(fs.readFileSync(path.join(root, ".codex/hooks.json"), "utf8"));
  const repo = harnessRepo();
  t.after(repo.cleanup);
  const expected = {
    SessionStart: ["session-context"], PreToolUse: ["guard-bash", "guard-write"], PostToolUse: ["after-edit"],
    PreCompact: ["record-compaction"], Stop: ["stop-gate"],
  };
  assert.deepEqual(Object.keys(config.hooks).sort(), Object.keys(expected).sort());
  for (const [event, names] of Object.entries(expected)) {
    const entries = config.hooks[event];
    const commands = entries.flatMap(entry => entry.hooks.map(handler => handler.command));
    assert.equal(commands.length, names.length);
    for (const name of names) assert.ok(commands.some(command => command.includes(`/${name}.mjs`)), event);
    for (const command of commands) {
      assert.doesNotMatch(command, /CLAUDE_PROJECT_DIR/);
      const result = repo.run("sh", ["-c", command], {
        input: JSON.stringify({ cwd: repo.root, hook_event_name: event, session_id: "config-check" }), env: INTERACTIVE,
      });
      assert.equal(result.code, 0, result.out);
    }
  }
  for (const tool of ["apply_patch", "Edit", "Write"]) {
    assert.equal(config.hooks.PostToolUse.filter(entry => new RegExp(`^(?:${entry.matcher})$`).test(tool)).length, 1, tool);
  }
});
