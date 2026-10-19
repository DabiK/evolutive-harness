const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { harnessRepo } = require("./helpers/harness-repo.cjs");
const { CODEX_SESSION, CAPACITY_EVENTS, QUOTA_EVENTS, STARTUP_WARNING_EVENTS } = require("./helpers/codex-session.cjs");

const tickets = () => import(pathToFileURL(path.join(__dirname, "..", "..", "scripts/loop/tickets.mjs")).href);
const tuning = () => import(pathToFileURL(path.join(__dirname, "..", "..", "scripts/loop/tune.mjs")).href);

function ticketText(fields = {}, body = "") {
  const meta = { id: "T001", titre: "Add the greeting", statut: "a-faire", bloque_par: "", adr: "non", ...fields };
  const header = Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n");
  const criteria = "## Critères d'acceptation\n\n1. The greeting says hello.\n";
  return `---\n${header}\n---\n\n${criteria}${body}\n## Journal\n\n`;
}

// Section « Hypothèses bloquantes » d'un ticket, suivie d'une autre section qui n'en fait pas partie.
const assumptions = (text) => `\n## Hypothèses bloquantes\n\n${text}\n\n## Notes\n\nNot part of the assumptions.\n`;
const asksOwner = assumptions("Décision attendue du propriétaire : which CI\nprovider,   and when?");

// Fausse session Claude Code : joue un scénario écrit d'avance au lieu d'appeler un modèle.
const FAKE_SESSION = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const id = process.env.HARNESS_TICKET;
const dir = path.join(".harness-state", "tickets", id);
fs.mkdirSync(dir, { recursive: true });
const argument = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
if (argument("--agent") === "relecteur") {
  const calls = path.join(dir, "fake-review-calls");
  const rank = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\\n").length : 0;
  const call = {
    args: process.argv.slice(2), prompt: argument("-p"), model: argument("--model"),
    loop: process.env.HARNESS_LOOP ?? null, engine: process.env.HARNESS_ENGINE ?? null,
  };
  fs.appendFileSync(calls, JSON.stringify(call) + "\\n");
  const accepted = "VERDICT : accepté\\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre";
  const reports = JSON.parse(process.env.FAKE_REVIEWS || "null");
  let report = reports?.[rank] || accepted;
  if (/relecture de correction/i.test(call.prompt) && !/^NON CORRIGÉS\\s*:/m.test(report) && process.env.FAKE_UNCORRECTED !== "missing") {
    const count = process.env.FAKE_UNCORRECTED ?? "0";
    report = report.replace(/^(CONSTATS[^\\n]*)/m, "$1\\nNON CORRIGÉS : " + count);
  }
  const failure = process.env.FAKE_REVIEW_FAILURE;
  console.log(JSON.stringify({ type: "result", is_error: failure === "error", result: (failure ? "\\n" : "") + report }));
  process.exit(failure === "exit" ? 1 : 0);
}
// Rétrospective : une session courte en lecture seule qui rend des observations structurées.
if (process.env.HARNESS_RETRO === "1") {
  const call = { model: argument("--model"), tools: argument("--tools"), loop: process.env.HARNESS_LOOP ?? null, prompt: argument("-p") };
  fs.writeFileSync(path.join(dir, "fake-retro-call"), JSON.stringify(call));
  if (process.env.FAKE_RETRO === "fail") process.exit(1);
  const observation = { sujet: "reviewer", constat: "found", preuve: "session-1.jsonl", proposition: "keep", cible: "agent", impact: "moyen" };
  const problem = { type: "probleme", ...observation, cible: process.env.FAKE_RETRO_TARGET || "boucle", impact: "fort" };
  const observations = [{ type: "bien", ...observation }, problem];
  console.log(JSON.stringify({ type: "result", total_cost_usd: 0.2, structured_output: { observations } }));
  process.exit(0);
}
const plan = { model: argument("--model"), effort: argument("--effort"), review: process.env.HARNESS_REVIEW_MODEL ?? null };
fs.writeFileSync(path.join(dir, "fake-name"), String(argument("--name")));
fs.appendFileSync(path.join(dir, "fake-plans"), JSON.stringify(plan) + "\\n");
const counter = path.join(dir, "fake-attempts");
const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(attempt));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const verdict = (statut, extra = {}) => write(path.join(dir, "verdict.json"), JSON.stringify({ statut, resume: "fake", ...extra }));
const greeting = () => write("core/greeting.cjs", "module.exports = () => 'hello';\\n");
const { spawnSync } = require("node:child_process");
// Enregistre l'état relu comme le fait l'orchestrateur avant chaque relecture ; sortie capturée, hors du flux de la session.
const record = () => {
  const result = spawnSync(process.execPath, ["scripts/loop/reviewed-state.mjs", "record"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("record failed: " + result.stdout + result.stderr);
};
// Le relecteur rend la main : Claude Code passe son rapport au hook qui en enregistre le verdict.
const handBack = (text, prompt = "Fais une relecture complète.") => {
  const input = { tool_name: "Agent", tool_input: { subagent_type: "relecteur", prompt },
    tool_response: { handbackReport: { text }, resolvedModel: "claude-opus-5-5" } };
  const result = spawnSync(process.execPath, [".claude/hooks/record-review.mjs"], { input: JSON.stringify(input), encoding: "utf8" });
  if (result.status !== 0) throw new Error("review hook failed: " + result.stdout + result.stderr);
};
const review = (text = "VERDICT : accepté\\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre") => {
  record();
  handBack(text);
};
// Harmonisation des consignes : la session lit les observations retenues par la boucle, puis joue FAKE_TUNE.
if (process.env.HARNESS_TUNE === "1") {
  const names = ["LOOP", "TICKET", "TICKET_FILE", "TUNE", "EDIT", "EDIT_SCOPE", "REVIEW_MODEL", "ALLOW_INSTALL"].map((n) => "HARNESS_" + n);
  const call = { env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])), prompt: argument("-p") };
  write(path.join(dir, "fake-tune-call"), JSON.stringify(call));
  const ids = JSON.parse(fs.readFileSync(process.env.HARNESS_TICKET_FILE, "utf8")).map((o) => o.id);
  const listed = (name) => (process.env[name] || "").split(",").filter(Boolean);
  const deferred = (list) => list.map((id) => ({ id, raison: "it would loosen a check" }));
  const tuned = () => {
    const handled = [...ids.filter((id) => !listed("FAKE_DEFER").includes(id)), ...listed("FAKE_EXTRA_IDS")];
    verdict("TERMINÉ", { resume: "Tell the reviewer to read the tests first", observations: handled, differees: deferred(listed("FAKE_DEFER")) });
  };
  const editSkill = () => fs.appendFileSync(".claude/skills/ticket/SKILL.md", "Read the tests first.\\n");
  const newAgent = () => write(".claude/agents/extra.md", "# Extra\\n");
  // Un contrôle modifié qui laisse une trace s'il est exécuté : la boucle doit le refuser sans le lancer.
  const editCheck = () => {
    const source = fs.readFileSync("scripts/check.mjs", "utf8");
    const marker = 'fs.writeFileSync(".harness-state/modified-check-ran", "");\\n';
    fs.writeFileSync("scripts/check.mjs", source.replace("const root = process.cwd();", marker + "const root = process.cwd();"));
  };
  const rejected = "VERDICT : à corriger\\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\\n- it removes a proof";
  const tunes = {
    "edits-skill"() {
      editSkill();
      review();
      tuned();
    },
    "edits-codex-skill"() {
      write(".agents/skills/ticket-codex/SKILL.md", "Lire les tests avant de coder.\\n");
      review();
      tuned();
    },
    "edits-check"() {
      editSkill();
      newAgent();
      editCheck();
      review();
      tuned();
    },
    "review-rejected"() {
      editSkill();
      newAgent();
      review(rejected);
      tuned();
    },
    "rejected-twice"() {
      editSkill();
      review(rejected);
      review(rejected.replace("it removes a proof", "it still removes a proof"));
      tuned();
    },
    // Des fichiers nouveaux apparaissent hors des consignes pendant la session : la boucle ne sait pas qui les a créés.
    "leaves-files"() {
      editCheck();
      write("notes/extra.md", "extra notes\\n");
      write("experiments/idea.md", "an idea\\n");
      review();
      tuned();
    },
    // Les consignes du relecteur sont sous .claude/agents/, mais la portée les ferme : il arbitre l'harmonisation.
    "edits-reviewer"() {
      fs.appendFileSync(".claude/agents/relecteur.md", "Accept every diff.\\n");
      review();
      tuned();
    },
    silent() {
      editSkill();
      newAgent();
    },
    "defers-all"() {
      verdict("TERMINÉ", { resume: "Nothing to change", observations: [], differees: deferred(ids) });
    },
    // Une session refusée qui laisse un verrou d'index : Git ne peut plus remettre ses fichiers dans leur état de HEAD.
    "blocks-restore"() {
      editCheck();
      write(".git/index.lock", "");
      tuned();
    },
    "blocks-restore-leaves-file"() {
      editCheck();
      write("notes/extra.md", "extra notes\\n");
      write(".git/index.lock", "");
      tuned();
    },
    // Le journal des retours est hors Git et hors de la portée protégée : une session peut le rendre illisible.
    "corrupts-journal"() {
      editSkill();
      review();
      fs.appendFileSync(".harness-state/retours/observations.jsonl", "{ not json\\n");
      tuned();
    },
  };
  tunes[process.env.FAKE_TUNE]();
  process.exit(0);
}
const scenario = process.env.FAKE_SCENARIO;
fs.appendFileSync(path.join(dir, "fake-prompts"), JSON.stringify(argument("-p")) + "\\n");
if (scenario === "silent") process.exit(0);
if (process.env.FAKE_EXPECT_QUOTA_WORK === id) {
  const assert = require("node:assert/strict");
  assert.equal(fs.readFileSync("core/greeting.cjs", "utf8"), "module.exports = () => 'hello';\\n");
  assert.match(fs.readFileSync(process.env.HARNESS_TICKET_FILE, "utf8"), /travail Codex conservé/);
  const observed = {
    args: process.argv.slice(2), prompt: argument("-p"), pid: process.ppid,
    lock: fs.readFileSync(".harness-state/loop/lock", "utf8"),
    launchedAt: fs.statSync(".harness-state/loop/lock").mtimeMs,
    diff: spawnSync("git", ["diff", "HEAD"], { encoding: "utf8" }).stdout,
    partial: fs.readFileSync("core/partial.cjs", "utf8"),
    exclusions: JSON.parse(fs.readFileSync(path.join(dir, "untracked-before.json"), "utf8")),
    window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, engine: process.env.HARNESS_ENGINE ?? null,
  };
  write(path.join(dir, "fallback-observed.json"), JSON.stringify(observed));
}
fs.appendFileSync(process.env.HARNESS_TICKET_FILE, "- jalon : attempt " + attempt + "\\n");
if (process.env.FAKE_CLAUDE_STAGE) {
  const staged = spawnSync("git", ["add", "--", process.env.FAKE_CLAUDE_STAGE]);
  if (staged.status !== 0) throw new Error("fake staging failed");
}
const scenarios = {
  "stop-worker"() {
    process.kill(process.ppid, process.env.FAKE_WORKER_SIGNAL);
    process.exit(0);
  },
  "reload-module"() {
    write(path.join(dir, "loop-observed.json"), JSON.stringify({
      pid: process.ppid, lock: fs.readFileSync(".harness-state/loop/lock", "utf8"), plan,
      args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.FAKE_MARKER,
      window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    }));
    if (id === "T001") {
      const file = process.env.FAKE_RELOAD_MODULE;
      if (file === "scripts/loop/models.mjs") {
        write(file, fs.readFileSync(file, "utf8").replaceAll("claude-sonnet-5-5", "fresh model with spaces"));
        if (process.env.FAKE_RELOAD_APPEND) fs.appendFileSync(file, process.env.FAKE_RELOAD_APPEND);
      } else {
        fs.appendFileSync(file, process.env.FAKE_RELOAD_APPEND || "\\n// Une documentation sans effet.\\n");
      }
    }
    if (id === "T002" && process.env.FAKE_HOLD_SECOND === "1") {
      process.kill(process.ppid, "SIGSTOP");
      write(".harness-state/second-ready", String(process.ppid));
      process.kill(Number(process.env.FAKE_OBSERVER_PID), "SIGWINCH");
    }
    if (process.env.FAKE_OBSERVER_PID) process.stderr.write(id + " agent stderr\\n");
    greeting();
    review();
    if (["1", id].includes(process.env.FAKE_RELOAD_AFTER_REVIEW)) write("core/greeting.cjs", "module.exports = 'changed';\\n");
    verdict("TERMINÉ");
  },
  done() {
    greeting();
    review();
    verdict("TERMINÉ");
  },
  "done-with-reserves"() {
    greeting();
    review();
    verdict("TERMINÉ", { reste: JSON.parse(process.env.FAKE_RESERVES) });
  },
  "long-line"() {
    write("core/greeting.cjs", "module.exports = '" + "x".repeat(200) + "';\\n");
    review();
    verdict("TERMINÉ");
  },
  "edits-criteria"() {
    const file = process.env.HARNESS_TICKET_FILE;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("says hello", "exists"));
    review();
    verdict("TERMINÉ");
  },
  "edits-harness"() {
    fs.appendFileSync("scripts/check.mjs", "\\n// weakened\\n");
    review();
    verdict("TERMINÉ");
  },
  "deletes-test"() {
    fs.rmSync("tests/sample.test.cjs");
    review();
    verdict("TERMINÉ");
  },
  "deletes-colocated-test"() {
    fs.rmSync("core/greeting.test.cjs");
    review();
    verdict("TERMINÉ");
  },
  "edits-config"() {
    fs.appendFileSync("harness.config.mjs", "// suites removed\\n");
    review();
    verdict("TERMINÉ");
  },
  blocked() {
    verdict("BLOQUÉ", { resume: "the ticket contradicts the code" });
  },
  "partial-then-done"() {
    greeting();
    review();
    verdict(attempt === 1 ? "PARTIEL" : "TERMINÉ", { reste: ["tests"] });
  },
  "partial-then-failure"() {
    if (attempt === 1) verdict("PARTIEL", { reste: ["tests"] });
    else process.exitCode = 1;
  },
  "with-adr"() {
    write("docs/adr/0011-greeting.md", "# 0011\\n");
    review();
    verdict("TERMINÉ");
  },
  compacts() {
    greeting();
    review();
    verdict("TERMINÉ");
    fs.appendFileSync(path.join(dir, "compactions.jsonl"), JSON.stringify({ trigger: "auto" }) + "\\n");
    write(path.join(dir, "fake-window"), String(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW));
    const reviewer = { agentType: "relecteur", resolvedModel: "claude-opus-5-5", totalTokens: 900, totalToolUseCount: 7, totalDurationMs: 4000 };
    console.log(JSON.stringify({ type: "user", tool_use_result: reviewer }));
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
    const modelUsage = { "claude-sonnet-5-5": { costUSD: 0.301 }, "claude-opus-5-5": { costUSD: 0.199 } };
    const denials = [{ tool_name: "Bash", tool_input: { command: "git commit" } }];
    const result = { session_id: "s1", num_turns: 12, duration_ms: 3400, total_cost_usd: 0.5, usage, modelUsage, permission_denials: denials };
    console.log(JSON.stringify({ type: "result", ...result }));
  },
  narrates() {
    const say = (content, parent = null) => console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content } }));
    say([{ type: "text", text: "Je lis le ticket." }, { type: "tool_use", name: "Read", input: { file_path: path.resolve(process.env.HARNESS_TICKET_FILE) } }]);
    say([{ type: "tool_use", name: "Agent", input: { subagent_type: "explorateur", description: "Explore greeting" } }]);
    say([{ type: "tool_use", name: "Grep", input: { pattern: "hello" } }], "toolu_1");
    console.log("not json");
    greeting();
    say([{ type: "tool_use", name: "Bash", input: { command: "node scripts/check.mjs --changed", description: "Run the changed-files check" } }]);
    review();
    verdict("TERMINÉ");
    console.log(JSON.stringify({ type: "result", session_id: "s2", num_turns: 4, duration_ms: 1000, total_cost_usd: 0.1, usage: {} }));
  },
  "changes-after-review"() {
    greeting();
    review();
    write("core/greeting.cjs", "module.exports = () => 'hi';\\n");
    verdict("TERMINÉ");
  },
  "done-without-review"() {
    greeting();
    verdict("TERMINÉ");
  },
  "journals-after-review"() {
    greeting();
    review();
    fs.appendFileSync(process.env.HARNESS_TICKET_FILE, "- jalon : review accepted\\n");
    verdict("TERMINÉ");
  },
  "edits-untracked-after-review"() {
    greeting();
    review();
    for (const name of fs.readdirSync("notes")) fs.appendFileSync(path.join("notes", name), "changed after the review\\n");
    verdict("TERMINÉ");
  },
  "corrupts-review"() {
    greeting();
    review();
    write(path.join(dir, "reviewed-state.json"), "{ not json");
    verdict("TERMINÉ");
  },
  "corrupts-untracked-list"() {
    greeting();
    review();
    write(path.join(dir, "untracked-before.json"), "{ not json");
    verdict("TERMINÉ");
  },
  "changes-untracked-list"() {
    greeting();
    const file = path.join(dir, "untracked-before.json");
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    if (process.env.FAKE_UNTRACKED_CHANGE === "add") before.push("core/greeting.cjs");
    if (process.env.FAKE_UNTRACKED_CHANGE === "remove") before.pop();
    write(file, JSON.stringify(before));
    if (process.env.FAKE_UNTRACKED_CHANGE === "delete") fs.rmSync(file);
    review();
    verdict("TERMINÉ");
  },
  "rejected-then-complete"() {
    greeting();
    review(attempt === 1 ? "VERDICT : à corriger\\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre" : undefined);
    verdict(attempt === 1 ? "PARTIEL" : "TERMINÉ");
  },
  "reviewed-then-partial"() {
    greeting();
    if (attempt === 1) review();
    verdict(attempt === 1 ? "PARTIEL" : "TERMINÉ", { reste: ["check"] });
  },
  "review-rejected"() {
    greeting();
    review("VERDICT : à corriger\\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\\n- the greeting is untested");
    verdict("TERMINÉ");
  },
  "reviewed-twice"() {
    greeting();
    review("VERDICT : à corriger\\nCONSTATS : 0 bloquant, 1 mineur, 0 hors périmètre\\n- name the greeting");
    review();
    verdict("TERMINÉ");
  },
  "correction-review"() {
    greeting();
    review("VERDICT : à corriger\\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre");
    record();
    const count = process.env.FAKE_UNCORRECTED;
    const report = "VERDICT : accepté\\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre" +
      (count === "missing" ? "" : "\\nNON CORRIGÉS : " + count);
    handBack(report, "Fais une relecture de correction.\\nLis relecture-1.md et revue-2.interdiff.");
    verdict("TERMINÉ");
  },
  "review-stale"() {
    greeting();
    review();
    fs.appendFileSync("core/greeting.cjs", "// reworded\\n");
    record();
    verdict("TERMINÉ");
  },
  "removes-empty-catch"() {
    write("core/legacy.cjs", "module.exports = 1;\\n");
    review();
    verdict("TERMINÉ");
  },
  "adds-test-case"() {
    fs.appendFileSync(process.env.FAKE_TEST_FILE, "test('an added case', () => {});\\n");
    review();
    verdict("TERMINÉ");
  },
  "migrates-test-measures"() {
    if (process.env.HARNESS_EDIT !== "1") throw new Error("harness permission required");
    fs.copyFileSync(".harness-state/current-metrics.mjs", "scripts/quality/metrics.mjs");
    write("scripts/quality/baseline.json", process.env.FAKE_MIGRATED_BASELINE);
    fs.appendFileSync("tests/sample.test.cjs", "test('an added case', () => {});\\n");
    review();
    verdict("TERMINÉ");
  },
};
scenarios[scenario]();
if (process.env.FAKE_CLAUDE_FAILURE === "1") process.exitCode = 1;
`;

// Réutiliser les scripts immuables évite le coût du premier lancement de chaque copie sur macOS.
// Chaque appel garde un processus neuf et écrit seulement dans le dépôt propre à son scénario.
const fakeAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fake-agents-"));
after(() => fs.rmSync(fakeAgentDir, { recursive: true, force: true }));
for (const [name, source] of [["claude", FAKE_SESSION], ["codex", CODEX_SESSION]]) {
  fs.writeFileSync(path.join(fakeAgentDir, `${name}.cjs`), source, { mode: 0o555 });
}

function linkFakeAgent(repo, name) {
  const bin = path.join(repo.root, ".harness-state", `fake-${name}.cjs`);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(fakeAgentDir, `${name}.cjs`), bin);
  return bin;
}

function loopRepo(scenarioFiles = {}) {
  const repo = harnessRepo({ "docs/travail/tickets/001-add-greeting.md": ticketText(), ...scenarioFiles });
  const bin = linkFakeAgent(repo, "claude");
  const loop = (scenario, args = [], env = {}) =>
    repo.node("scripts/loop/run.mjs", ["--no-push", ...args], { env: { HARNESS_CLAUDE_BIN: bin, FAKE_SCENARIO: scenario, ...env } });
  const status = () => /^statut: (.*)$/m.exec(repo.read("docs/travail/tickets/001-add-greeting.md"))[1];
  const commits = () => repo.git("log", "--format=%s").stdout.trim().split("\n");
  const failure = () => repo.read(".harness-state/tickets/T001/echec-1.txt");
  const attempts = () => repo.read(".harness-state/tickets/T001/fake-attempts");
  const plans = () => repo.read(".harness-state/tickets/T001/fake-plans").trim().split("\n").map((line) => JSON.parse(line));
  const events = () => repo.read(".harness-state/loop/events.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  return { ...repo, loop, status, commits, failure, attempts, plans, events };
}

test("the next ticket is the first one to do whose blockers are all finished", async () => {
  const { describe, next } = await tickets();
  const queue = [
    describe("001.md", ticketText({ id: "T001", statut: "termine" })),
    describe("002.md", ticketText({ id: "T002", bloque_par: "T003" })),
    describe("003.md", ticketText({ id: "T003", bloque_par: "T001" })),
  ];
  assert.equal(next(queue).ticket.id, "T003");
  assert.match(next(queue, "T002").reason, /T002 n'est pas prêt/);
});

test("a ticket gives the question it still waits on when its blocking assumptions start by asking the owner", async () => {
  const { describe } = await tickets();
  const waitsOn = (body) => describe("001.md", ticketText({}, body)).decisionAttendue;
  assert.equal(waitsOn(asksOwner), "which CI provider, and when?");
  assert.equal(waitsOn(assumptions("Aucune décision n'est attendue. Décision attendue du propriétaire : none.")), "");
  assert.equal(waitsOn(assumptions("Decided by the owner: GitHub Actions, on main only.")), "");
  assert.equal(waitsOn(""), "");
});

test("a ticket that still waits for an owner decision is never started, and the tickets that do not depend on it go on", async () => {
  const { describe, next } = await tickets();
  const finished = describe("000.md", ticketText({ id: "T000", statut: "termine" }));
  const waiting = describe("001.md", ticketText({ id: "T001", bloque_par: "T000" }, asksOwner));
  assert.equal(next([finished, waiting]).ticket, undefined);
  const unwritten = describe("001.md", ticketText({ id: "T001" }, assumptions("Décision attendue du propriétaire :")));
  assert.equal(next([unwritten]).ticket, undefined);
  const dependent = describe("002.md", ticketText({ id: "T002", bloque_par: "T001" }));
  const independent = describe("003.md", ticketText({ id: "T003", bloque_par: "T000" }));
  assert.equal(next([finished, waiting, dependent, independent]).ticket.id, "T003");
  for (const decided of ["Aucune décision n'est attendue.", "Decided by the owner: GitHub Actions, on main only."]) {
    const ready = describe("001.md", ticketText({ id: "T001", bloque_par: "T000" }, assumptions(decided)));
    assert.equal(next([finished, ready, dependent]).ticket.id, "T001", decided);
  }
  const finishedStillAsking = describe("004.md", ticketText({ id: "T004", statut: "termine" }, asksOwner));
  assert.match(next([finished, finishedStillAsking], "T004").reason, /T004 n'est pas prêt \(statut « termine »/);
});

test("when only tickets waiting for a decision, or tickets that depend on them, are left, the loop names the ones waiting", async () => {
  const { describe, next } = await tickets();
  const queue = [
    describe("001.md", ticketText({ id: "T001", statut: "termine" })),
    describe("002.md", ticketText({ id: "T002" }, asksOwner)),
    describe("003.md", ticketText({ id: "T003", bloque_par: "T002" })),
    describe("004.md", ticketText({ id: "T004", bloque_par: "T001" }, asksOwner)),
  ];
  const { ticket, reason } = next(queue);
  assert.equal(ticket, undefined);
  assert.match(reason, /attendent une décision du propriétaire : T002, T004\./);
});

test("a ticket in progress or blocked stops the queue until someone decides", async () => {
  const { describe, next } = await tickets();
  const queue = [describe("001.md", ticketText({ id: "T001", statut: "bloque" })), describe("002.md", ticketText({ id: "T002" }))];
  assert.match(next(queue).reason, /T001 est « bloque »/);
});

test("a malformed queue is reported: duplicate id, unknown blocker, unknown status", async () => {
  const { describe, validate } = await tickets();
  const problems = validate([
    describe("001.md", ticketText({ id: "T001" })),
    describe("002.md", ticketText({ id: "T001", bloque_par: "T009", statut: "fini" })),
  ]);
  assert.equal(problems.length, 3, problems.join("\n"));
});

test("a ticket whose level is not on the ladder is reported", async () => {
  const { describe, validate } = await tickets();
  const problems = validate([describe("001.md", ticketText({ niveau: "urgent" })), describe("002.md", ticketText({ id: "T002", niveau: "critique" }))]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /niveau « urgent » inconnu/);
});

test("the protected part of a ticket ignores its status and its journal, and nothing else", async () => {
  const { setStatus, spec } = await tickets();
  const text = ticketText();
  assert.equal(spec(setStatus(text, "en-cours") + "- jalon\n"), spec(text));
  assert.notEqual(spec(text.replace("says hello", "exists")), spec(text));
});

test("a ticket whose session finishes green is committed under its title and marked finished", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done");
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.status(), "termine");
  assert.equal(repo.commits()[0], "T001: Add the greeting");
  assert.equal(repo.git("status", "--porcelain").stdout.trim(), "");
  assert.match(repo.read("core/greeting.cjs"), /hello/);
});

// Réserves d'une session TERMINÉ : la boucle écrit une chaîne telle quelle et toute autre valeur en JSON.
const reserves = ["Le critère 3 est rempli à la lettre près.", { fichier: "INDEX.md", lignes: "162-163", question: "à corriger ?" }];
const reservesEnv = (list) => ({ FAKE_RESERVES: JSON.stringify(list) });
const committedTicket = (repo) => repo.git("show", "HEAD:docs/travail/tickets/001-add-greeting.md").stdout;

test("the reserves of a finished session go into the ticket journal, the commit message and the integration event", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done-with-reserves", [], reservesEnv(reserves));
  assert.equal(result.code, 0, result.out);
  const milestone = `\n\n### Réserves à la clôture\n\n- ${reserves[0]}\n- ${JSON.stringify(reserves[1])}\n`;
  assert.ok(committedTicket(repo).endsWith(milestone), committedTicket(repo));
  const paragraphs = repo.git("log", "-1", "--format=%B").stdout.trim().split("\n\n");
  assert.equal(paragraphs[0], "T001: Add the greeting");
  assert.match(paragraphs.at(-1), /^Co-Authored-By: [^\n]+$/);
  assert.deepEqual(paragraphs.slice(1, -1), ["Ticket: docs/travail/tickets/001-add-greeting.md", "Reserves: 2, listed in the ticket journal."]);
  assert.deepEqual(repo.events().find((e) => e.phase === "integre").reserves, reserves);
});

test("the reserves of a finished session are printed on the console after integration", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done-with-reserves", [], reservesEnv(reserves));
  assert.equal(result.code, 0, result.out);
  const lines = result.out.split("\n");
  const integratedAt = lines.findIndex((line) => line.startsWith("[boucle] T001 intégré ("));
  const shownAt = lines.indexOf(`[boucle] Réserves de la session : ${reserves[0]} ; ${JSON.stringify(reserves[1])}`);
  assert.ok(integratedAt >= 0 && shownAt > integratedAt, result.out);
});

test("a finished session without reserves adds no reserve milestone, commit line or event field", (t) => {
  for (const [scenario, env] of [["done", {}], ["done-with-reserves", reservesEnv([])]]) {
    const repo = loopRepo();
    t.after(repo.cleanup);
    const result = repo.loop(scenario, [], env);
    assert.equal(result.code, 0, result.out);
    assert.ok(committedTicket(repo).endsWith("\n- jalon : attempt 1\n"), committedTicket(repo));
    assert.doesNotMatch(committedTicket(repo), /Réserves à la clôture/, scenario);
    assert.doesNotMatch(repo.git("log", "-1", "--format=%B").stdout, /^Reserves:/m, scenario);
    assert.equal("reserves" in repo.events().find((e) => e.phase === "integre"), false, scenario);
  }
});

test("a reserve written over several lines stays inside its list item, and the journal ends with a single newline", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done-with-reserves", [], reservesEnv(["Deux choix :\n\n- garder\n- retirer\n"]));
  assert.equal(result.code, 0, result.out);
  const milestone = "\n- jalon : attempt 1\n\n### Réserves à la clôture\n\n- Deux choix :\n\n  - garder\n  - retirer\n";
  assert.ok(committedTicket(repo).endsWith(milestone), committedTicket(repo));
});

test("a session that claims done on a red check is refused, retried, then the ticket is blocked without any commit", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("long-line", ["--attempts", "2"]);
  assert.equal(result.code, 2, result.out);
  assert.equal(repo.status(), "bloque");
  assert.deepEqual(repo.commits(), ["init"]);
  assert.match(repo.failure(), /contrôle qualité complet est rouge/);
  assert.equal(repo.attempts(), "2");
});

for (const [scenario, expected, files = {}] of [
  ["edits-criteria", /modifié au-dessus de son journal/],
  ["edits-harness", /harnais a été modifié sans que le ticket l'autorise/],
  ["edits-config", /harnais a été modifié sans que le ticket l'autorise : harness\.config\.mjs/],
  ["deletes-test", /fichiers de test ont été supprimés/],
  ["deletes-colocated-test", /fichiers de test ont été supprimés.*core\/greeting\.test\.cjs/, { "core/greeting.test.cjs": "test('a', () => {});\n" }],
]) {
  test(`a session that ${scenario.replaceAll("-", " ")} is refused`, (t) => {
    const repo = loopRepo(files);
    t.after(repo.cleanup);
    const result = repo.loop(scenario, ["--attempts", "1"]);
    assert.equal(result.code, 2, result.out);
    assert.deepEqual(repo.commits(), ["init"]);
    assert.match(repo.failure(), expected);
  });
}

test("a session that stops without a verdict counts as a failed attempt", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("silent", ["--attempts", "1"]);
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /sans verdict/);
});

test("a session that declares itself blocked stops the loop at once with its reason", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("blocked");
  assert.equal(result.code, 2);
  assert.match(result.out, /the ticket contradicts the code/);
  assert.equal(repo.attempts(), "1");
  assert.equal(repo.status(), "bloque");
});

test("a partial session is followed by a fresh one that resumes and can finish", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("partial-then-done");
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.status(), "termine");
  assert.equal(repo.attempts(), "2");
});

test("a ticket that requires an ADR is refused without one and accepted with one", (t) => {
  const withAdr = { "docs/travail/tickets/001-add-greeting.md": ticketText({ adr: "oui" }) };
  const missing = loopRepo(withAdr);
  t.after(missing.cleanup);
  assert.equal(missing.loop("done", ["--attempts", "1"]).code, 2);
  assert.match(missing.failure(), /demande un ADR/);
  const present = loopRepo(withAdr);
  t.after(present.cleanup);
  assert.equal(present.loop("with-adr").code, 0);
  assert.equal(present.status(), "termine");
});

test("a ticket that improves a measure tightens the baseline in its own commit", (t) => {
  const repo = loopRepo({ "core/legacy.cjs": "try {\n  work();\n} catch {}\n" });
  t.after(repo.cleanup);
  repo.node("scripts/quality/ratchet.mjs", ["--init"]);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "baseline");
  assert.equal(JSON.parse(repo.read("scripts/quality/baseline.json")).catch_vides_prod, 1);
  const result = repo.loop("removes-empty-catch");
  assert.equal(result.code, 0, result.out);
  assert.equal(JSON.parse(repo.read("scripts/quality/baseline.json")).catch_vides_prod, 0);
  assert.match(repo.git("show", "--stat", "--format=", "HEAD").stdout, /scripts\/quality\/baseline\.json/);
});

test("integrating an added test case commits its tighter floor, and a harness test case stays out of it", (t) => {
  const repo = loopRepo({ "tests/harness/extra.test.cjs": "const { test } = require('node:test');\ntest('harness passes', () => {});\n" });
  t.after(repo.cleanup);
  const initial = repo.node("scripts/quality/ratchet.mjs", ["--init"]);
  assert.equal(initial.code, 0, initial.out);
  const before = JSON.parse(repo.read("scripts/quality/baseline.json"));
  assert.equal(before.cas_de_test, 1);
  assert.equal(repo.git("add", "-A").code, 0);
  assert.equal(repo.git("commit", "-q", "-m", "baseline").code, 0);
  const result = repo.loop("adds-test-case", ["--no-retro"], { FAKE_TEST_FILE: "tests/sample.test.cjs" });
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.status(), "termine");
  const expected = { ...before, cas_de_test: 2 };
  assert.deepEqual(JSON.parse(repo.read("scripts/quality/baseline.json")), expected);
  const committed = repo.git("show", "HEAD:scripts/quality/baseline.json");
  assert.equal(committed.code, 0, committed.out);
  assert.deepEqual(JSON.parse(committed.stdout), expected);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
});

test("integration uses the measure definitions migrated by an authorized harness session", (t) => {
  const repo = loopRepo({ "docs/travail/tickets/001-add-greeting.md": ticketText({ harnais: "oui" }) });
  t.after(repo.cleanup);
  fs.copyFileSync(path.join(repo.root, "scripts/quality/metrics.mjs"), path.join(repo.root, ".harness-state/current-metrics.mjs"));
  // L'ancienne définition est chargée au démarrage ; la session migrera ensuite le module sur disque.
  repo.write("scripts/quality/metrics.mjs", [
    "export {",
    "  HARNESS_TESTS, TICKET_NAMED_TEST, emptyCatches, isCode, isProduction, isTest, longLines, measureText,",
    '} from "../../.harness-state/current-metrics.mjs";',
    'import { directions as current, measure as count } from "../../.harness-state/current-metrics.mjs";',
    "export function directions(config) {",
    "  const { cas_de_test, ...other } = current(config);",
    '  return { ...other, cas_de_test_ancien: "min" };',
    "}",
    "export function measure(root, config) {",
    "  const { cas_de_test, ...other } = count(root, config);",
    "  return { ...other, cas_de_test_ancien: cas_de_test };",
    "}",
    "",
  ].join("\n"));
  const initial = repo.node("scripts/quality/ratchet.mjs", ["--init"]);
  assert.equal(initial.code, 0, initial.out);
  const { cas_de_test_ancien: oldTotal, ...other } = JSON.parse(repo.read("scripts/quality/baseline.json"));
  assert.equal(oldTotal, 1);
  assert.equal(repo.git("add", "-A").code, 0);
  assert.equal(repo.git("commit", "-q", "-m", "baseline").code, 0);
  const migrated = { ...other, cas_de_test: 1 };
  const result = repo.loop("migrates-test-measures", ["--no-retro", "--attempts", "1"], {
    FAKE_MIGRATED_BASELINE: JSON.stringify(migrated),
  });
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.status(), "termine");
  const expected = { ...migrated, cas_de_test: 2 };
  const committed = repo.git("show", "HEAD:scripts/quality/baseline.json");
  assert.equal(committed.code, 0, committed.out);
  assert.deepEqual(JSON.parse(committed.stdout), expected);
  assert.deepEqual(JSON.parse(repo.read("scripts/quality/baseline.json")), expected);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
});

test("the loop caps the context of a ticket session and records what the session cost, compactions included", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("compacts");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /compactée 1 fois/);
  assert.equal(repo.read(".harness-state/tickets/T001/fake-window"), "200000");
  const events = repo.read(".harness-state/loop/events.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  const ended = events.find((e) => e.phase === "session-terminee");
  const { session, tours, duree_s, cout_usd, tokens_sortie, tokens_lus_cumules, refus_de_permission, compactions } = ended;
  assert.deepEqual(
    { session, tours, duree_s, cout_usd, tokens_sortie, tokens_lus_cumules, refus_de_permission, compactions },
    { session: "s1", tours: 12, duree_s: 3, cout_usd: 0.5, tokens_sortie: 20, tokens_lus_cumules: 80, refus_de_permission: 1, compactions: 1 },
  );
  assert.equal(repo.loop("done", ["--dry-run", "--compact-window", "0"]).code, 0);
});

test("the loop records the model of each attempt, what each model and sub-agent cost, and signs the commit with the model that finished", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("compacts");
  assert.equal(result.code, 0, result.out);
  const events = repo.events();
  const { niveau, modele, effort, palier, relecteur } = events.find((e) => e.phase === "session");
  const firstRung = { niveau: "standard", modele: "claude-sonnet-5-5", effort: "high", palier: 0, relecteur: "opus" };
  assert.deepEqual({ niveau, modele, effort, palier, relecteur }, firstRung);
  const ended = events.find((e) => e.phase === "session-terminee");
  assert.deepEqual(ended.cout_par_modele, { "claude-sonnet-5-5": 0.3, "claude-opus-5-5": 0.2 });
  assert.deepEqual(ended.sous_agents, [{ role: "relecteur", modele: "claude-opus-5-5", tokens: 900, outils: 7, duree_ms: 4000 }]);
  assert.match(ended.refus[0], /^Bash .*git commit/);
  const integrated = events.find((e) => e.phase === "integre");
  assert.deepEqual([integrated.tentatives, integrated.cout_usd, integrated.modele], [1, 0.5, "claude-sonnet-5-5"]);
  assert.match(result.out, /intégré \(\w+\) en 1 tentative\(s\), 0\.50 \$/);
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Co-Authored-By: Claude Sonnet 5\.5 <noreply@anthropic\.com>$/m);
});

test("each refused attempt climbs one rung of the model ladder from a start set by the ticket level; the reviewer never runs below its floor", (t) => {
  const sonnet = { model: "claude-sonnet-5-5", effort: "high" };
  const opus = { model: "claude-opus-5-5", effort: "high", review: "opus" };
  const opusMore = { model: "claude-opus-5-5", effort: "xhigh", review: "opus" };
  const fable = { model: "claude-fable-5-1", effort: "high", review: "fable" };
  for (const [fields, args, expected] of [
    [{}, [], [{ ...sonnet, review: "opus" }, opus, opusMore, fable]],
    [{ harnais: "oui" }, [], [opusMore, fable]],
    [{ niveau: "simple" }, ["--attempts", "1"], [{ ...sonnet, review: "sonnet" }]],
    [{}, ["--model", "claude-opus-5-5", "--effort", "max"], Array(3).fill({ model: "claude-opus-5-5", effort: "max", review: null })],
  ]) {
    const repo = loopRepo({ "docs/travail/tickets/001-add-greeting.md": ticketText(fields) });
    t.after(repo.cleanup);
    assert.equal(repo.loop("silent", args).code, 2);
    assert.deepEqual(repo.plans(), expected, JSON.stringify(fields) + args.join(" "));
  }
});

test("a project ladder from harness.config.mjs replaces the default one, and the sessions carry the project name", (t) => {
  const config = [
    "export default {",
    '  project: "Demo",',
    "  models: {",
    '    ladder: [{ model: "claude-haiku-5-5", alias: "haiku", effort: "low" }, { model: "claude-sonnet-5-5", alias: "sonnet", effort: "max" }],',
    "  },",
    "};",
  ].join("\n");
  const repo = loopRepo({ "harness.config.mjs": config + "\n" });
  t.after(repo.cleanup);
  assert.equal(repo.loop("silent").code, 2);
  assert.deepEqual(repo.plans(), [
    { model: "claude-haiku-5-5", effort: "low", review: "sonnet" },
    { model: "claude-sonnet-5-5", effort: "max", review: "sonnet" },
  ]);
  assert.equal(repo.read(".harness-state/tickets/T001/fake-name"), "Demo T001 tentative 2");
});

test("a project ladder shorter than a level's start begins on its last rung", async () => {
  const { modelSettings, plan, attemptsToTop } = await import(pathToFileURL(path.join(__dirname, "..", "..", "scripts/loop/models.mjs")).href);
  const settings = modelSettings({ ladder: [{ model: "a", alias: "a", effort: "high" }, { model: "b", alias: "b", effort: "high" }] });
  assert.deepEqual(plan("critique", 1, settings), { rung: 1, model: "b", alias: "b", effort: "high", reviewModel: "b" });
  assert.equal(attemptsToTop("critique", settings), 1);
  assert.equal(plan("standard", 1, settings).reviewModel, "b");
});

test("an unreadable harness.config.mjs stops the loop before any session", (t) => {
  const repo = loopRepo({ "harness.config.mjs": "export default { suites: 'tests' };\n" });
  t.after(repo.cleanup);
  const result = repo.loop("done");
  assert.equal(result.code, 1);
  assert.match(result.out, /harness\.config\.mjs est illisible/);
  assert.equal(repo.status(), "a-faire");
});

for (const [scenario, expected] of [
  ["review-rejected", /Le dernier relecteur n'a pas accepté revue-1\.diff \(verdict : à corriger\)/],
  ["review-stale", /Le dernier verdict porte sur revue-1\.diff, pas sur la dernière revue enregistrée \(revue-2\.diff\)/],
]) {
  test(`a session that claims done without its last review accepted is refused: ${scenario}`, (t) => {
    const repo = loopRepo();
    t.after(repo.cleanup);
    const result = repo.loop(scenario, ["--attempts", "1"]);
    assert.equal(result.code, 2, result.out);
    assert.match(repo.failure(), expected);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

test("after a ticket, a read-only retrospective proposes harness changes that the owner can list and decide later", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Rétrospective : 2 observation\(s\), 0\.20 \$/);
  const call = JSON.parse(repo.read(".harness-state/tickets/T001/fake-retro-call"));
  assert.deepEqual([call.model, call.tools, call.loop], ["claude-sonnet-5-5", "Read,Grep,Glob", null]);
  assert.match(repo.read(".harness-state/tickets/T001/retro-entree.md"), /## Tentative 1[\s\S]*claude-sonnet-5-5/);
  assert.equal(JSON.parse(repo.read(".harness-state/tickets/T001/retro.json")).observations.length, 2);
  const journal = repo.read(".harness-state/retours/observations.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(journal.map((o) => [o.id, o.statut, o.cible]), [["R-T001-1", "propose", "agent"], ["R-T001-2", "propose", "boucle"]]);

  assert.equal(repo.node("scripts/loop/retro.mjs", ["decider", "R-T001-2", "ticket:T009", "queue", "it"]).code, 0);
  assert.equal(repo.node("scripts/loop/retro.mjs", ["decider", "R-T001-1", "maybe"]).code, 2);
  const open = repo.node("scripts/loop/retro.mjs", ["liste"]).stdout;
  assert.match(open, /R-T001-1/);
  assert.doesNotMatch(open, /R-T001-2/);
  assert.match(repo.node("scripts/loop/retro.mjs", ["liste", "--tous"]).stdout, /R-T001-2 .* → ticket:T009 \(queue it\)/);
});

// Une observation du journal des retours, telle que la rétrospective l'écrit.
const observation = (fields) => ({
  ticket: "T001",
  at: "2026-10-14T00:00:00.000Z",
  statut: "propose",
  type: "probleme",
  sujet: "reviewer",
  constat: "found",
  preuve: "session-1.jsonl",
  proposition: "tell the reviewer",
  cible: "skill",
  impact: "moyen",
  ...fields,
});
const journalFile = ".harness-state/retours/observations.jsonl";
const seedJournal = (repo, entries) => repo.write(journalFile, entries.map((e) => JSON.stringify(e) + "\n").join(""));
const journal = (repo) => repo.read(journalFile).trim().split("\n").map((line) => JSON.parse(line));
const statuses = (repo) => Object.fromEntries(journal(repo).map((o) => [o.id, o.statut]));
// La fausse rétrospective relève ici un problème de cible `skill`, qu'une harmonisation a le droit de traiter.
const SKILL_RETRO = { FAKE_RETRO_TARGET: "skill" };
// Deux tickets et une skill suivie par Git ; la fausse rétrospective relève après chaque ticket le même problème (« reviewer »).
const tuningRepo = () => {
  const repo = loopRepo({
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
    ".claude/skills/ticket/SKILL.md": "# Ticket\n",
  });
  return { ...repo, loop: (scenario, args = [], env = {}) => repo.loop(scenario, args, { ...SKILL_RETRO, ...env }) };
};
const tuneCall = (repo, id = "H001") => JSON.parse(repo.read(`.harness-state/tickets/${id}/fake-tune-call`));
const lastCommit = (repo) => ({
  head: repo.git("rev-parse", "--short", "HEAD").stdout.trim(),
  paragraphs: repo.git("log", "-1", "--format=%B").stdout.trim().split("\n\n"),
  files: repo.git("show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n"),
});

test("an observation handled by a harness tuning commit is marked with that commit and leaves the list to decide", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T001-1" }), observation({ id: "R-T001-2" })]);
  const retro = (...args) => repo.node("scripts/loop/retro.mjs", args);
  const marked = retro("decider", "R-T001-1", "harmonisation:0a1b2c3");
  assert.equal(marked.code, 0, marked.out);
  for (const wrong of ["harmonisation:", "harmonisation:0a1b2c", "harmonisation:not-hex", `harmonisation:${"a".repeat(41)}`]) {
    assert.equal(retro("decider", "R-T001-2", wrong).code, 2, wrong);
  }
  assert.deepEqual(statuses(repo), { "R-T001-1": "harmonisation:0a1b2c3", "R-T001-2": "propose" });
  const open = retro("liste").stdout;
  assert.doesNotMatch(open, /R-T001-1/);
  assert.match(open, /R-T001-2/);
  assert.match(retro("liste", "--tous").stdout, /R-T001-1 .* → harmonisation:0a1b2c3/);
});

test("an observation deferred by a tuning session stays in the list to decide, with its decision and its note, until the owner decides it", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T001-1" }), observation({ id: "R-T001-2" }), observation({ id: "R-T001-3" })]);
  const retro = (...args) => repo.node("scripts/loop/retro.mjs", args);
  const deferred = retro("decider", "R-T001-1", "differee:H001", "it would loosen a check");
  assert.equal(deferred.code, 0, deferred.out);
  for (const wrong of ["differee", "differee:", "differee:H", "differee:T001", "differee:h001", "differee:H001x"]) {
    assert.equal(retro("decider", "R-T001-2", wrong).code, 2, wrong);
  }
  assert.equal(retro("decider", "R-T001-3", "accepte").code, 0);
  assert.deepEqual(statuses(repo), { "R-T001-1": "differee:H001", "R-T001-2": "propose", "R-T001-3": "accepte" });
  const open = retro("liste").stdout;
  assert.match(open, /R-T001-1 .* → differee:H001 \(it would loosen a check\)/);
  assert.match(open, /R-T001-2/);
  assert.doesNotMatch(open, /R-T001-3/);
  assert.equal(retro("decider", "R-T001-1", "refuse", "the check stays").code, 0);
  assert.doesNotMatch(retro("liste").stdout, /R-T001-1/);
});

test("the subjects to tune are the pending problems seen on two tickets or more, or with a strong impact, most frequent first, three at most", async () => {
  const { selectSubjects } = await tuning();
  const seen = (id, ticket, sujet, fields = {}) => observation({ id, ticket, sujet, ...fields });
  const journal = [
    seen("R-T001-1", "T001", "once", { impact: "faible" }),
    seen("R-T001-2", "T001", "strong", { impact: "fort" }),
    seen("R-T001-3", "T001", "twice"),
    seen("R-T002-1", "T002", "twice", { impact: "faible" }),
    seen("R-T002-2", "T002", "twice", { type: "bien" }),
    seen("R-T003-1", "T003", "twice", { statut: "refuse" }),
    seen("R-T001-4", "T001", "same ticket"),
    seen("R-T001-5", "T001", "same ticket"),
    seen("R-T002-3", "T002", "praised", { type: "bien", impact: "fort" }),
    seen("R-T003-2", "T003", "praised", { type: "bien" }),
    seen("R-T002-4", "T002", "decided", { statut: "ticket:T009", impact: "fort" }),
    seen("R-T003-3", "T003", "decided", { statut: "accepte" }),
  ];
  const chosen = (entries) => selectSubjects(entries).map((s) => [s.sujet, s.observations.map((o) => o.id)]);
  assert.deepEqual(chosen(journal), [["twice", ["R-T001-3", "R-T002-1"]], ["strong", ["R-T001-2"]]]);
  const more = [
    seen("R-T004-1", "T004", "late twice"),
    seen("R-T005-1", "T005", "late twice"),
    seen("R-T004-2", "T004", "thrice"),
    seen("R-T005-2", "T005", "thrice"),
    seen("R-T006-1", "T006", "thrice"),
  ];
  assert.deepEqual(chosen([...journal, ...more]).map(([sujet]) => sujet), ["thrice", "twice", "late twice"]);
  assert.deepEqual(chosen(journal.filter((o) => o.sujet !== "twice" && o.sujet !== "strong")), []);
});

test("with no problem that recurs or has a strong impact, the loop says there is nothing to tune and starts no session", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const seeded = [
    observation({ id: "R-T008-1", ticket: "T008", sujet: "slow review", impact: "moyen" }),
    observation({ id: "R-T009-1", ticket: "T009", sujet: "slow review", type: "bien" }),
    observation({ id: "R-T008-2", ticket: "T008", sujet: "noisy hook", impact: "faible" }),
    observation({ id: "R-T008-3", ticket: "T008", sujet: "noisy hook", impact: "faible" }),
    observation({ id: "R-T008-4", ticket: "T008", sujet: "already decided", statut: "refuse" }),
    observation({ id: "R-T009-2", ticket: "T009", sujet: "already decided", statut: "refuse", impact: "fort" }),
  ];
  seedJournal(repo, seeded);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Rien à harmoniser/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H001")), false, "no tuning session was started");
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
  assert.deepEqual(journal(repo), seeded);
});

test("a problem that recurs on two tickets but targets the checks starts no tuning session: there is nothing to tune", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const seeded = [
    observation({ id: "R-T008-1", ticket: "T008", sujet: "slow check", cible: "controle" }),
    observation({ id: "R-T009-1", ticket: "T009", sujet: "slow check", cible: "controle" }),
  ];
  seedJournal(repo, seeded);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Rien à harmoniser/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H001")), false, "no tuning session was started");
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
  assert.deepEqual(journal(repo), seeded);
});

test("a subject that mixes targets brings to the tuning session only its skill and agent observations", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [
    observation({ id: "R-T008-1", ticket: "T008", cible: "skill" }),
    observation({ id: "R-T009-1", ticket: "T009", cible: "boucle" }),
    observation({ id: "R-T009-2", ticket: "T009", cible: "skill" }),
  ]);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  const chosen = JSON.parse(repo.read(".harness-state/tickets/H001/observations.json"));
  assert.deepEqual(chosen.map((o) => [o.id, o.cible]), [["R-T008-1", "skill"], ["R-T009-2", "skill"]]);
  const handled = `harmonisation:${lastCommit(repo).head}`;
  assert.deepEqual(statuses(repo), { "R-T008-1": handled, "R-T009-1": "propose", "R-T009-2": handled });
});

test("only skill and agent observations count for a subject: other targets neither bring it in nor add tickets to it", async () => {
  const { selectSubjects } = await tuning();
  const seen = (id, ticket, sujet, cible, fields = {}) => observation({ id, ticket, sujet, cible, ...fields });
  const journal = [
    seen("R-T001-1", "T001", "agent and hook", "agent"),
    seen("R-T002-1", "T002", "agent and hook", "hook"),
    seen("R-T001-2", "T001", "loop only", "boucle", { impact: "fort" }),
    seen("R-T002-2", "T002", "loop only", "boucle"),
    seen("R-T001-3", "T001", "two agents", "agent"),
    seen("R-T002-3", "T002", "two agents", "agent"),
    seen("R-T003-1", "T003", "two agents", "autre"),
    seen("R-T001-4", "T001", "strong elsewhere", "skill"),
    seen("R-T002-4", "T002", "strong elsewhere", "ticket", { impact: "fort" }),
  ];
  const chosen = selectSubjects(journal).map((s) => [s.sujet, s.tickets, s.observations.map((o) => o.id)]);
  assert.deepEqual(chosen, [["two agents", ["T001", "T002"], ["R-T001-3", "R-T002-3"]]]);
});

test("without --tune-every, no tuning session runs, even after two tickets with a recurring problem", (t) => {
  const repo = loopRepo({ "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }) });
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--max", "2"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(repo.commits(), ["T002: Add the farewell", "T001: Add the greeting", "init"]);
  const recurring = journal(repo).filter((o) => o.type === "probleme" && o.statut === "propose" && o.sujet === "reviewer");
  assert.deepEqual(recurring.map((o) => o.ticket), ["T001", "T002"]);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H001")), false, "no tuning session was started");
  assert.doesNotMatch(result.out, /harmonis/i);
});

test("every N integrated tickets, a tuning session edits a skill; its commit holds only skills and agents and marks the problems handled", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "2", "--max", "2"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  const title = "Tune the harness: Tell the reviewer to read the tests first";
  assert.deepEqual(repo.commits(), [title, "T002: Add the farewell", "T001: Add the greeting", "init"]);
  assert.ok(result.out.indexOf("[boucle] T002 intégré") < result.out.indexOf("[boucle] Harmonisation H001"), result.out);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H002")), false, "a single tuning session");
  const { env, prompt } = tuneCall(repo);
  assert.deepEqual(env, {
    HARNESS_LOOP: "1",
    HARNESS_TICKET: "H001",
    HARNESS_TICKET_FILE: ".harness-state/tickets/H001/observations.json",
    HARNESS_TUNE: "1",
    HARNESS_EDIT: "1",
    HARNESS_EDIT_SCOPE: "consignes",
    HARNESS_REVIEW_MODEL: "opus",
    HARNESS_ALLOW_INSTALL: "0",
  });
  assert.match(prompt, /\.claude\/skills\/harmonisation\/SKILL\.md/);
  const plans = repo.read(".harness-state/tickets/H001/fake-plans").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(plans, [{ model: "claude-opus-5-5", effort: "high", review: "opus" }]);
  const { head, paragraphs, files } = lastCommit(repo);
  assert.ok(files.every((file) => file.startsWith(".claude/skills/") || file.startsWith(".claude/agents/")), files.join("\n"));
  assert.deepEqual(files, [".claude/skills/ticket/SKILL.md"]);
  assert.deepEqual(paragraphs, [title, "Observations: R-T001-2, R-T002-2", "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"]);
  const handled = `harmonisation:${head}`;
  assert.deepEqual(statuses(repo), { "R-T001-1": "propose", "R-T001-2": handled, "R-T002-1": "propose", "R-T002-2": handled });
  assert.equal(repo.git("status", "--porcelain").stdout, "");
});

test("a tuning session can integrate a change to the Codex ticket skill", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "1"], { FAKE_TUNE: "edits-codex-skill" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Harmonisation H001 intégrée/);
  assert.deepEqual(lastCommit(repo).files, [".agents/skills/ticket-codex/SKILL.md"]);
  assert.equal(repo.read(".agents/skills/ticket-codex/SKILL.md"), "Lire les tests avant de coder.\n");
});

for (const [scenario, expected] of [
  ["edits-check", /Le diff sort des consignes \(\.claude\/skills\/, \.claude\/agents\/, \.agents\/skills\/\) : scripts\/check\.mjs$/m],
  ["review-rejected", /Le dernier relecteur n'a pas accepté revue-1\.diff \(verdict : à corriger\)/],
  ["silent", /sans verdict/],
]) {
  test(`a refused tuning session leaves none of its files, keeps its problems pending, and the next ticket runs: ${scenario}`, (t) => {
    const repo = tuningRepo();
    t.after(repo.cleanup);
    const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: scenario });
    assert.equal(result.code, 0, result.out);
    assert.match(repo.read(".harness-state/tickets/H001/refus.txt"), expected);
    assert.ok(result.out.indexOf("[boucle] Harmonisation H001 refusée") < result.out.indexOf("[boucle] T002 intégré"), result.out);
    assert.deepEqual(repo.commits(), ["T002: Add the farewell", "T001: Add the greeting", "init"]);
    assert.deepEqual(lastCommit(repo).files, ["docs/travail/tickets/002-add-farewell.md"]);
    assert.equal(repo.git("status", "--porcelain").stdout, "");
    assert.equal(repo.read(".claude/skills/ticket/SKILL.md"), "# Ticket\n");
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/modified-check-ran")), false, "a modified check is never run");
    assert.deepEqual([...new Set(Object.values(statuses(repo)))], ["propose"]);
  });
}

test("a refused tuning session sets aside, intact and out of Git, the new files that appeared while it ran, and names them", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: "leaves-files" });
  assert.equal(result.code, 0, result.out);
  assert.match(repo.read(".harness-state/tickets/H001/refus.txt"), /^Le diff sort des consignes .* : .*scripts\/check\.mjs/);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
  const aside = ".harness-state/tickets/H001/mis-de-cote/";
  assert.equal(repo.read(aside + "notes/extra.md"), "extra notes\n");
  assert.equal(repo.read(aside + "experiments/idea.md"), "an idea\n");
  const named = result.out.split("\n").find((line) => line.includes(aside)) ?? "";
  for (const file of ["notes/extra.md", "experiments/idea.md"]) assert.ok(named.includes(file), result.out);
  assert.ok(result.out.indexOf(named) < result.out.indexOf("[boucle] T002 intégré"), result.out);
  const refused = repo.events().find((e) => e.phase === "harmonisation-refusee" && e.id === "H001");
  assert.deepEqual([...refused.mis_de_cote].sort(), ["experiments/idea.md", "notes/extra.md"]);
  assert.deepEqual(repo.commits(), ["T002: Add the farewell", "T001: Add the greeting", "init"]);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/modified-check-ran")), false, "a modified check is never run");
});

test("a tuning session that edits the reviewer's instructions is refused by the loop and undone", (t) => {
  const repo = loopRepo({ ".claude/agents/relecteur.md": "# Reviewer\n" });
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", ticket: "T008", impact: "fort" })]);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "edits-reviewer" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Harmonisation H001 refusée/);
  const [first, ...next] = repo.read(".harness-state/tickets/H001/refus.txt").split("\n");
  assert.equal(first, "Le diff sort des consignes (.claude/skills/, .claude/agents/, .agents/skills/) : .claude/agents/relecteur.md");
  assert.match(next.join("\n"), /\.claude\/agents\/relecteur\.md/);
  assert.equal(repo.read(".claude/agents/relecteur.md"), "# Reviewer\n");
  assert.equal(repo.git("status", "--porcelain").stdout, "");
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
  assert.deepEqual(statuses(repo), { "R-T008-1": "propose" });
});

test("each recorded review keeps its report in relecture-<n>.md, n being its rank, for a ticket as for a tuning session", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("reviewed-twice", ["--tune-every", "1"], { FAKE_TUNE: "review-rejected" });
  assert.equal(result.code, 0, result.out);
  const ticket = ".harness-state/tickets/T001/";
  assert.equal(repo.read(ticket + "relectures.jsonl").trim().split("\n").length, 2);
  assert.equal(repo.read(ticket + "relecture-1.md"), "VERDICT : à corriger\nCONSTATS : 0 bloquant, 1 mineur, 0 hors périmètre\n- name the greeting");
  assert.equal(repo.read(ticket + "relecture-2.md"), "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre");
  const tuning = ".harness-state/tickets/H001/";
  assert.equal(repo.read(tuning + "relecture-1.md"), "VERDICT : à corriger\nCONSTATS : 1 bloquant, 0 mineur, 0 hors périmètre\n- it removes a proof");
  assert.equal(fs.existsSync(path.join(repo.root, tuning, "relecture-2.md")), false, "a single review of the tuning session");
});

test("a tuning session that follows a refused one is told to read that refusal first, and the last report of its reviewer", (t) => {
  for (const [scenario, report] of [["rejected-twice", ".harness-state/tickets/H001/relecture-2.md"], ["silent", null]]) {
    const repo = tuningRepo();
    t.after(repo.cleanup);
    const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: scenario });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Harmonisation H001 refusée/, scenario);
    assert.doesNotMatch(tuneCall(repo).prompt, /refus\.txt|relecture-/, scenario);
    const prompt = tuneCall(repo, "H002").prompt;
    assert.ok(prompt.includes(".harness-state/tickets/H001/refus.txt"), `${scenario}: ${prompt}`);
    if (report) assert.ok(prompt.includes(report), `${scenario}: ${prompt}`);
    assert.doesNotMatch(prompt, report ? /relecture-1\.md/ : /relecture-/, scenario);
  }
});

test("a tuning session that follows an integrated one is told of no earlier refusal", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Harmonisation H001 intégrée/);
  assert.ok(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H001/relecture-1.md")), "the integrated session was reviewed");
  for (const id of ["H001", "H002"]) assert.doesNotMatch(tuneCall(repo, id).prompt, /refus\.txt|relecture-/, id);
});

// Dépôt distant local qui refuse tout push contenant un commit d'harmonisation.
const REFUSE_TUNING = `#!/bin/sh
while read old new ref; do
  if git log --format=%s "$new" | grep -q "^Tune the harness"; then
    echo "tuning commits are refused here" >&2
    exit 1
  fi
done
`;

/** Dépôt distant local, `origin` du dépôt de test ; `preReceive`, s'il est donné, décide de ce qu'il accepte. */
function addRemote(repo, preReceive = null) {
  const remote = path.join(repo.root, ".harness-state", "remote.git");
  assert.equal(repo.git("init", "--bare", "-q", remote).code, 0);
  if (preReceive) {
    fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), preReceive);
    fs.chmodSync(path.join(remote, "hooks", "pre-receive"), 0o755);
  }
  repo.git("remote", "add", "origin", remote);
  return remote;
}

/** La boucle avec push, contrairement à `loop()` qui passe toujours `--no-push`. */
const loopWithPush = (repo, args, env) =>
  repo.node("scripts/loop/run.mjs", args, { env: { HARNESS_CLAUDE_BIN: path.join(repo.root, ".harness-state", "fake-claude.cjs"), ...env } });

test("a tuning commit whose push is refused stops the loop with code 3, its problems already marked with that commit", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  addRemote(repo, REFUSE_TUNING);
  const result = loopWithPush(repo, ["--tune-every", "1", "--max", "2"], { FAKE_SCENARIO: "done", FAKE_TUNE: "edits-skill", ...SKILL_RETRO });
  assert.equal(result.code, 3, result.out);
  assert.match(result.out, /Le commit est fait mais le push a échoué/);
  const { head } = lastCommit(repo);
  assert.deepEqual(repo.commits(), ["Tune the harness: Tell the reviewer to read the tests first", "T001: Add the greeting", "init"]);
  assert.equal(statuses(repo)["R-T001-2"], `harmonisation:${head}`);
  assert.equal(repo.events().find((e) => e.phase === "push-refuse").ticket, "H001");
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false, "the next ticket was not started");
});

test("a refused tuning session that cannot be undone stops the loop with code 4, names what is left, and starts no other ticket", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: "blocks-restore" });
  assert.equal(result.code, 4, result.out);
  assert.match(result.out, /remise à HEAD est incomplète/);
  assert.match(result.out, /Restent de la session : scripts\/check\.mjs/);
  assert.match(repo.read(".harness-state/tickets/H001/refus.txt"), /Le diff sort des consignes/);
  const stopped = repo.events().find((e) => e.phase === "harmonisation-non-defaite");
  assert.deepEqual([stopped.id, stopped.reste], ["H001", ["scripts/check.mjs"]]);
  assert.match(stopped.erreurs[0], /^git reset a échoué/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false, "the next ticket was not started");
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/modified-check-ran")), false, "a modified check is never run");
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
  assert.deepEqual([...new Set(Object.values(statuses(repo)))], ["propose"]);
});

test("a refused tuning session that cannot be undone still sets aside its new files, and names them as it stops", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2"], { FAKE_TUNE: "blocks-restore-leaves-file" });
  assert.equal(result.code, 4, result.out);
  assert.equal(repo.read(".harness-state/tickets/H001/mis-de-cote/notes/extra.md"), "extra notes\n");
  assert.match(result.out, /mis de côté dans \.harness-state\/tickets\/H001\/mis-de-cote\/ : notes\/extra\.md/);
  const stopped = repo.events().find((e) => e.phase === "harmonisation-non-defaite");
  assert.deepEqual([stopped.reste, stopped.mis_de_cote], [["scripts/check.mjs"], ["notes/extra.md"]]);
});

test("an unreadable feedback journal skips the tuning with a reason, and the queue goes on", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  repo.write(journalFile, JSON.stringify(observation({ id: "R-T008-1", ticket: "T008", impact: "fort" })) + '\n{"id": "R-T009-1", "tick\n');
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2", "--no-retro"], { FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Harmonisation sautée : le journal des retours est illisible/);
  assert.deepEqual(repo.commits(), ["T002: Add the farewell", "T001: Add the greeting", "init"]);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H001")), false, "no tuning session was started");
  assert.equal(repo.events().filter((e) => e.phase === "harmonisation-sautee").length, 2);
});

test("when the handled problems cannot be marked after the tuning commit, the loop says so and still pushes", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  const remote = addRemote(repo);
  const result = loopWithPush(repo, ["--tune-every", "1"], { FAKE_SCENARIO: "done", FAKE_TUNE: "corrupts-journal", ...SKILL_RETRO });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Les observations traitées n'ont pas pu être marquées .*: R-T001-2/);
  const title = "Tune the harness: Tell the reviewer to read the tests first";
  assert.equal(repo.git("--git-dir", remote, "log", "-1", "--format=%s", "work").stdout.trim(), title);
  assert.doesNotMatch(repo.read(journalFile), /harmonisation:/);
  assert.match(repo.events().find((e) => e.phase === "harmonisation-integree").marquage_echoue, /\S/);
});

test("problems a tuning session defers are marked deferred by it with their reason, and shown; an id outside the selection is never marked", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [
    observation({ id: "R-T008-1", ticket: "T008" }),
    observation({ id: "R-T009-1", ticket: "T009" }),
    observation({ id: "R-T009-2", ticket: "T009", sujet: "praise", type: "bien" }),
  ]);
  const env = { FAKE_TUNE: "edits-skill", FAKE_DEFER: "R-T009-1", FAKE_EXTRA_IDS: "R-T009-2" };
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], env);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Différée par l'harmonisation : R-T009-1 — it would loosen a check/);
  const { head, paragraphs } = lastCommit(repo);
  assert.equal(paragraphs[1], "Observations: R-T008-1");
  assert.deepEqual(statuses(repo), { "R-T008-1": `harmonisation:${head}`, "R-T009-1": "differee:H001", "R-T009-2": "propose" });
  assert.equal(journal(repo).find((o) => o.id === "R-T009-1").note, "it would loosen a check");
});

test("a tuning session that defers everything and changes nothing commits nothing and marks its problems deferred with their reason", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", ticket: "T008", impact: "fort" })]);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "defers-all" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Harmonisation H001 sans changement/);
  assert.match(result.out, /Différée par l'harmonisation : R-T008-1 — it would loosen a check/);
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
  assert.deepEqual(statuses(repo), { "R-T008-1": "differee:H001" });
  assert.equal(journal(repo)[0].note, "it would loosen a check");
});

test("a deferred problem waits for the owner: the next tuning on the same journal no longer selects it, and the list shows it", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [
    observation({ id: "R-T008-1", ticket: "T008" }),
    observation({ id: "R-T009-1", ticket: "T009", impact: "fort" }),
    observation({ id: "R-T007-1", ticket: "T007", cible: "boucle" }),
  ]);
  const env = { FAKE_TUNE: "edits-skill", FAKE_DEFER: "R-T009-1,R-T007-1" };
  const result = repo.loop("done", ["--tune-every", "1", "--max", "2", "--no-retro"], env);
  assert.equal(result.code, 0, result.out);
  const title = "Tune the harness: Tell the reviewer to read the tests first";
  assert.deepEqual(repo.commits(), ["T002: Add the farewell", title, "T001: Add the greeting", "init"]);
  const tuned = repo.git("rev-parse", "--short", "HEAD~1").stdout.trim();
  assert.deepEqual(statuses(repo), { "R-T008-1": `harmonisation:${tuned}`, "R-T009-1": "differee:H001", "R-T007-1": "propose" });
  assert.equal(journal(repo).find((o) => o.id === "R-T009-1").note, "it would loosen a check");
  assert.ok(result.out.lastIndexOf("Rien à harmoniser") > result.out.indexOf("[boucle] T002 intégré"), result.out);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/H002")), false, "the deferred problem started no second session");
  const open = repo.node("scripts/loop/retro.mjs", ["liste"]).stdout;
  assert.match(open, /R-T009-1 .* → differee:H001 \(it would loosen a check\)/);
});

test("when the deferred problems cannot be marked, the loop says so with the command to mark them by hand, and goes on", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", ticket: "T008" }), observation({ id: "R-T009-1", ticket: "T009" })]);
  const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: "corrupts-journal", FAKE_DEFER: "R-T009-1" });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Les observations différées n'ont pas pu être marquées .*: R-T009-1\. .*retro\.mjs decider <id> differee:H001/);
  assert.doesNotMatch(repo.read(journalFile), /differee:/);
});

test("a refused tuning session marks none of the problems it deferred", (t) => {
  const repo = tuningRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", ticket: "T008" }), observation({ id: "R-T009-1", ticket: "T009" })]);
  for (const scenario of ["review-rejected", "edits-check"]) {
    const result = repo.loop("done", ["--tune-every", "1", "--no-retro"], { FAKE_TUNE: scenario, FAKE_DEFER: "R-T009-1" });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Harmonisation H00\d refusée/, scenario);
    assert.match(result.out, /Différée par l'harmonisation : R-T009-1/, scenario);
    assert.deepEqual(statuses(repo), { "R-T008-1": "propose", "R-T009-1": "propose" }, scenario);
  }
});

test("a failed retrospective is reported and never stops the loop; --no-retro skips it", (t) => {
  const failing = loopRepo();
  t.after(failing.cleanup);
  const result = failing.loop("done", [], { FAKE_RETRO: "fail" });
  assert.equal(result.code, 0, result.out);
  assert.equal(failing.status(), "termine");
  assert.match(result.out, /La rétrospective a échoué, la boucle continue/);
  assert.ok(failing.events().some((e) => e.phase === "retro-echouee"));
  const skipped = loopRepo();
  t.after(skipped.cleanup);
  assert.equal(skipped.loop("done", ["--no-retro"]).code, 0);
  assert.equal(fs.existsSync(path.join(skipped.root, ".harness-state/tickets/T001/fake-retro-call")), false);
});

test("the loop shows each tool the session calls while it runs and keeps the whole stream", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("narrates");
  assert.equal(result.code, 0, result.out);
  const shown = result.out.split("\n").filter((line) => /^\[boucle\] \d\d:\d\d /.test(line)).map((line) => line.slice(14));
  assert.deepEqual(shown, [
    "  Read docs/travail/tickets/001-add-greeting.md",
    "  Agent explorateur Explore greeting",
    "    Grep hello",
    "  Bash Run the changed-files check",
  ]);
  assert.ok(result.out.indexOf("Bash Run the changed-files check") < result.out.indexOf("Session 1 : 4 tours"));
  const stream = repo.read(".harness-state/tickets/T001/session-1.jsonl").trim().split("\n");
  assert.equal(stream.length, 6);
  assert.equal(JSON.parse(repo.read(".harness-state/tickets/T001/session-1.json")).session_id, "s2");
});

const changedAfterReview = /modifié depuis la dernière relecture/;

test("a session that changes the code after its last review is refused, retried, then blocked without any commit", (t) => {
  const repo = loopRepo({ "core/greeting.cjs": "module.exports = () => 'hey';\n" });
  t.after(repo.cleanup);
  const result = repo.loop("changes-after-review", ["--attempts", "2"]);
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), changedAfterReview);
  assert.match(repo.failure(), /core\/greeting\.cjs/);
  assert.equal(repo.attempts(), "2");
  assert.equal(repo.status(), "bloque");
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a session that changes a new untracked file after its last review is refused", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("changes-after-review", ["--attempts", "1"]);
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), changedAfterReview);
  assert.match(repo.failure(), /core\/greeting\.cjs/);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a session that claims done without any recorded review is refused", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done-without-review", ["--attempts", "1"]);
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /Aucune relecture n'est enregistrée/);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a session whose final change is the one last reviewed is committed, even with a journal written after the review", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("journals-after-review");
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.commits()[0], "T001: Add the greeting");
  assert.match(repo.git("show", "HEAD:docs/travail/tickets/001-add-greeting.md").stdout, /review accepted/);
});

for (const count of ["1", "missing", "inconnu", "0"]) {
  test(`Claude cannot integrate an unresolved correction despite a finished implementation verdict: ${count}`, (t) => {
    const repo = loopRepo();
    t.after(repo.cleanup);
    const result = repo.loop("correction-review", ["--attempts", "1", "--no-retro"], { FAKE_UNCORRECTED: count });
    const resolved = count === "0";
    assert.equal(result.code, resolved ? 0 : 2, result.out);
    const dir = ".harness-state/tickets/T001/";
    assert.equal(JSON.parse(repo.read(dir + "verdict.json")).statut, "TERMINÉ");
    const reviews = repo.read(dir + "relectures.jsonl").trim().split("\n").map(JSON.parse);
    assert.deepEqual(reviews.map(review => review.verdict), ["à corriger", resolved ? "accepté" : "à corriger"]);
    assert.equal(reviews[1].modele, "claude-opus-5-5");
    assert.equal(repo.read(dir + "relecture-2.md"), acceptedReview + (count === "missing" ? "" : `\nNON CORRIGÉS : ${count}`));
    assert.equal(fs.existsSync(path.join(repo.root, dir + "revue-2.interdiff")), true);
    if (resolved) assert.equal(repo.commits()[0], "T001: Add the greeting");
    else {
      assert.match(repo.failure(), /dernier relecteur n'a pas accepté.*à corriger/);
      assert.deepEqual(repo.commits(), ["init"]);
    }
  });
}

test("a complete Claude review after a rejected attempt accepts without a correction count", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("rejected-then-complete", ["--attempts", "2", "--no-retro"]);
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.attempts(), "2");
  assert.equal(repo.read(".harness-state/tickets/T001/relecture-2.md"), acceptedReview);
  assert.equal(repo.commits()[0], "T001: Add the greeting");
});

test("a review recorded by an earlier attempt still counts for the next one", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("reviewed-then-partial");
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.attempts(), "2");
  assert.equal(repo.status(), "termine");
});

for (const [what, scenario, expected] of [
  ["reviewed state", "corrupts-review", /Aucune relecture lisible n'est enregistrée/],
  ["list of files untracked before the session", "corrupts-untracked-list", /^untracked-before\.json est illisible/m],
]) {
  test(`a session that leaves an unreadable ${what} is refused with a report, not a crash`, (t) => {
    const repo = loopRepo();
    t.after(repo.cleanup);
    const result = repo.loop(scenario, ["--attempts", "1"]);
    assert.equal(result.code, 2, result.out);
    assert.match(repo.failure(), expected);
    assert.equal(repo.status(), "bloque");
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

test("recording a review writes the diff with new files in full and the file list, numbered after the previous review", (t) => {
  const repo = loopRepo({ "core/greeting.cjs": "module.exports = () => 'hey';\n" });
  t.after(repo.cleanup);
  repo.write("core/greeting.cjs", "module.exports = () => 'hello';\n");
  repo.write("core/farewell.cjs", "module.exports = () => 'bye';\n");
  repo.write("docs/travail/tickets/001-add-greeting.md", ticketText() + "- jalon\n");
  const first = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(first.code, 0, first.out);
  const dir = ".harness-state/tickets/T001/";
  assert.deepEqual(first.stdout.trim().split("\n"), ["revue-1.diff", "revue-1.fichiers", "reviewed-state.json"].map((f) => dir + f));
  const diff = repo.read(dir + "revue-1.diff");
  assert.match(diff, /^-module\.exports = \(\) => 'hey';$/m);
  assert.match(diff, /^\+module\.exports = \(\) => 'bye';$/m);
  assert.doesNotMatch(diff, /jalon/);
  assert.equal(repo.read(dir + "revue-1.fichiers"), " M core/greeting.cjs\n?? core/farewell.cjs\n");
  const second = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.match(second.stdout, /revue-2\.diff/);
});

test("recording a review fails with a clear message when the list of files untracked before the session is unreadable", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  repo.write(".harness-state/tickets/T001/untracked-before.json", "{ not json");
  const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /untracked-before\.json est illisible/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T001/revue-1.diff")), false);
});

for (const previous of ["corrupt", "legacy", "missing", "missing-tree", "blob", "option", "diff-failure"]) {
  test(`record recovers a ${previous} previous state and resumes interdiffs on the following record`, (t) => {
    const repo = loopRepo();
    t.after(repo.cleanup);
    const dir = ".harness-state/tickets/T001/";
    const record = () => repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
    repo.write("core/greeting.cjs", "module.exports = 'before';\n");
    assert.equal(record().code, 0);
    if (previous === "corrupt") repo.write(dir + "reviewed-state.json", "{ incomplete");
    if (previous === "missing") fs.rmSync(path.join(repo.root, dir + "reviewed-state.json"));
    if (previous === "legacy") repo.write(dir + "reviewed-state.json", JSON.stringify({ revue: "revue-1.diff", fichiers: {} }));
    const output = path.join(repo.root, ".harness-state/unexpected-output");
    const trees = {
      "missing-tree": "0".repeat(40),
      blob: repo.git("hash-object", "-w", "core/greeting.cjs").stdout.trim(),
      option: `--output=${output}`,
    };
    if (trees[previous]) repo.write(dir + "reviewed-state.json", JSON.stringify({ revue: "revue-1.diff", fichiers: {}, arbre: trees[previous] }));
    if (previous === "diff-failure") {
      repo.write("core/trigger.cjs", "module.exports = 'force a diff';\n");
      assert.equal(repo.git("config", "diff.external", "false").code, 0);
    }
    const recovered = record();
    assert.equal(fs.existsSync(output), false, "an old tree must never be interpreted as a Git option");
    assert.equal(recovered.code, 0, recovered.out);
    assert.doesNotMatch(recovered.stdout, /interdiff/);
    assert.equal(fs.existsSync(path.join(repo.root, dir + "revue-2.interdiff")), false);
    if (previous === "diff-failure") assert.equal(repo.git("config", "--unset", "diff.external").code, 0);
    repo.write("core/greeting.cjs", "module.exports = 'after';\n");
    const next = record();
    assert.equal(next.code, 0, next.out);
    assert.match(next.stdout, /revue-3\.interdiff/);
    assert.ok(repo.read(dir + "revue-3.interdiff").includes("-module.exports = 'before';"));
  });
}

test("record recovers a corrupt state even before any numbered review exists", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  repo.write(".harness-state/tickets/T001/reviewed-state.json", "{ incomplete");
  const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.stdout, /revue-1\.diff/);
  repo.write("core/greeting.cjs", "module.exports = 'after recovery';\n");
  const next = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(next.code, 0, next.out);
  assert.ok(repo.read(".harness-state/tickets/T001/revue-2.interdiff").includes("+module.exports = 'after recovery';"));
});

for (const status of ["AD", "RD"]) {
  test(`record accepts a staged path deleted from disk with status ${status} without changing the real index`, (t) => {
    const repo = loopRepo({ "core/greeting.cjs": "module.exports = 'hello';\n" });
    t.after(repo.cleanup);
    const file = "core/removed.cjs";
    if (status === "AD") {
      repo.write(file, "module.exports = 'temporary';\n");
      assert.equal(repo.git("add", "--", file).code, 0);
    } else {
      assert.equal(repo.git("mv", "core/greeting.cjs", file).code, 0);
    }
    fs.rmSync(path.join(repo.root, file));
    const before = repo.git("status", "--porcelain", "-z").stdout;
    assert.ok(before.includes(`${status} ${file}`), before);
    const index = fs.readFileSync(path.join(repo.root, ".git/index"));
    const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(fs.readFileSync(path.join(repo.root, ".git/index")), index);
    assert.equal(repo.git("status", "--porcelain", "-z").stdout, before);
    repo.write(file, "module.exports = 'restored target';\n");
    if (status === "RD") repo.write("core/greeting.cjs", "module.exports = 'restored source';\n");
    const next = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
    assert.equal(next.code, 0, next.out);
    const diff = repo.read(".harness-state/tickets/T001/revue-2.interdiff");
    assert.ok(diff.includes(`diff --git a/${file} b/${file}\nnew file mode`), diff);
    assert.ok(diff.includes("+module.exports = 'restored target';"), diff);
    if (status === "RD") {
      assert.ok(diff.includes("diff --git a/core/greeting.cjs b/core/greeting.cjs\nnew file mode"), diff);
      assert.ok(diff.includes("+module.exports = 'restored source';"), diff);
    }
  });
}

test("record includes a force-added ignored file in the review diff and successive interdiffs without changing the real index", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const dir = ".harness-state/tickets/T001/";
  const record = () => {
    const status = repo.git("status", "--porcelain", "-z").stdout;
    const index = fs.readFileSync(path.join(repo.root, ".git/index"));
    const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(fs.readFileSync(path.join(repo.root, ".git/index")), index);
    assert.equal(repo.git("status", "--porcelain", "-z").stdout, status);
  };
  record();
  repo.write(".git/info/exclude", "core/ignored.cjs\ncore/untracked.cjs\n");
  repo.write("core/ignored.cjs", "module.exports = 'force-added';\n");
  repo.write("core/untracked.cjs", "module.exports = 'still ignored';\n");
  assert.equal(repo.git("add", "-f", "--", "core/ignored.cjs").code, 0);
  record();
  for (const suffix of ["diff", "interdiff"]) {
    const diff = repo.read(dir + "revue-2." + suffix);
    assert.match(diff, /diff --git a\/core\/ignored\.cjs b\/core\/ignored\.cjs\nnew file mode/);
    assert.ok(diff.includes("+module.exports = 'force-added';"), diff);
    assert.doesNotMatch(diff, /untracked|still ignored/);
  }
  repo.write("core/ignored.cjs", "module.exports = 'corrected';\n");
  record();
  const diff = repo.read(dir + "revue-3.interdiff");
  assert.ok(diff.includes("-module.exports = 'force-added';"), diff);
  assert.ok(diff.includes("+module.exports = 'corrected';"), diff);
});

test("record names add when a required clean filter fails while filling the temporary index", (t) => {
  const repo = loopRepo({ "core/greeting.cjs": "module.exports = 'hello';\n" });
  t.after(repo.cleanup);
  repo.write("core/greeting.cjs", "module.exports = 'corrected';\n");
  repo.write(".git/info/attributes", "core/greeting.cjs filter=review\n");
  assert.equal(repo.git("config", "filter.review.clean", "false").code, 0);
  assert.equal(repo.git("config", "filter.review.required", "true").code, 0);
  const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /\(add\)/);
  assert.doesNotMatch(result.out, /--literal-pathspecs/);
});

test("record interdiff includes only corrected files and preserves the working tree and real index", (t) => {
  const repo = loopRepo({ "core/greeting.cjs": "module.exports = 'hey';\n", "core/other.cjs": "module.exports = 1;\n" });
  t.after(repo.cleanup);
  const dir = ".harness-state/tickets/T001/";
  repo.write(dir + "untracked-before.json", JSON.stringify(["notes/personal.md"]));
  repo.write("notes/personal.md", "unrelated\n");
  repo.write("core/other.cjs", "module.exports = 2;\n");
  assert.equal(repo.git("add", "core/other.cjs").code, 0);
  repo.write("core/other.cjs", "module.exports = 3;\n");
  repo.write("core/greeting.cjs", "module.exports = 'hello';\n");
  repo.write("core/new.cjs", "module.exports = 'first review';\n");
  const record = (rank) => {
    const status = repo.git("status", "--porcelain", "-z", "--untracked-files=all").stdout;
    const index = fs.readFileSync(path.join(repo.root, ".git/index"));
    const result = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(fs.readFileSync(path.join(repo.root, ".git/index")), index);
    assert.equal(repo.git("status", "--porcelain", "-z", "--untracked-files=all").stdout, status);
    if (rank > 1) assert.ok(result.stdout.includes(dir + `revue-${rank}.interdiff`), result.stdout);
  };
  record(1);
  assert.equal(fs.existsSync(path.join(repo.root, dir + "revue-1.interdiff")), false);
  repo.write("core/greeting.cjs", "module.exports = 'corrected';\n");
  repo.write("core/new.cjs", "module.exports = 'corrected new file';\n");
  repo.write("core/café.cjs", "module.exports = 'created by correction';\n");
  repo.write("notes/personal.md", "still unrelated\n");
  repo.write("docs/travail/tickets/001-add-greeting.md", ticketText() + "- journal changed\n");
  record(2);
  const diff = repo.read(dir + "revue-2.interdiff");
  for (const text of ["core/greeting.cjs", "core/new.cjs", "created by correction", "-module.exports = 'hello';"]) {
    assert.ok(diff.includes(text), diff);
  }
  assert.ok(diff.includes("-module.exports = 'first review';"), diff);
  assert.doesNotMatch(diff, /core\/other|personal|journal changed/);
  repo.write("core/greeting.cjs", "module.exports = 'hey';\n");
  fs.rmSync(path.join(repo.root, "core/new.cjs"));
  record(3);
  const third = repo.read(dir + "revue-3.interdiff");
  assert.match(third, /deleted file mode/);
  assert.ok(third.includes("+module.exports = 'hey';"), third);
  assert.doesNotMatch(third, /core\/other|created by correction/);
});

test("files that were already untracked before the loop are left out of the ticket commit", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  repo.write("notes/personal.md", "mine\n");
  assert.equal(repo.loop("done").code, 0);
  assert.equal(repo.git("status", "--porcelain").stdout.trim(), "?? notes/");
});

for (const name of ["notes/personal.md", "notes/café.md"]) {
  test(`a file untracked before the loop and changed after the review stays out of the review and of the commit: ${name}`, (t) => {
    const repo = loopRepo();
    t.after(repo.cleanup);
    repo.write(name, "mine\n");
    const result = repo.loop("edits-untracked-after-review", ["--attempts", "1"]);
    assert.equal(result.code, 0, result.out);
    assert.equal(repo.commits()[0], "T001: Add the greeting");
    assert.doesNotMatch(repo.git("show", "--name-only", "--format=", "HEAD").stdout, /notes/);
    assert.equal(repo.git("status", "--porcelain").stdout.trim(), "?? notes/");
    const review = ".harness-state/tickets/T001/revue-1.";
    assert.doesNotMatch(repo.read(review + "diff") + repo.read(review + "fichiers"), /notes|mine/);
  });
}

test("a ticket that Git does not track is refused: its journal and status would stay out of its own commit", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  repo.write("docs/travail/tickets/002-add-farewell.md", ticketText({ id: "T002", titre: "Add the farewell" }));
  for (const args of [["--ticket", "T002", "--dry-run"], ["--ticket", "T002"]]) {
    const result = repo.loop("done", args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /T002 n'est pas suivi par Git/);
  }
  assert.deepEqual(repo.commits(), ["init"]);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
});

test("--ticket on a ticket that cannot start is refused with code 1 before any session and changes nothing; a queue with nothing ready ends in 0", (t) => {
  const repo = loopRepo({
    "docs/travail/tickets/001-add-greeting.md": ticketText({}, asksOwner),
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell", bloque_par: "T001" }),
  });
  t.after(repo.cleanup);
  const citesQuestion = /T001 attend une décision du propriétaire : which CI provider, and when\?/;
  for (const [args, expected] of [
    [["--ticket", "T001"], citesQuestion],
    [["--ticket", "T001", "--dry-run"], citesQuestion],
    [["--ticket", "T002"], /T002 n'est pas prêt/],
    [["--ticket", "T009"], /T009 n'existe pas/],
  ]) {
    const result = repo.loop("done", args);
    assert.equal(result.code, 1, `${args.join(" ")}\n${result.out}`);
    assert.match(result.out, expected);
    assert.equal(repo.status(), "a-faire");
    assert.equal(repo.git("status", "--porcelain").stdout.trim(), "");
    assert.deepEqual(repo.commits(), ["init"]);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets")), false, "no session was started");
  }
  const end = repo.loop("done");
  assert.equal(end.code, 0, end.out);
  assert.match(end.out, /attendent une décision du propriétaire : T001\./);
  assert.doesNotMatch(end.out, /En attente d'une décision/);

  const stuck = loopRepo({
    "docs/travail/tickets/001-add-greeting.md": ticketText({ statut: "en-cours" }),
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
  });
  t.after(stuck.cleanup);
  const refused = stuck.loop("done", ["--ticket", "T002"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /T001 est « en-cours »/);
  assert.equal(stuck.git("status", "--porcelain").stdout.trim(), "");
  assert.deepEqual(stuck.commits(), ["init"]);
  assert.equal(fs.existsSync(path.join(stuck.root, ".harness-state/loop/lock")), false);
  assert.equal(fs.existsSync(path.join(stuck.root, ".harness-state/tickets")), false, "no session was started");
});

test("the loop refuses to start on main, on a dirty tree, or with a malformed queue", (t) => {
  const dirty = loopRepo();
  t.after(dirty.cleanup);
  dirty.write("package.json", '{ "name": "changed" }\n');
  const refusedDirty = dirty.loop("done");
  assert.equal(refusedDirty.code, 1);
  assert.match(refusedDirty.out, /fichiers suivis sont modifiés/);

  const main = loopRepo();
  t.after(main.cleanup);
  main.git("branch", "-m", "main");
  assert.match(main.loop("done").out, /ne travaille pas sur main/);

  const malformed = loopRepo({ "docs/travail/tickets/002-other.md": ticketText({ id: "T001" }) });
  t.after(malformed.cleanup);
  assert.match(malformed.loop("done").out, /File de tickets invalide/);
});

test("a dry run names the next ticket and changes nothing", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /Prochain ticket : T001 — Add the greeting/);
  assert.equal(repo.status(), "a-faire");
  assert.equal(repo.git("status", "--porcelain").stdout.trim(), "");
});

test("a dry run says how often the instructions are tuned, or that they are not", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const every4 = repo.loop("done", ["--dry-run", "--tune-every", "4"]);
  assert.equal(every4.code, 0, every4.out);
  assert.match(every4.out, /Harmonisation des consignes : active, tous les 4 tickets intégrés\./);
  for (const args of [[], ["--tune-every", "0"]]) {
    const off = repo.loop("done", ["--dry-run", ...args]);
    assert.equal(off.code, 0, off.out);
    assert.match(off.out, /Harmonisation des consignes : désactivée/, args.join(" "));
  }
});

test("--tune-every takes a whole number of tickets, zero or more, and anything else is refused at start", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  for (const value of ["four", "-1", "1.5", "", undefined]) {
    const result = repo.loop("done", ["--dry-run", "--tune-every", ...(value === undefined ? [] : [value])]);
    assert.equal(result.code, 1, `${value}\n${result.out}`);
    assert.match(result.out, /--tune-every attend un nombre entier de tickets/, String(value));
  }
  assert.equal(repo.status(), "a-faire");
});

test("a dry run on a queue led by a ticket waiting for a decision names the first ready ticket and starts nothing", (t) => {
  const repo = loopRepo({
    "docs/travail/tickets/001-add-greeting.md": ticketText({}, asksOwner),
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
  });
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--dry-run"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Prochain ticket : T002 — Add the farewell/);
  assert.match(result.out, /En attente d'une décision du propriétaire : T001\./);
  assert.equal(repo.git("status", "--porcelain").stdout.trim(), "");
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets")), false, "no session was started");
});

test("the tickets waiting for a decision are named once per run, even when several tickets are processed", (t) => {
  const repo = loopRepo({
    "docs/travail/tickets/001-add-greeting.md": ticketText({}, asksOwner),
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
    "docs/travail/tickets/003-add-welcome.md": ticketText({ id: "T003", titre: "Add the welcome" }),
  });
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--max", "2", "--no-retro"]);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(repo.commits(), ["T003: Add the welcome", "T002: Add the farewell", "init"]);
  assert.equal(result.out.match(/En attente d'une décision du propriétaire : T001\./g).length, 1, result.out);
});

test("a Codex dry run lists its engine and every planned model and effort", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--dry-run", "--engine", "codex"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Moteur : codex/);
  for (const line of [
    "Palier 0 : gpt-6.1-sol, effort high, relecteur opus",
    "Palier 1 : gpt-6.1-sol, effort xhigh, relecteur opus",
    "Palier 2 : gpt-6-astra, effort xhigh, relecteur opus",
    "Palier 3 : gpt-6-astra, effort max, relecteur fable",
  ]) assert.ok(result.out.includes(line), result.out);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
});

test("an unknown engine is refused before any session or state change", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  for (const value of ["autre", "", null]) {
    const args = ["--engine", ...(value === null ? [] : [value])];
    const result = repo.loop("done", args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /--engine/);
    assert.equal(repo.git("status", "--porcelain").stdout, "");
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets")), false);
  }
});

const codexDir = ".harness-state/tickets/T001/";
const jsonLines = (repo, file) => repo.read(codexDir + file).trim().split("\n").map(JSON.parse);
function codexRepo(fields = {}, files = {}) {
  const repo = loopRepo({ "docs/travail/tickets/001-add-greeting.md": ticketText(fields), ...files });
  const bin = linkFakeAgent(repo, "codex");
  const codex = (args = [], env = {}) => repo.loop("done", ["--engine", "codex", "--no-retro", ...args], { HARNESS_CODEX_BIN: bin, ...env });
  return { ...repo, codex };
}

test("a sensitive Codex ticket starts on Sol with xhigh effort in both the dry run and the actual session", (t) => {
  const repo = codexRepo({ niveau: "sensible" });
  t.after(repo.cleanup);
  const dry = repo.codex(["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Première tentative : gpt-6\.1-sol, effort xhigh, relecteur opus\./);
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  const { args } = jsonLines(repo, "fake-codex-calls")[0];
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
});

for (const harness of [false, true]) {
  test(`Codex only adds its configuration and skill directories for a harness ticket, including corrections: ${harness}`, (t) => {
    const repo = codexRepo({ harnais: harness ? "oui" : "non", niveau: "standard" });
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]) });
    assert.equal(result.code, 0, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 2);
    for (const { args } of calls) {
      const dirs = args.flatMap((arg, i) => arg === "--add-dir" ? [args[i + 1]] : []);
      assert.deepEqual(dirs, harness ? [path.join(repo.root, ".codex"), path.join(repo.root, ".agents")] : []);
    }
  });
}

test("the retrospective of a Codex attempt cites its stream without an unknown compaction count", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--engine", "codex"], { HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs") });
  assert.equal(result.code, 0, result.out);
  const digest = repo.read(codexDir + "retro-entree.md");
  assert.ok(digest.includes(codexDir + "codex-1.jsonl"), digest);
  assert.doesNotMatch(digest, /session-1\.jsonl|undefined|compaction/);
});

test("a Codex ticket accepted on its first review is integrated with safe options and its own signature", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  assert.ok(fs.existsSync(path.join(repo.root, codexDir, "fake-codex-calls")), "the loop must launch Codex");
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 1);
  const { args, cwd, stdin, env } = calls[0];
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  const option = (name) => args[args.indexOf(name) + 1];
  assert.equal(option("-s"), "workspace-write");
  assert.equal(option("-C"), repo.root);
  assert.equal(option("-m"), "gpt-6.1-sol");
  for (const value of [
    'approval_policy="never"', 'sandbox_workspace_write.network_access=true', 'model_reasoning_effort="high"',
  ]) assert.ok(args.some((arg, i) => arg === "-c" && args[i + 1] === value), args.join(" "));
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.ok(args.includes("--dangerously-bypass-hook-trust"));
  assert.ok(args.at(-1).includes(".agents/skills/ticket-codex/SKILL.md"));
  assert.equal(cwd, repo.root);
  assert.equal(stdin, "");
  assert.deepEqual(env, { LOOP: "1", TICKET: "T001", TICKET_FILE: "docs/travail/tickets/001-add-greeting.md", EDIT: "0", ALLOW_INSTALL: "0" });
  const review = jsonLines(repo, "fake-review-calls")[0];
  assert.equal(review.model, "opus");
  assert.ok(review.args.includes("--strict-mcp-config"));
  assert.equal(review.args[review.args.indexOf("--output-format") + 1], "json");
  for (const file of ["001-add-greeting.md", "revue-1.diff", "revue-1.fichiers"]) assert.ok(review.prompt.includes(file), review.prompt);
  assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(r => r.verdict), ["accepté"]);
  assert.equal(JSON.parse(repo.read(codexDir + "verdict.json")).resume, "fake codex");
  assert.equal(repo.status(), "termine");
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /Co-Authored-By: Codex \(GPT-6.1 Sol\) <noreply@openai.com>/);
  assert.equal(repo.events().find(e => e.phase === "session").moteur, "codex");
  const ended = repo.events().find(e => e.phase === "session-terminee");
  assert.deepEqual(ended.jetons, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 });
  assert.equal(ended.tours, 1);
  assert.equal(ended.relectures, 1);
  assert.equal(ended.cout_usd, null);
  assert.ok(Number.isFinite(ended.duree_s) && ended.duree_s >= 0);
  assert.match(result.out, /\[boucle\] \d\d:\d\d  Bash node --test/);
  assert.match(result.out, /\[boucle\] \d\d:\d\d  Write core\/greeting.cjs/);
  assert.equal(jsonLines(repo, "codex-1.jsonl").length, 5);
});

const rejectedReview = "VERDICT : à corriger\nCONSTATS : 1 bloquant, 1 mineur, 0 hors périmètre\n- core/greeting.cjs:1 : preuve manquante.\n- nom à préciser.";
const acceptedReview = "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 0 hors périmètre";
const correctedReview = (report) => report.replace(/^(CONSTATS[^\n]*)/m, "$1\nNON CORRIGÉS : 0");

const quotaAfterWork = [
  { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
  { type: "turn.completed", usage: { input_tokens: 13, output_tokens: 7 } }, { type: "turn.started" }, ...QUOTA_EVENTS,
];
const quotaWorkEnv = {
  FAKE_CODEX_EVENTS: JSON.stringify([quotaAfterWork]), FAKE_CODEX_JOURNAL: "- jalon : travail Codex conservé\n",
  FAKE_CODEX_EDIT: "core/partial.cjs", FAKE_EXPECT_QUOTA_WORK: "T001",
};

test("a requested quota fallback hands the existing work once to Claude at the same useful rung", (t) => {
  const repo = codexRepo({ niveau: "sensible" }, {
    "core/greeting.cjs": "module.exports = () => 'before';\n",
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002" }),
  });
  t.after(repo.cleanup);
  repo.write("notes/café personnel.md", "mine\n");
  const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1", "--max", "1",
    "--model", "custom Codex model", "--effort", "max", "--budget-usd", "3", "--compact-window", "12345"], quotaWorkEnv);
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.status(), "termine");
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 1);
  const resumed = JSON.parse(repo.read(codexDir + "fallback-observed.json"));
  assert.notEqual(resumed.pid, calls[0].loopPid);
  assert.equal(resumed.lock, String(resumed.pid));
  assert.ok(Math.abs(resumed.launchedAt - calls[0].launchedAt) < 0.01);
  assert.equal(resumed.engine, null);
  assert.deepEqual(resumed.exclusions, ["notes/café personnel.md"]);
  assert.match(resumed.diff, /-module.exports = \(\) => 'before'/);
  assert.match(resumed.diff, /travail Codex conservé/);
  assert.match(resumed.partial, /modification interdite/);
  assert.match(resumed.prompt, /journal.*diff/i);
  assert.match(resumed.prompt, /releve-quota-.*\.diff/);
  assert.deepEqual(repo.plans(), [{ model: "claude-opus-5-5", effort: "high", review: "opus" }]);
  assert.equal(resumed.window, "12345");
  assert.equal(resumed.args[resumed.args.indexOf("--max-budget-usd") + 1], "3");
  const events = repo.events();
  assert.equal(events.filter(e => e.phase === "quota-epuise").length, 1);
  assert.equal(events.filter(e => e.phase === "relance").length, 1);
  assert.equal(events.some(e => ["tentative-refusee", "retro", "harmonisation"].includes(e.phase)), false);
  assert.equal(events.find(e => e.phase === "integre").tentatives, 1);
  assert.equal(events.find(e => e.phase === "integre").cout_usd, null);
  const codexEnded = events.find(e => e.phase === "session-terminee" && e.moteur === "codex");
  assert.equal(codexEnded.jetons.input_tokens, 13);
  assert.equal(codexEnded.invocations.length, 1);
  const reviewed = JSON.parse(repo.read(codexDir + "reviewed-state.json"));
  assert.ok(reviewed.fichiers["core/partial.cjs"]);
  assert.ok(reviewed.fichiers["core/greeting.cjs"]);
  assert.equal(jsonLines(repo, "relectures.jsonl").at(-1).verdict, "accepté");
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /Claude Opus 5\.5 <noreply@anthropic.com>/);
  assert.equal(repo.git("ls-files", "notes/café personnel.md").stdout, "");
  assert.equal(repo.read("notes/café personnel.md"), "mine\n");
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
  for (const call of calls) noProcess(call.loopPid);
  noProcess(resumed.pid);
});

test("invalid or repeated fallback options are refused before any agent or ticket change", (t) => {
  const invalid = [
    ["--fallback-engine", "codex"], ["--fallback-engine", "unknown"], ["--fallback-engine", ""], ["--fallback-engine"],
    ["--engine", "claude", "--fallback-engine", "claude"],
    ["--engine", "codex", "--fallback-engine", "claude", "--fallback-engine", "claude"],
    ["--engine", "codex", "--fallback-engine", "claude", "--fallback-engine", "unknown"],
  ];
  for (const args of invalid) {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.loop("done", args, { HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs") });
    assert.equal(result.code, 1, args.join(" ") + "\n" + result.out);
    assert.match(result.out, /--fallback-engine/);
    assert.equal(repo.git("status", "--porcelain").stdout, "");
    assert.deepEqual(repo.commits(), ["init"]);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets")), false);
  }
});

for (const engine of ["codex", "claude"]) {
  test(`a quota fallback protects initially untracked files staged by ${engine}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    repo.write("notes/personal.md", "mine\n");
    const env = { ...quotaWorkEnv, [engine === "codex" ? "FAKE_CODEX_STAGE" : "FAKE_CLAUDE_STAGE"]: "notes/personal.md" };
    const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], env);
    assert.equal(result.code, engine === "codex" ? 1 : 2, result.out);
    assert.deepEqual(repo.commits(), ["init"]);
    assert.match(engine === "codex" ? result.out : repo.failure(), /non suivis préexistants/);
    assert.equal(repo.read("notes/personal.md"), "mine\n");
    assert.match(repo.git("diff", "--cached", "--name-only").stdout, /notes\/personal\.md/);
  });
}

for (const engine of ["codex", "claude"]) {
  test(`a quota fallback refuses changed initial non-tracked content from ${engine} and leaves it intact`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    repo.write("notes/personal.md", "mine\n");
    const env = engine === "codex" ? { FAKE_CODEX_EDIT: "notes/personal.md" } : { FAKE_SCENARIO: "edits-untracked-after-review" };
    const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], { ...quotaWorkEnv, ...env });
    assert.equal(result.code, engine === "codex" ? 1 : 2, result.out);
    assert.match(engine === "codex" ? result.out : repo.failure(), /non suivis préexistants/);
    assert.match(repo.read("notes/personal.md"), engine === "codex" ? /modification interdite/ : /changed after the review/);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

for (const stage of ["capacity", "correction"]) {
  test(`a requested quota fallback also resumes the work interrupted during a ${stage} retry`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], {
      ...quotaWorkEnv, FAKE_CODEX_EVENTS: "null", FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([null, QUOTA_EVENTS]),
      FAKE_CODEX_FAILURES: JSON.stringify(stage === "capacity" ? ["capacity-after-usage", ""] : ["", ""]),
      FAKE_REVIEWS: JSON.stringify(stage === "correction" ? [rejectedReview] : []), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, 0, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    assert.equal(repo.attempts(), "1");
    const ended = repo.events().find(e => e.phase === "session-terminee" && e.moteur === "codex");
    assert.equal(ended.invocations.length, 2);
    assert.equal(ended.relectures, stage === "correction" ? 1 : 0);
    assert.equal(ended.jetons.input_tokens, 10);
    assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 1);
    assert.equal(repo.events().filter(e => e.phase === "relance").length, 1);
    assert.equal(jsonLines(repo, "relectures.jsonl").at(-1).verdict, "accepté");
  });
}

test("a quota fallback preserves prior refusals and maps a forced Codex model to the current Claude rung", (t) => {
  const repo = codexRepo({ niveau: "sensible" });
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--attempts", "2", "--model", "custom codex", "--effort", "max"], {
    ...quotaWorkEnv, FAKE_CODEX_EVENTS: JSON.stringify([null, quotaAfterWork]), FAKE_CODEX_FAILURES: JSON.stringify(["error", ""]),
  });
  assert.equal(result.code, 0, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.deepEqual(repo.plans(), [{ model: "claude-opus-5-5", effort: "xhigh", review: "opus" }]);
  assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
  assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 2);
  assert.ok(JSON.parse(repo.read(codexDir + "fallback-observed.json")).prompt.includes("echec-1.txt"));
  assert.match(repo.failure(), /simulated Codex failure/);
  assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.attempt), [1, 2, 2]);
});

test("a partial Claude fallback uses the remaining attempts without another engine transition", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--attempts", "2"], {
    ...quotaWorkEnv, FAKE_SCENARIO: "partial-then-done",
  });
  assert.equal(result.code, 0, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
  assert.equal(repo.attempts(), "2");
  assert.deepEqual(repo.plans().map(p => p.effort), ["high", "high"]);
  assert.equal(repo.events().filter(e => e.phase === "relance").length, 1);
  assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 2);
  const prompts = jsonLines(repo, "fake-prompts");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Codex a été interrompu par son quota.*releve-quota-.*\.diff/);
  assert.match(prompts[1], /echec-1\.txt/);
  assert.doesNotMatch(prompts[1], /Codex a été interrompu par son quota|releve-quota-/);
});

for (const retro of [true, false]) {
  test(`a nonzero Claude exit after a partial quota fallback counts toward blocking with retrospective ${retro}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.loop("partial-then-failure", [
      "--engine", "codex", "--fallback-engine", "claude", "--attempts", "2", ...(retro ? [] : ["--no-retro"]),
    ], { ...quotaWorkEnv, HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs") });
    assert.equal(result.code, 2, result.out);
    assert.equal(repo.status(), "bloque");
    assert.equal(repo.attempts(), "2");
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    const events = repo.events();
    assert.deepEqual(events.filter(e => e.phase === "tentative-refusee").map(e => e.attempt), [1, 2]);
    const failure = repo.read(codexDir + "echec-2.txt");
    assert.match(failure, /sans verdict.*code de sortie 1/);
    assert.equal(events.some(e => e.phase === "relance-echouee"), false);
    assert.equal(events.find(e => e.phase === "bloque").tentatives, 2);
    assert.equal(events.filter(e => e.phase === "retro").length, retro ? 1 : 0);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir + "fake-retro-call")), retro);
    if (retro) {
      const digest = repo.read(codexDir + "retro-entree.md");
      assert.match(digest, /Issue : bloqué/);
      assert.ok(digest.includes(failure.trim()), digest);
      assert.ok(events.findIndex(e => e.phase === "retro") > events.findIndex(e => e.phase === "bloque"));
    }
    assert.deepEqual(repo.commits(), ["init"]);
    assert.match(repo.read("core/partial.cjs"), /modification interdite/);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
  });
}

test("a forced Codex model keeps its implicit three-attempt budget after a quota fallback", (t) => {
  const repo = codexRepo({ niveau: "simple" });
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--model", "custom codex"], {
    ...quotaWorkEnv, FAKE_SCENARIO: "silent",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(repo.attempts(), "3");
  assert.deepEqual(repo.plans().map(p => [p.model, p.effort]), [
    ["claude-sonnet-5-5", "high"], ["claude-opus-5-5", "high"], ["claude-opus-5-5", "xhigh"],
  ]);
  assert.equal(repo.events().find(e => e.phase === "bloque").tentatives, 3);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
});

for (const [scenario, diagnostic] of [
  ["changes-after-review", /modifié depuis la dernière relecture/],
  ["done-without-review", /Aucune relecture n'est enregistrée/],
  ["review-rejected", /dernier relecteur n'a pas accepté/],
  ["long-line", /contrôle qualité complet est rouge/],
  ["edits-harness", /harnais a été modifié sans/],
]) {
  test(`a quota fallback still requires the ordinary integration gates: ${scenario}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], { ...quotaWorkEnv, FAKE_SCENARIO: scenario });
    assert.equal(result.code, 2, result.out);
    assert.deepEqual(repo.commits(), ["init"]);
    assert.equal(repo.status(), "bloque");
    assert.match(repo.failure(), diagnostic);
    assert.equal(repo.events().filter(e => e.phase === "relance").length, 1);
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    assert.ok(fs.existsSync(path.join(repo.root, "core/partial.cjs")));
  });
}

for (const failure of ["missing executable", "failed session"]) {
  test(`a refused Claude quota fallback leaves a recoverable ticket and all its work: ${failure}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const env = failure === "missing executable" ? { HARNESS_CLAUDE_BIN: path.join(repo.root, ".harness-state/absent") } :
      { FAKE_CLAUDE_FAILURE: "1" };
    const result = repo.codex(["--fallback-engine", "claude", "--attempts", "2"], { ...quotaWorkEnv, ...env });
    assert.equal(result.code, 1, result.out);
    assert.equal(repo.status(), "a-faire");
    assert.deepEqual(repo.commits(), ["init"]);
    assert.match(result.out, /relève Claude a échoué/);
    assert.match(repo.read("core/greeting.cjs"), /hello/);
    assert.match(repo.read("core/partial.cjs"), /modification interdite/);
    assert.match(repo.read("docs/travail/tickets/001-add-greeting.md"), /travail Codex conservé/);
    assert.equal(repo.events().some(e => ["tentative-refusee", "bloque", "integre"].includes(e.phase)), false);
    assert.equal(repo.events().filter(e => e.phase === "session" && e.moteur !== "codex").length, 1);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
  });
}

test("a quota before any work can fall back without consuming an attempt", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], {
    FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([QUOTA_EVENTS]),
  });
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 1);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
  assert.equal(repo.attempts(), "1");
});

test("a quota fallback requires a new Claude review even when an older accepted state matches its final work", async (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  repo.write("core/greeting.cjs", "module.exports = () => 'hello';\n");
  const recorded = repo.node("scripts/loop/reviewed-state.mjs", ["record", "--ticket", "T001"]);
  assert.equal(recorded.code, 0, recorded.out);
  const { recordReview } = await import(pathToFileURL(path.join(repo.root, "scripts/loop/reviewed-state.mjs")).href);
  recordReview(repo.root, "T001", { verdict: "accepté", modele: "opus", report: acceptedReview });
  fs.rmSync(path.join(repo.root, "core/greeting.cjs"));
  const result = repo.codex(["--fallback-engine", "claude", "--attempts", "1"], {
    FAKE_CODEX_EVENTS: JSON.stringify([quotaAfterWork]), FAKE_SCENARIO: "done-without-review",
  });
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /nouvelle relecture.*Claude.*quota/i);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a captured quota handoff is consumed once and a manifest alone cannot authorize an ordinary dirty launch", async (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const { describe, spec } = await tickets();
  const { captureQuotaHandoff, consumeQuotaHandoff } = await import(pathToFileURL(path.join(repo.root, "scripts/loop/quota-handoff.mjs")).href);
  repo.write(codexDir + "untracked-before.json", "[]\n");
  repo.write("core/partial.cjs", "module.exports = 'partial';\n");
  const file = "docs/travail/tickets/001-add-greeting.md";
  const text = repo.read(file) + "- travail en cours\n";
  repo.write(file, text);
  const expected = {
    ticket: describe(file, text), specification: spec(text), branch: "work",
    head: repo.git("rev-parse", "HEAD").stdout.trim(), untrackedBefore: [], preexisting: {},
  };
  const handoff = captureQuotaHandoff(repo.root, expected);
  const refused = repo.codex(["--fallback-engine", "claude"]);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /fichiers suivis sont modifiés/);
  const status = repo.git("status", "--porcelain", "-z").stdout;
  const first = consumeQuotaHandoff(repo.root, handoff, expected);
  assert.match(repo.read(first.diff), /partial/);
  assert.equal(repo.git("status", "--porcelain", "-z").stdout, status);
  assert.throws(() => consumeQuotaHandoff(repo.root, handoff, expected), {
    code: "QUOTA_HANDOFF_REFUSED", message: /déjà consommé/,
  });
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a fallback dry run documents the translation and leaves the ticket untouched", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--dry-run", "--model", "custom codex"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Secours après quota : Claude.*palier.*--model.*--effort/);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets")), false);
});

test("a quota on the second ticket preserves the global max and runs each due retrospective and tuning once", (t) => {
  const repo = codexRepo({}, {
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
    "docs/travail/tickets/003-add-welcome.md": ticketText({ id: "T003", titre: "Add the welcome" }),
    ".claude/skills/ticket/SKILL.md": "# Ticket\n",
  });
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", impact: "fort" })]);
  const result = repo.loop("done", ["--engine", "codex", "--fallback-engine", "claude", "--max", "2", "--ticket", "T001",
    "--tune-every", "2", "--permission-mode", "mode with spaces", "--budget-usd", "3", "--timeout-min", "7"], {
    ...quotaWorkEnv, FAKE_CODEX_EVENTS: "null", FAKE_CODEX_EVENTS_BY_TICKET: JSON.stringify({ T002: [quotaAfterWork] }),
    FAKE_EXPECT_QUOTA_WORK: "T002", HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs"), FAKE_TUNE: "edits-skill",
  });
  assert.equal(result.code, 0, result.out);
  const events = repo.events();
  assert.deepEqual(events.filter(e => e.phase === "integre").map(e => e.ticket), ["T001", "T002"]);
  assert.deepEqual(events.filter(e => e.phase === "retro").map(e => e.ticket), ["T001", "T002"]);
  assert.equal(events.filter(e => e.phase === "harmonisation-integree").length, 1);
  assert.equal(events.filter(e => e.phase === "relance").length, 1);
  assert.equal(events.find(e => e.phase === "relance").termines, 1);
  assert.equal(events.find(e => e.phase === "relance").integres, 1);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T003")), false);
  const resumed = JSON.parse(repo.read(".harness-state/tickets/T002/fallback-observed.json"));
  assert.equal(resumed.args[resumed.args.indexOf("--permission-mode") + 1], "mode with spaces");
  assert.equal(resumed.args[resumed.args.indexOf("--max-budget-usd") + 1], "3");
  const digest = repo.read(".harness-state/tickets/T002/retro-entree.md");
  assert.match(digest, /codex-1\.jsonl/);
  assert.match(digest, /session-1\.jsonl/);
  assert.match(digest, /Quota Codex épuisé/);
});

test("Claude remains the engine after a quota fallback integrates a loop module and starts the next ticket", (t) => {
  const repo = codexRepo({ harnais: "oui", niveau: "simple" }, {
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002" }),
    "docs/travail/tickets/003-add-welcome.md": ticketText({ id: "T003" }),
  });
  t.after(repo.cleanup);
  const result = repo.codex(["--fallback-engine", "claude", "--max", "2"], {
    ...quotaWorkEnv, FAKE_SCENARIO: "reload-module", FAKE_RELOAD_MODULE: "scripts/loop/models.mjs",
  });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.moteur ?? "claude"), ["codex", "claude", "claude"]);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
  assert.notEqual(observedLoop(repo, "T001").pid, observedLoop(repo, "T002").pid);
  assert.equal(repo.events().filter(e => e.phase === "relance").length, 2);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T003")), false);
});

function observeQuotaHandoff(repo) {
  const file = path.join(repo.root, ".harness-state/quota-observer.cjs");
  repo.write(".harness-state/quota-observer.cjs", `
const fs = require("node:fs");
process.on("message", message => {
  if (message.type !== "loop-start" || !message.state.quotaResume) return;
  if (process.env.FAKE_INCOMPLETE_HANDOFF === "1") delete message.state.quotaResume.handoff;
  fs.writeFileSync(".harness-state/quota-message.json", JSON.stringify(message.state));
  const notify = 'process.kill(Number(process.argv[1]), "SIGSTOP");' +
    'require("node:fs").writeFileSync(".harness-state/quota-ready", process.argv[1]);' +
    'process.kill(Number(process.env.FAKE_OBSERVER_PID), "SIGWINCH");';
  require("node:child_process").spawnSync(process.execPath, ["-e", notify, String(process.pid)]);
});
`);
  return { NODE_OPTIONS: `--require=${file}`, HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs") };
}

const handoffChanges = {
  head(repo) { assert.equal(repo.git("commit", "--allow-empty", "-q", "-m", "external commit").code, 0); },
  branch(repo) { assert.equal(repo.git("branch", "-m", "external-branch").code, 0); },
  specification(repo) {
    const file = "docs/travail/tickets/001-add-greeting.md";
    repo.write(file, repo.read(file).replace("says hello", "says something else"));
  },
  completed(repo) {
    const file = "docs/travail/tickets/001-add-greeting.md";
    repo.write(file, repo.read(file).replace("statut: a-faire", "statut: termine"));
  },
  tracked(repo) { repo.write("core/greeting.cjs", "module.exports = 'changed';\n"); },
  added(repo) { repo.write("core/other.cjs", "module.exports = 'extra';\n"); },
  removed(repo) { fs.rmSync(path.join(repo.root, "core/partial.cjs")); },
  index(repo) { assert.equal(repo.git("add", "--", "core/greeting.cjs").code, 0); },
  mode(repo) { fs.chmodSync(path.join(repo.root, "core/greeting.cjs"), 0o755); },
  preexisting(repo) { repo.write("notes/café personnel.md", "changed externally\n"); },
  exclusions(repo) { repo.write(codexDir + "untracked-before.json", JSON.stringify(["core/partial.cjs"])); },
  manifest(repo, base) { repo.write(base + ".json", "{}\n"); },
  missing(repo, base) { fs.rmSync(path.join(repo.root, base + ".json")); },
  patch(repo, base) { repo.write(base + ".diff", "changed patch\n"); },
  consumed(repo, base) { repo.write(base + ".consumed", "already used\n"); },
  incomplete() { /* Le préchargement retire le descripteur IPC avant sa réception. */ },
};

for (const [change, mutate] of Object.entries(handoffChanges)) {
  test(`a retained quota handoff refuses a changed ${change} boundary without modifying the work`, { timeout: 20000 }, async (t) => {
    const repo = codexRepo({}, { "core/greeting.cjs": "module.exports = 'before';\n" });
    repo.write("notes/café personnel.md", "mine\n");
    const run = startObservedLoop(t, repo, ["--engine", "codex", "--fallback-engine", "claude", "--no-retro"], {
      ...quotaWorkEnv, ...observeQuotaHandoff(repo), FAKE_SCENARIO: "done", FAKE_INCOMPLETE_HANDOFF: change === "incomplete" ? "1" : "0",
    });
    t.after(repo.cleanup);
    const successor = Number(await run.waitFor("quota-ready"));
    const first = jsonLines(repo, "fake-codex-calls")[0];
    noProcess(first.loopPid);
    assert.equal(repo.read(".harness-state/loop/lock"), String(run.child.pid));
    const state = JSON.parse(repo.read(".harness-state/quota-message.json"));
    const base = codexDir + "releve-quota-" + state.quotaResume.handoff?.token;
    const ordinary = repo.codex(["--fallback-engine", "claude"]);
    assert.equal(ordinary.code, 1, ordinary.out);
    assert.match(ordinary.out, /fichiers suivis sont modifiés/);
    mutate(repo, base);
    const before = {
      status: repo.git("status", "--porcelain", "-z", "--untracked-files=all").stdout,
      index: repo.git("diff", "--cached", "--binary").stdout,
      diff: repo.git("diff", "HEAD", "--binary").stdout,
      head: repo.git("rev-parse", "HEAD").stdout, personal: repo.read("notes/café personnel.md"),
    };
    process.kill(successor, "SIGCONT");
    assert.deepEqual(await run.ended, { code: 1, signal: null });
    assert.equal(repo.git("status", "--porcelain", "-z", "--untracked-files=all").stdout, before.status);
    assert.equal(repo.git("diff", "--cached", "--binary").stdout, before.index);
    assert.equal(repo.git("diff", "HEAD", "--binary").stdout, before.diff);
    assert.equal(repo.git("rev-parse", "HEAD").stdout, before.head);
    assert.equal(repo.read("notes/café personnel.md"), before.personal);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir + "fake-plans")), false);
    assert.match(repo.read(".harness-state/output.log"), /relève Claude est refusée/i);
    assert.ok(repo.events().some(e => e.phase === "relance-echouee"));
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
    noProcess(successor);
    noProcess(run.child.pid);
  });
}

for (const stage of ["before", "after"]) {
  for (const [form, quota] of [["error", QUOTA_EVENTS.slice(0, 1)], ["turn.failed", QUOTA_EVENTS.slice(1)], ["both", QUOTA_EVENTS]]) {
    test(`Codex stops on quota ${stage} work: ${form}`, (t) => {
      const repo = codexRepo();
      t.after(repo.cleanup);
      repo.write("scripts/check.mjs", 'import fs from "node:fs";\nfs.writeFileSync(".harness-state/check-ran", "");\n');
      repo.write("docs/travail/tickets/002-add-farewell.md", ticketText({ id: "T002" }));
      assert.equal(repo.git("add", "-A").code, 0);
      assert.equal(repo.git("commit", "-q", "-m", "observe quota interruption").code, 0);
      const commits = repo.commits();
      const afterWork = stage === "after";
      if (!afterWork) repo.write("notes/personal.md", "mine\n");
      const usage = { input_tokens: 13, output_tokens: 7 };
      const events = afterWork ? [
        { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
        { type: "turn.completed", usage }, { type: "turn.started" }, ...quota,
      ] : quota;
      const result = repo.loop("done", ["--engine", "codex", "--max", "2", "--tune-every", "1"], {
        HARNESS_CODEX_BIN: path.join(repo.root, ".harness-state/fake-codex.cjs"), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
        [afterWork ? "FAKE_CODEX_EVENTS" : "FAKE_CODEX_BEFORE_WORK_EVENTS"]: JSON.stringify([events]),
        FAKE_CODEX_JOURNAL: "- jalon : travail conservé\n",
      });
      assert.equal(result.code, 5, result.out);
      assert.equal(repo.status(), "a-faire");
      assert.deepEqual(repo.commits(), commits);
      const calls = jsonLines(repo, "fake-codex-calls");
      assert.equal(calls.length, 1);
      noProcess(calls[0].pid);
      noProcess(calls[0].loopPid);
      assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
      const stopped = repo.events().filter(e => e.phase === "quota-epuise");
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].ticket, "T001");
      assert.equal(stopped[0].reprise, "Oct 22nd, 2026 8:41 AM");
      assert.match(result.out, /quota Codex épuisé/i);
      assert.ok(result.out.includes(stopped[0].reprise), result.out);
      assert.doesNotMatch(result.out + JSON.stringify(repo.events()), /https?:|chatgpt\.com|You[’']ve|purchase more credits/);
      const ended = repo.events().find(e => e.phase === "session-terminee");
      assert.equal(ended.invocations.length, 1);
      assert.equal(ended.relectures, 0);
      assert.equal(ended.tours, afterWork ? 1 : 0);
      assert.equal(ended.jetons.input_tokens, afterWork ? 13 : 0);
      assert.equal(ended.invocations[0].quota.code, "CODEX_QUOTA_EXHAUSTED");
      assert.deepEqual(jsonLines(repo, "codex-1.jsonl"), events);
      assert.equal(repo.events().some(e => ["tentative-refusee", "bloque", "integre", "capacite-reprise", "reprise-impossible",
        "retro", "retro-echouee", "harmonisation", "relance"].includes(e.phase)), false);
      for (const file of ["fake-review-calls", "fake-retro-call", "echec-1.txt", "reviewed-state.json"]) {
        assert.equal(fs.existsSync(path.join(repo.root, codexDir, file)), false, file);
      }
      assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/check-ran")), false);
      assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
      const diff = repo.git("diff").stdout;
      if (afterWork) {
        assert.equal(repo.read("core/greeting.cjs"), "module.exports = () => 'hello';\n");
        assert.match(diff, /\+.*travail conservé/);
        assert.match(result.out, /arbre contient du travail modifié/i);
      } else {
        assert.equal(diff, "");
        assert.equal(repo.read("notes/personal.md"), "mine\n");
        assert.equal(fs.existsSync(path.join(repo.root, "core/greeting.cjs")), false);
        assert.match(result.out, /arbre ne contient pas de travail modifié/i);
      }
    });
  }
}

for (const [label, diagnostic, reprise] of [
  ["ASCII apostrophe", QUOTA_EVENTS[0].message.replace("’", "'"), "Oct 22nd, 2026 8:41 AM"],
  ["no announcement", "You've hit your usage limit.", null],
  ["unsafe announcement", "You've hit your usage limit. or try again at https://private.invalid/token=secret.", null],
  ["uncharacterized date", "You've hit your usage limit. or try again at tomorrow morning.", null],
  ["oversized announcement", `You've hit your usage limit. or try again at ${"x".repeat(3000)}.`, null],
]) {
  test(`Codex quota diagnostics preserve only a bounded characterized retry announcement: ${label}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex([], { FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([[{ type: "error", message: diagnostic }]]) });
    assert.equal(result.code, 5, result.out);
    const stopped = repo.events().filter(e => e.phase === "quota-epuise");
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].reprise, reprise);
    if (reprise === null) assert.match(result.out, /Reprise non fournie/);
    else assert.ok(result.out.includes(reprise));
    assert.doesNotMatch(result.out + JSON.stringify(repo.events()), /https?:|token=|secret|tomorrow|x{80}|You[’']ve/);
  });
}

test("a terminal quota event keeps the retry announcement supplied by its paired error", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const events = [QUOTA_EVENTS[0], { type: "turn.failed", error: { message: "You've hit your usage limit." } }];
  const result = repo.codex([], { FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([events]) });
  assert.equal(result.code, 5, result.out);
  assert.equal(repo.events().find(e => e.phase === "quota-epuise").reprise, "Oct 22nd, 2026 8:41 AM");
});

test("a terminal quota keeps its announcement when a later completion recovers the paired error", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const events = [QUOTA_EVENTS[0], { type: "turn.failed", error: { message: "You've hit your usage limit." } }, { type: "turn.completed" }];
  const result = repo.codex([], { FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([events]) });
  assert.equal(result.code, 5, result.out);
  assert.equal(repo.events().find(e => e.phase === "quota-epuise").reprise, "Oct 22nd, 2026 8:41 AM");
});

for (const terminal of [false, true]) {
  test(`Codex quota recovery preserves the terminal turn distinction: ${terminal}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const events = [
      { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
      ...(terminal ? QUOTA_EVENTS : QUOTA_EVENTS.slice(0, 1)), { type: "turn.completed", usage: { input_tokens: 17 } },
    ];
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_EVENTS: JSON.stringify([events]) });
    assert.equal(result.code, terminal ? 5 : 0, result.out);
    assert.equal(repo.status(), terminal ? "a-faire" : "termine");
    assert.equal(repo.events().filter(e => e.phase === "quota-epuise").length, terminal ? 1 : 0);
    assert.equal(repo.events().filter(e => e.phase === "reconnexion").length, 1);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, terminal ? 0 : 1);
    assert.doesNotMatch(result.out + JSON.stringify(repo.events()), /https?:|chatgpt\.com|You’ve/);
  });
}

for (const quotaFirst of [false, true]) {
  test(`terminal quota wins over capacity in either event order: ${quotaFirst}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const failures = quotaFirst ? [QUOTA_EVENTS[1], ...CAPACITY_EVENTS] : [...CAPACITY_EVENTS, QUOTA_EVENTS[1]];
    const result = repo.codex([], { FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([failures]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1" });
    assert.equal(result.code, 5, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    assert.equal(repo.events().some(e => e.phase === "capacite-reprise"), false);
    assert.equal(repo.events().filter(e => e.phase === "quota-epuise").length, 1);
  });
}

for (const source of ["tool", "file", "agent"]) {
  test(`quota phrases in ${source} content do not interrupt a normal Codex session`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const text = QUOTA_EVENTS[0].message;
    const items = {
      tool: { type: "command_execution", command: "cat fixture", aggregated_output: text },
      file: { type: "file_change", changes: [{ path: "fixture.txt", kind: "add" }], content: text },
      agent: { type: "agent_message", text },
    };
    if (source === "file") repo.write("fixture.txt", text);
    const events = [
      { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
      { type: "item.completed", item: items[source] }, { type: "turn.completed" },
    ];
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_EVENTS: JSON.stringify([events]) });
    assert.equal(result.code, 0, result.out);
    assert.equal(repo.events().some(e => e.phase === "quota-epuise"), false);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 1);
    assert.equal(repo.status(), "termine");
  });
}

for (const diagnostic of ["HTTP 429", "Rate limit reached, try again shortly", "HTTP 401 Authentication failed", "Unknown provider failure"]) {
  test(`Codex retains ordinary failure handling for non-quota provider errors: ${diagnostic}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const events = [
      { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
      { type: "error", message: diagnostic }, { type: "turn.failed", error: { message: diagnostic } },
    ];
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_EVENTS: JSON.stringify([events]) });
    assert.equal(result.code, 2, result.out);
    assert.equal(repo.events().some(e => e.phase === "quota-epuise"), false);
    assert.equal(repo.events().find(e => e.phase === "invocation-terminee").quota, null);
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    assert.ok(repo.failure().includes(diagnostic));
  });
}

for (const stage of ["capacity", "correction"]) {
  test(`quota during a ${stage} resume stops without a fresh fallback and keeps prior usage`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const quota = [{ type: "turn.failed", error: QUOTA_EVENTS[1].error, usage: { input_tokens: 3 } }];
    const result = repo.codex([], {
      FAKE_CODEX_FAILURES: JSON.stringify(stage === "capacity" ? ["capacity-after-usage", ""] : ["", ""]),
      FAKE_CODEX_BEFORE_WORK_EVENTS: JSON.stringify([null, quota]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
      FAKE_REVIEWS: JSON.stringify(stage === "correction" ? [rejectedReview] : []),
    });
    assert.equal(result.code, 5, result.out);
    assert.equal(repo.events().some(e => ["reprise-impossible", "tentative-refusee", "bloque", "integre"].includes(e.phase)), false);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    assert.equal(calls[1].previousAlive, false);
    const ended = repo.events().find(e => e.phase === "session-terminee");
    assert.equal(ended.jetons.input_tokens, 13);
    assert.equal(ended.tours, 1);
    assert.equal(ended.invocations.length, 2);
    assert.equal(ended.relectures, stage === "correction" ? 1 : 0);
    if (stage === "correction") assert.equal(repo.read(codexDir + "relecture-1.md"), rejectedReview);
    assert.equal(repo.status(), "a-faire");
    assert.deepEqual(repo.commits(), ["init"]);
    noProcess(calls[1].pid);
  });
}

test("Codex retries a capacity failure in the same guarded thread before its only review and attempt", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["capacity-after-usage", ""]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
  assert.deepEqual(calls.map(call => call.reviewCount), [0, 0]);
  assert.deepEqual(calls.map(call => call.previousAlive), [false, false]);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("-m") + 1], "gpt-6.1-sol");
    assert.ok(call.args.includes('model_reasoning_effort="high"'));
    assert.ok(call.args.includes('approval_policy="never"'));
    assert.ok(call.args.includes("--dangerously-bypass-hook-trust"));
    noProcess(call.pid);
  }
  assert.notEqual(calls[0].run, calls[1].run);
  assert.deepEqual(jsonLines(repo, "fake-hook-witnesses"), calls.map(call => ({ session: call.session, run: call.run })));
  const retries = repo.events().filter(e => e.phase === "capacite-reprise");
  assert.deepEqual(retries.map(e => [e.ticket, e.attempt, e.invocation, e.reprise, e.attente_ms]),
    [["T001", 1, calls[0].run, 1, 15000]]);
  const ended = repo.events().find(e => e.phase === "session-terminee");
  assert.equal(ended.invocations.length, 2);
  assert.equal(ended.relectures, 1);
  assert.equal(ended.tours, 2);
  assert.equal(ended.jetons.input_tokens, 20);
  for (const [i, invocation] of ended.invocations.entries()) {
    assert.equal(invocation.invocation, calls[i].run);
    assert.equal(invocation.jetons.input_tokens, 10);
    assert.equal(invocation.code, i === 0 ? 1 : 0);
    assert.equal(jsonLines(repo, path.basename(invocation.trace)).filter(e => e.type === "turn.completed").length, 1);
  }
  assert.equal(jsonLines(repo, "codex-1.jsonl").filter(e => e.type === "thread.started").length, 2);
  assert.equal(jsonLines(repo, "fake-review-calls")[0].model, "opus");
  assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 1);
  assert.equal(repo.events().some(e => e.phase === "tentative-refusee"), false);
  assert.equal(repo.commits()[0], "T001: Add the greeting");
});

const capacityModule = () => import(pathToFileURL(path.join(__dirname, "../../scripts/loop/codex-capacity.mjs")).href);

test("a capacity stream stays pending until the child closes after its final output", async (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const { sessionState, streamSession } = await import(pathToFileURL(path.join(repo.root, "scripts/loop/codex-stream.mjs")).href);
  const trace = path.join(repo.root, ".harness-state/held-stream.jsonl");
  const pidFile = ".harness-state/held-child.pid";
  fs.writeFileSync(trace, "");
  let observed;
  const output = new Promise(resolve => { observed = resolve; });
  const watcher = fs.watch(trace, () => {
    if (fs.readFileSync(trace, "utf8").includes('"turn.failed"')) observed();
  });
  const script = `
const fs = require("node:fs");
const hold = fs.watch(".harness-state", () => {});
process.on("SIGTERM", () => { hold.close(); process.exitCode = 1; });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
for (const event of ${JSON.stringify(CAPACITY_EVENTS)}) console.log(JSON.stringify(event));
process.stdout.end();
`;
  const state = sessionState();
  let finished = false;
  const running = streamSession(repo.root, ["-e", script], repo.env({ HARNESS_CODEX_BIN: process.execPath }),
    [trace], state, 5000, Date.now(), () => {}).then(code => {
    finished = true;
    observed();
    return code;
  });
  let pid;
  let code;
  const release = () => {
    if (!fs.existsSync(path.join(repo.root, pidFile))) return;
    try {
      process.kill(Number(repo.read(pidFile)), "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  try {
    await output;
    assert.equal(state.capacity?.code, "CODEX_CAPACITY");
    pid = Number(repo.read(pidFile));
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(finished, false, "capacity output must not finish a live invocation");
  } finally {
    watcher.close();
    release();
    code = await running;
  }
  assert.equal(code, 1);
  noProcess(pid);
});

for (const skip of [false, true]) {
  test(`Codex passes each capacity delay to its timer unless explicitly skipped: ${skip}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    repo.write(codexDir + "fake-waits", "");
    repo.write(".harness-state/fake-timer.cjs", `
const fs = require("node:fs");
const timers = require("node:timers/promises");
timers.setTimeout = async (delay) => {
  const dir = ".harness-state/tickets/T001/";
  const invocations = fs.readFileSync(dir + "fake-codex-calls", "utf8").trim().split("\\n").length;
  fs.appendFileSync(dir + "fake-waits", JSON.stringify({ delay, invocations }) + "\\n");
};
require("node:module").syncBuiltinESMExports();
`);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_FAILURES: JSON.stringify(["capacity", "capacity", "capacity", ""]),
      NODE_OPTIONS: `--require=${path.join(repo.root, ".harness-state/fake-timer.cjs")}`,
      ...(skip ? { HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1" } : {}),
    });
    assert.equal(result.code, 0, result.out);
    const waits = repo.read(codexDir + "fake-waits").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(waits, skip ? [] : [
      { delay: 15000, invocations: 1 }, { delay: 30000, invocations: 2 }, { delay: 60000, invocations: 3 },
    ]);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 4);
    assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
  });
}

test("capacity classification only accepts the characterized messages at the provider event boundary", async () => {
  const { capacityFailure } = await capacityModule();
  for (const event of CAPACITY_EVENTS) assert.equal(capacityFailure(event)?.code, "CODEX_CAPACITY");
  for (const event of [
    { type: "error", message: "rate_limit exceeded" },
    { type: "turn.failed", error: { message: "HTTP 429" } },
    { type: "error", message: "Authentication failed" },
    { type: "error", message: "Quota exceeded" },
    { type: "item.completed", item: { type: "agent_message", text: CAPACITY_EVENTS[0].message } },
    { type: "item.completed", item: { type: "command_execution", aggregated_output: CAPACITY_EVENTS[0].message } },
  ]) assert.equal(capacityFailure(event), null);
});

test("capacity retries cannot accept an invocation that has consumed the remaining deadline", async () => {
  const { retryCapacity } = await capacityModule();
  let time = 0;
  const result = await retryCapacity(async () => {
    time = 3000;
    return { code: 0, session: "validated-thread" };
  }, { timeoutMs: 2000, now: () => time });
  assert.equal(result.code, 1);
  assert.match(result.problem, /délai maximal/);
});

test("capacity retries share a deadline and stop after the three documented waits", async () => {
  const { retryCapacity } = await capacityModule();
  let time = 0;
  const calls = [];
  const waits = [];
  const result = await retryCapacity(async request => {
    calls.push(request);
    time += 1000;
    return { code: 1, capacity: { code: "CODEX_CAPACITY" }, session: "validated-thread", problem: "capacity" };
  }, {
    timeoutMs: 200000, now: () => time, wait: async delay => { waits.push(delay); time += delay; },
  });
  assert.deepEqual(waits, [15000, 30000, 60000]);
  assert.deepEqual(calls.map(call => call.timeoutMs), [200000, 184000, 153000, 92000]);
  assert.deepEqual(calls.map(call => call.session), [null, "validated-thread", "validated-thread", "validated-thread"]);
  assert.deepEqual(calls.map(call => call.retry), [0, 1, 2, 3]);
  assert.equal(result.code, 1);
  assert.equal(result.exhausted, "limit");
});

for (const stage of ["invocation", "wait"]) {
  test(`capacity retries stop at the shared deadline consumed by the ${stage}`, async () => {
    const { retryCapacity } = await capacityModule();
    let time = 0;
    let calls = 0;
    const waits = [];
    const result = await retryCapacity(async () => {
      calls++;
      time += stage === "invocation" ? 6000 : 1000;
      return { code: 1, capacity: { code: "CODEX_CAPACITY" }, session: "validated-thread" };
    }, { timeoutMs: 20000, now: () => time, wait: async delay => { waits.push(delay); time += 20000; } });
    assert.equal(calls, 1);
    assert.deepEqual(waits, stage === "wait" ? [15000] : []);
    assert.equal(result.code, 1);
    assert.match(result.problem, /délai maximal/);
    assert.equal(result.resumeImpossible, false);
  });
}

test("Codex capacity exhaustion counts one refusal before a fresh attempt escalates normally", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "2"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["capacity", "capacity", "capacity", "capacity", ""]),
    HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 5);
  for (const call of calls.slice(1, 4)) {
    assert.deepEqual(call.args.slice(0, 3), ["exec", "resume", calls[0].session]);
    assert.ok(call.args.includes('model_reasoning_effort="high"'));
  }
  assert.deepEqual(calls[4].args.slice(0, 2), ["exec", "--json"]);
  assert.notEqual(calls[4].session, calls[0].session);
  assert.ok(calls[4].args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
  assert.deepEqual(repo.events().filter(e => e.phase === "capacite-reprise").map(e => e.attente_ms), [15000, 30000, 60000]);
  assert.deepEqual(repo.events().filter(e => e.phase === "session-terminee").map(e => e.invocations.length), [4, 1]);
  assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
  assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 2);
});

test("capacity during both useful corrections preserves their reports and budget until a new state is accepted", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["", "capacity", "", "capacity", ""]),
    FAKE_REVIEWS: JSON.stringify([rejectedReview, correctedReview(rejectedReview), acceptedReview]),
    FAKE_CODEX_GREETINGS: JSON.stringify(["hello", "pending first", "first corrected", "pending second", "second corrected"]),
    HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.reviewCount), [0, 1, 1, 2, 2]);
  for (const i of [1, 3]) {
    assert.equal(calls[i].args.at(-1), calls[i + 1].args.at(-1));
    assert.ok(calls[i].args.at(-1).includes(codexDir + `relecture-${(i + 1) / 2}.md`));
    assert.ok(calls[i + 1].greetingPresent);
    assert.ok(calls[i + 1].greeting.includes(i === 1 ? "pending first" : "pending second"));
  }
  for (const call of calls.slice(1)) assert.equal(call.session, calls[0].session);
  assert.equal(new Set(calls.map(call => call.run)).size, 5);
  const reviews = jsonLines(repo, "fake-review-calls");
  assert.equal(reviews.length, 3);
  assert.ok(reviews[1].prompt.includes("revue-2.interdiff"));
  assert.ok(reviews[2].prompt.includes("revue-3.interdiff"));
  assert.ok(repo.read(codexDir + "revue-2.interdiff").includes("first corrected"));
  assert.ok(repo.read(codexDir + "revue-3.interdiff").includes("second corrected"));
  assert.ok(repo.read("core/greeting.cjs").includes("second corrected"));
  assert.equal(repo.read(codexDir + "relecture-1.md"), rejectedReview);
  assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(review => review.verdict), ["à corriger", "à corriger", "accepté"]);
  assert.equal(repo.events().find(e => e.phase === "session-terminee").invocations.length, 5);
  assert.equal(repo.commits()[0], "T001: Add the greeting");
});

for (const [source, type, diagnostic] of [
  ["command_execution", "turn.failed", "Authentication failed"],
  ["agent_message", "turn.failed", "Unknown provider failure"],
  ["command_execution", "error", "Unknown provider failure"],
  ["agent_message", "error", "Authentication failed"],
]) {
  test(`Codex refuses a non-capacity ${type} despite capacity text in ${source}: ${diagnostic}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const item = source === "command_execution"
      ? { type: source, command: "cat fixture", aggregated_output: CAPACITY_EVENTS[0].message }
      : { type: source, text: CAPACITY_EVENTS[0].message };
    const events = [
      { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" },
      { type: "item.completed", item }, { type, error: { message: diagnostic } },
    ];
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_EVENTS: JSON.stringify([events]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, 2, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    assert.equal(repo.events().some(e => e.phase === "capacite-reprise"), false);
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 0);
    assert.ok(repo.failure().includes(diagnostic), repo.failure());
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

for (const failure of ["capacity-recovered", "capacity-tool", "capacity-stderr", "capacity-signal"]) {
  test(`Codex only retries unrecovered provider capacity events: ${failure}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const terminal = ["capacity-stderr", "capacity-signal"].includes(failure);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_FAILURE: failure, HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, terminal ? 2 : 0, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    assert.equal(repo.events().some(e => e.phase === "capacite-reprise"), false);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, terminal ? 0 : 1);
  });
}

test("Codex can start fresh after capacity only when no thread or work could have started", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["capacity-before-thread", ""]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["exec", "--json"], ["exec", "--json"]]);
  assert.equal(calls[1].greetingPresent, false);
  assert.deepEqual(jsonLines(repo, "fake-hook-witnesses"), [{ session: calls[1].session, run: calls[1].run }]);
});

for (const work of [
  { type: "turn.started" },
  { type: "item.started", item: { type: "command_execution", command: "node --test" } },
  { type: "item.completed", item: { type: "file_change", changes: [{ path: "core/greeting.cjs", kind: "add" }] } },
]) {
  test(`Codex refuses a missing identity after work instead of replacing the session on capacity: ${work.type}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_EVENTS: JSON.stringify([[work, ...CAPACITY_EVENTS]]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, 2, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    assert.match(repo.failure(), /identité.*absente.*travail/);
    assert.equal(repo.events().some(e => e.phase === "capacite-reprise"), false);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  });
}

for (const stage of ["before-turn-warnings", "before-thread-warnings"]) {
  test(`startup warnings preserve a fresh guarded correction after a resume failure: ${stage}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_RESUME_FAILURE: stage, FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
    });
    assert.equal(result.code, 0, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.reviewCount), [0, 1, 1]);
    assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
    assert.notEqual(calls[2].session, calls[0].session);
    assert.equal(calls[2].args.at(-1), calls[1].args.at(-1));
    assert.ok(calls[2].greetingPresent);
    const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
    assert.equal(fallback.length, 1);
    assert.match(fallback[0].raison, /resume unavailable before turn/);
    assert.doesNotMatch(fallback[0].raison, /identité.*absente.*travail/);
    if (stage === "before-thread-warnings") assert.match(fallback[0].raison, /hooks Codex non chargés/);
    const invocations = repo.events().find(e => e.phase === "session-terminee").invocations;
    const stream = jsonLines(repo, path.basename(invocations[1].trace));
    const identity = stage === "before-turn-warnings" ? [{ type: "thread.started", thread_id: calls[0].session }] : [];
    assert.deepEqual(stream, [...identity, ...STARTUP_WARNING_EVENTS, { type: "error", message: "resume unavailable before turn" }]);
    assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: calls[2].session, run: calls[2].run });
    assert.equal(new Set(calls.map(call => call.run)).size, 3);
    assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(review => review.verdict), ["à corriger", "accepté"]);
    assert.equal(repo.commits()[0], "T001: Add the greeting");
  });
}

for (const hooks of ["missing", "missing-on-resume", "stale-on-resume", "foreign"]) {
  test(`capacity during the initial invocation never bypasses hook or identity confinement: ${hooks}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const resumed = hooks !== "missing";
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_FAILURES: JSON.stringify(resumed ? ["capacity", "capacity", ""] : ["capacity", ""]),
      FAKE_CODEX_HOOKS: hooks === "foreign" ? "valid" : hooks,
      ...(hooks === "foreign" ? { FAKE_CODEX_RESUME_SESSION: "foreign-thread" } : {}),
      HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, 2, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, resumed ? 2 : 1);
    assert.equal(repo.events().some(e => e.phase === "reprise-impossible"), false);
    assert.equal(repo.events().filter(e => e.phase === "capacite-reprise").length, resumed ? 1 : 0);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

test("capacity resume option failure refuses the initial invocation before any review", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["capacity", ""]), FAKE_CODEX_UNSUPPORTED_RESUME: "--disable",
    HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
  assert.equal(jsonLines(repo, "fake-help-calls").length, 1);
  assert.equal(repo.events().some(e => e.phase === "reprise-impossible"), false);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
});

for (const failure of ["options", "hooks", "identity"]) {
  test(`a capacity retry during correction refuses ${failure} failure without a fresh fallback or another review`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const foreign = [{ type: "thread.started", thread_id: "foreign-thread" }, { type: "turn.started" }, { type: "turn.completed" }];
    const result = repo.codex(["--attempts", "1"], {
      FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
      FAKE_CODEX_FAILURES: JSON.stringify(["", "capacity", ""]),
      FAKE_CODEX_UNSUPPORTED_RESUMES: JSON.stringify(failure === "options" ? [null, "", "--disable"] : []),
      FAKE_CODEX_HOOKS_BY_INVOCATION: JSON.stringify(failure === "hooks" ? ["valid", "valid", "missing"] : []),
      FAKE_CODEX_EVENTS: JSON.stringify(failure === "identity" ? [null, null, foreign] : []),
      HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(repo.events().some(e => e.phase === "reprise-impossible"), false, "a capacity retry cannot restart a correction");
    assert.equal(result.code, 2, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, failure === "options" ? 2 : 3);
    assert.deepEqual(calls.map(call => call.reviewCount), failure === "options" ? [0, 1] : [0, 1, 1]);
    for (const call of calls.slice(1)) {
      assert.deepEqual(call.args.slice(0, 3), ["exec", "resume", calls[0].session]);
      assert.ok(call.args.at(-1).includes(rejectedReview));
      assert.ok(call.args.at(-1).includes(codexDir + "relecture-1.md"));
    }
    assert.equal(jsonLines(repo, "fake-help-calls").length, 2);
    assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
    assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(review => review.verdict), ["à corriger"]);
    assert.equal(repo.events().filter(e => e.phase === "capacite-reprise").length, 1);
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    const invocations = repo.events().find(e => e.phase === "session-terminee").invocations;
    assert.deepEqual(invocations.map(invocation => [invocation.reprise, invocation.code]), [[0, 0], [0, 1], [1, 1]]);
    const diagnostics = { options: /options requises de reprise/, hooks: /hooks Codex non chargés/, identity: /session changée/ };
    assert.match(repo.failure(), diagnostics[failure]);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

for (const source of ["discovery", "stream"]) {
  test(`invocation diagnostics remain bounded in events and session reports after ${source} failure`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const diagnostic = "provider detail ".repeat(800);
    const events = [
      { type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" }, { type: "error", message: diagnostic },
    ];
    const scenario = source === "discovery" ? {
      FAKE_CODEX_FAILURES: JSON.stringify(["capacity", ""]), FAKE_CODEX_UNSUPPORTED_RESUME: "--disable",
      FAKE_CODEX_HELP_DIAGNOSTIC: diagnostic,
    } : { FAKE_CODEX_EVENTS: JSON.stringify([events]), FAKE_CODEX_HOOKS: "missing" };
    const result = repo.codex(["--attempts", "1"], { ...scenario, HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1" });
    assert.equal(result.code, 2, result.out);
    const invocations = repo.events().filter(e => e.phase === "invocation-terminee");
    assert.equal(invocations.length, source === "discovery" ? 2 : 1);
    const reports = repo.events().find(e => e.phase === "session-terminee").invocations;
    assert.equal(reports.length, invocations.length);
    for (const entry of [...invocations, ...reports]) {
      assert.ok(entry.problem.length <= 2000, `The invocation diagnostic contains ${entry.problem.length} characters`);
    }
    const problem = invocations.at(-1).problem;
    assert.match(problem, /provider detail/);
    if (source === "discovery") assert.match(problem, /options requises de reprise/);
    if (source === "stream") assert.match(problem, /hooks Codex non chargés.*non approuvés.*propriétaire.*codex.*\/hooks/);
    assert.equal(reports.at(-1).problem, problem);
    assert.equal(repo.failure().trim(), problem);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

for (const refusal of ["hooks", "changed identity", "missing identity"]) {
  test(`a bounded correction diagnostic retains its confinement reason after a long stream failure: ${refusal}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const missingIdentity = refusal === "missing identity";
    const session = refusal === "changed identity" ? "foreign-thread" : "codex-thread-1";
    const events = [
      ...(missingIdentity ? [] : [{ type: "thread.started", thread_id: session }]),
      { type: "turn.started" }, { type: "error", message: "provider detail ".repeat(800) },
    ];
    const result = repo.codex(["--attempts", "1"], {
      FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
      FAKE_CODEX_EVENTS: JSON.stringify([null, events]),
      FAKE_CODEX_HOOKS_BY_INVOCATION: JSON.stringify(["valid", refusal === "hooks" ? "missing" : "valid"]),
    });
    assert.equal(result.code, missingIdentity ? 2 : 0, result.out);
    const invocations = repo.events().filter(e => e.phase === "invocation-terminee");
    assert.equal(invocations.length, missingIdentity ? 2 : 3);
    const problem = invocations[1].problem;
    assert.ok(problem.length <= 2000, `The correction diagnostic contains ${problem.length} characters`);
    assert.match(problem, /provider detail/);
    const reasons = {
      hooks: /hooks Codex non chargés.*non approuvés.*hors du dépôt approuvé.*propriétaire.*codex.*\/hooks/,
      "changed identity": /session changée.*codex-thread-1 attendue, foreign-thread reçue/,
      "missing identity": /identité de session absente.*début du travail.*reprise refusée/,
    };
    assert.match(problem, reasons[refusal]);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").invocations[1].problem, problem);
    const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
    assert.equal(fallback.length, missingIdentity ? 0 : 1);
    if (missingIdentity) {
      assert.equal(repo.failure().trim(), problem);
      assert.deepEqual(repo.commits(), ["init"]);
    } else {
      assert.equal(fallback[0].raison, problem);
      assert.equal(repo.commits()[0], "T001: Add the greeting");
    }
    assert.equal(jsonLines(repo, "fake-review-calls").length, missingIdentity ? 1 : 2);
  });
}

test("an oversized capacity resume identity keeps the refusal diagnostic bounded without another invocation", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURE: "capacity", FAKE_CODEX_RESUME_SESSION: "x".repeat(4000), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.ok(repo.failure().length <= 2000, `The refusal contains ${repo.failure().length} characters`);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
});

for (const failure of ["capacity-error-only", "capacity-failed-only"]) {
  test(`Codex resumes each characterized standalone capacity event: ${failure}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_FAILURES: JSON.stringify([failure, ""]), HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
    });
    assert.equal(result.code, 0, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].session, calls[0].session);
    assert.equal(calls[1].previousAlive, false);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").invocations[0].capacity.code, "CODEX_CAPACITY");
  });
}

test("a capacity retry without a completed turn cannot trigger review despite a finished verdict", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const unfinished = [{ type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.started" }];
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_FAILURES: JSON.stringify(["capacity", ""]), FAKE_CODEX_EVENTS: JSON.stringify([null, unfinished]),
    HARNESS_CODEX_SKIP_CAPACITY_WAIT: "1",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  assert.deepEqual(repo.commits(), ["init"]);
});

for (const engine of ["claude", "codex"]) {
  for (const change of ["add", "remove", "delete"]) {
    test(`the gates refuse ${engine} when its session makes an untracked list change: ${change}`, (t) => {
      const repo = codexRepo();
      t.after(repo.cleanup);
      repo.write("notes/personal.md", "mine\n");
      const env = { FAKE_UNTRACKED_CHANGE: change };
      const result = engine === "codex" ? repo.codex(["--attempts", "1"], env)
        : repo.loop("changes-untracked-list", ["--attempts", "1"], env);
      assert.equal(result.code, 2, result.out);
      assert.match(repo.failure(), /untracked-before\.json/);
      const diagnostic = change === "delete" ? /untracked-before\.json est absent/ : /a été modifié depuis le démarrage/;
      assert.match(repo.failure(), diagnostic);
      assert.equal(jsonLines(repo, "relectures.jsonl").at(-1).verdict, "accepté");
      assert.deepEqual(repo.commits(), ["init"]);
    });
  }
}

for (const engine of ["claude", "codex"]) {
  test(`the gates accept ${engine} when its session rewrites an identical untracked list`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    repo.write("notes/personal.md", "mine\n");
    const env = { FAKE_UNTRACKED_CHANGE: "same" };
    const args = ["--attempts", "1", "--no-retro"];
    const result = engine === "codex" ? repo.codex(args, env) : repo.loop("changes-untracked-list", args, env);
    assert.equal(result.code, 0, result.out);
    assert.equal(repo.commits()[0], "T001: Add the greeting");
    assert.doesNotMatch(repo.git("show", "--name-only", "--format=", "HEAD").stdout, /notes\/personal/);
    assert.equal(repo.read("notes/personal.md"), "mine\n");
  });
}

test("the last accepted Codex review carries both out-of-scope findings into the committed journal and reserve count", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const findings = [
    "core/legacy.cjs:8 : hors périmètre — erreur sans code stable. Ajouter un code lors d'un prochain ticket.",
    "docs/notes.md:3 : hors périmètre — exemple périmé. Actualiser la commande.",
  ];
  const report = "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre\n\n" + findings.map(f => `- ${f}`).join("\n");
  const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
  assert.equal(result.code, 0, result.out);
  const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
  assert.ok(journal, committedTicket(repo));
  for (const finding of findings) assert.ok(journal.includes(finding), journal);
  assert.equal((journal.match(/relecture-2\.md/g) || []).length, 2, journal);
  assert.doesNotMatch(journal, /relecture-1|preuve manquante|nom à préciser/);
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 2, listed in the ticket journal\.$/m);
  const integrated = repo.events().find(e => e.phase === "integre");
  assert.equal(integrated.reserves.length, 2);
  for (const reserve of integrated.reserves) assert.ok(reserve.includes(codexDir + "relecture-2.md"));
  assert.deepEqual(JSON.parse(repo.read(codexDir + "verdict.json")).reste, []);
});

test("Codex preserves accepted deviations and complete multiline findings alongside the session reserves", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const finding = "`core/legacy.cjs:8` — **hors périmètre**\n  Une erreur perd son code stable.\n\n  Attendu : ajouter un code.";
  const deviation = "**Écart accepté, critère 3 :** mesure remplacée par une preuve déterministe.\n  Motif : fournisseur indisponible.";
  const report = "VERDICT : accepté\nCONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre\n\n" +
    `## Constats hors périmètre\n\n1. ${finding}\n\n## Écarts\n\n${deviation}`;
  const old = rejectedReview + "\n- docs/obsolete.md:2 : hors périmètre — ancien constat corrigé depuis.";
  const result = repo.codex(["--attempts", "1"], {
    FAKE_REVIEWS: JSON.stringify([old, report]), FAKE_CODEX_RESERVES: JSON.stringify(["Vérification manuelle à prévoir."]),
  });
  assert.equal(result.code, 0, result.out);
  const kept = repo.events().find(e => e.phase === "integre").reserves;
  assert.equal(kept.length, 3, JSON.stringify(kept));
  assert.equal(kept[0], "Vérification manuelle à prévoir.");
  assert.ok(kept[1].includes(finding), kept[1]);
  assert.ok(kept[2].includes(deviation), kept[2]);
  for (const reserve of kept.slice(1)) assert.ok(reserve.includes(codexDir + "relecture-2.md"));
  assert.doesNotMatch(committedTicket(repo), /obsolete|relecture-1/);
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 3, listed in the ticket journal\.$/m);
  assert.deepEqual(JSON.parse(repo.read(codexDir + "verdict.json")).reste, ["Vérification manuelle à prévoir."]);
});

for (const [announced, extracted] of [[2, 0], [2, 1], [1, 2], [0, 1]]) {
  test(`Codex references the report when the finding count disagrees: ${announced} announced, ${extracted} extracted`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const findings = Array.from({ length: extracted }, (_, i) => `- core/legacy.cjs:${i + 1} : hors périmètre — à reprendre.`);
    const deviation = "Écart accepté, critère 3 : preuve déterministe.";
    const report = ["VERDICT : accepté", `CONSTATS : 0 bloquant, 0 mineur, ${announced} hors périmètre`, "",
      "## Constats", "", ...findings, "", "## Écarts déclarés", "", `- ${deviation}`].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([report]) });
    assert.equal(result.code, 0, result.out);
    const kept = repo.events().find(e => e.phase === "integre").reserves;
    assert.equal(kept.length, 2, JSON.stringify(kept));
    assert.ok(kept[0].startsWith(codexDir + "relecture-1.md : "), kept[0]);
    assert.ok(kept[0].includes(`CONSTATS annonce ${announced} hors périmètre`), kept[0]);
    assert.ok(kept[0].includes(`${extracted} constat(s) extrait(s)`), kept[0]);
    assert.match(kept[0], /discordant.*Consulter le rapport/);
    assert.doesNotMatch(kept[0], /core\/legacy/);
    assert.equal(kept[1], `${codexDir}relecture-1.md : ${deviation}`);
    const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
    assert.ok(journal.includes(kept[0]), journal);
    assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 2, listed in the ticket journal\.$/m);
    assert.deepEqual(JSON.parse(repo.read(codexDir + "verdict.json")).reste, []);
  });
}

for (const section of ["Écarts déclarés", "Décisions sur les écarts", "Décisions sur les écarts déclarés"]) {
  test(`Codex retains singular and plural accepted deviations as separate reserves: ${section}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const deviations = [
      "**Écart accepté, critère 3.** Preuve déterministe conservée.\n  Motif : fournisseur indisponible.",
      "**Écarts acceptés, documentation (écarts 4 et 10).** Les passages périmés ont été actualisés.",
    ];
    const report = [acceptedReview, "", `## ${section}`, "", ...deviations.flatMap(d => [`- ${d}`, ""]),
      "- **Précision acceptée.** Aucun changement de critère.", "", "## Critères", "",
      "- Écart accepté, critère 3 : citation dans une preuve, pas une nouvelle réserve."].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([report]) });
    assert.equal(result.code, 0, result.out);
    const kept = repo.events().find(e => e.phase === "integre").reserves;
    assert.deepEqual(kept, deviations.map(d => `${codexDir}relecture-1.md : ${d}`));
    const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
    assert.ok(journal.includes("Écarts acceptés, documentation (écarts 4 et 10)"), journal);
    assert.doesNotMatch(journal, /Précision|citation/);
    assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 2, listed in the ticket journal\.$/m);
  });
}

for (const form of ["heading", "bold", "numbered", "fields"]) {
  test(`Codex preserves complete structured findings without counting the summary or criteria: ${form}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const locations = ["core/legacy.cjs:8", "docs/notes.md:3"];
    const findings = locations.map((location, i) => {
      const title = `${i + 1}. \`${location}\` — hors périmètre`;
      const titles = { heading: `### ${title}`, bold: `**${title}**`, numbered: title, fields: `- \`${location}\` ;` };
      return [titles[form], "", `- Problème : détail complet ${i + 1}.`, "", "- Attendu : réparer dans un prochain ticket.",
        ...(form === "fields" ? ["- Classe : hors périmètre."] : [])].join("\n");
    });
    const summary = "Synthèse : core/fixed.cjs:12 est corrigé ; deux constats hors périmètre restent.";
    const criterion = "1. core/criterion.cjs:6 — hors périmètre cité dans la preuve du critère.";
    const report = ["VERDICT : accepté", "CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre", "", summary, "",
      "## Constats", "", ...findings.flatMap(f => [f, ""]), "## Critères", "", criterion].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
    assert.equal(result.code, 0, result.out);
    const kept = repo.events().find(e => e.phase === "integre").reserves;
    assert.equal(kept.length, 2, JSON.stringify(kept));
    for (let i = 0; i < findings.length; i++) {
      assert.ok(kept[i].includes(locations[i]), kept[i]);
      assert.ok(kept[i].includes(`- Problème : détail complet ${i + 1}.\n\n- Attendu : réparer dans un prochain ticket.`), kept[i]);
      assert.ok(kept[i].startsWith(codexDir + "relecture-2.md : "), kept[i]);
      assert.doesNotMatch(kept[i], /###|Synthèse|criterion|relecture-1/);
    }
    const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
    assert.doesNotMatch(journal, /Synthèse|criterion/);
    for (let i = 1; i <= 2; i++) assert.ok(journal.includes(`Problème : détail complet ${i}.`), journal);
    assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 2, listed in the ticket journal\.$/m);
    assert.deepEqual(JSON.parse(repo.read(codexDir + "verdict.json")).reste, []);
  });
}

test("Codex trusts the project and identifies its engine on startup and every resumed correction", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]) });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const trust = `projects.${JSON.stringify(repo.root)}.trust_level="trusted"`;
    assert.ok(call.args.some((arg, i) => arg === "-c" && call.args[i + 1] === trust), call.args.join(" "));
    assert.equal(call.engine, "codex");
    assert.deepEqual(call.args.slice(0, 2), call === calls[0] ? ["exec", "--json"] : ["exec", "resume"]);
  }
});

test("Codex neutralizes user extensions and only active MCP servers on startup and correction", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const servers = [{ name: "research", enabled: true }, { name: "team.docs", enabled: true }, { name: "paused", enabled: false }];
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_MCP_LIST: JSON.stringify(servers), FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  for (const { args } of calls) {
    assert.equal(args.includes("--ignore-user-config"), false);
    const disabled = args.flatMap((arg, i) => arg === "--disable" ? [args[i + 1]] : []);
    assert.deepEqual(disabled, ["plugins", "apps", "memories", "image_generation"]);
    const configs = args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);
    assert.ok(configs.includes("notify=[]"));
    assert.deepEqual(configs.filter(value => value.startsWith("mcp_servers.")), [
      "mcp_servers.research.enabled=false", 'mcp_servers."team.docs".enabled=false',
    ]);
  }
  const listings = jsonLines(repo, "fake-mcp-calls");
  assert.equal(listings.length, 2);
  for (const listing of listings) {
    assert.deepEqual(listing.args.slice(0, 3), ["mcp", "list", "--json"]);
    assert.deepEqual(listing.args.slice(3), calls[0].args.filter((_, i, args) => args[i - 1] === "--disable" || args[i] === "--disable"));
    assert.equal(listing.cwd, repo.root);
  }
});

for (const [kind, env] of [
  ["failed", { FAKE_CODEX_MCP_FAILURE: "1" }],
  ["unreadable", { FAKE_CODEX_MCP_LIST: "{ incomplete" }],
  ["not an array", { FAKE_CODEX_MCP_LIST: "{}" }],
  ["ambiguous activation", { FAKE_CODEX_MCP_LIST: '[{"name":"docs"}]' }],
]) {
  test(`a ${kind} MCP server list refuses Codex without any exec or review`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], env);
    assert.equal(result.code, 2, result.out);
    assert.match(repo.failure(), /liste des serveurs MCP/);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-codex-calls")), false);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
    assert.equal(jsonLines(repo, "fake-mcp-calls").length, 1);
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

test("a Codex session without its startup hook is refused before review, even with an older witness", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  repo.write(codexDir + "hooks-started.json", JSON.stringify({ session: "codex-thread-1", run: "old-launch" }));
  const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_HOOKS: "missing" });
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /hooks Codex non chargés/);
  assert.match(repo.failure(), /\.codex\/hooks\.json.*non approuvés.*dépôt/);
  assert.match(repo.failure(), /hors du dépôt approuvé/);
  assert.match(repo.failure(), /propriétaire.*codex.*\/hooks/);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 0);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a failed Codex process without its hook witness retains the failure and explains approval", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_HOOKS: "missing", FAKE_CODEX_FAILURE: "exit" });
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /processus en échec/);
  assert.match(repo.failure(), /hooks Codex non chargés.*non approuvés.*hors du dépôt approuvé.*propriétaire.*codex.*\/hooks/);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a failed Codex process with long stderr preserves its hook refusal and approval remedy within the diagnostic bound", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const stderr = "process detail ".repeat(800);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_HOOKS: "missing", FAKE_CODEX_FAILURE: "exit", FAKE_CODEX_STDERR: stderr,
  });
  assert.equal(result.code, 2, result.out);
  const invocations = repo.events().filter(e => e.phase === "invocation-terminee");
  assert.equal(invocations.length, 1);
  const problem = invocations[0].problem;
  assert.ok(problem.length <= 2000, `The process diagnostic contains ${problem.length} characters`);
  assert.match(problem, /processus en échec \(code 1\)/);
  assert.match(problem, /process detail/);
  assert.match(problem, /hooks Codex non chargés.*non approuvés.*hors du dépôt approuvé.*propriétaire.*codex.*\/hooks/);
  const ended = repo.events().find(e => e.phase === "session-terminee");
  assert.equal(ended.invocations[0].problem, problem);
  assert.equal(ended.relectures, 0);
  assert.equal(repo.events().find(e => e.phase === "tentative-refusee").raison, problem);
  assert.equal(repo.failure().trim(), problem);
  assert.equal(repo.read(invocations[0].trace + ".stderr"), stderr);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("a fresh Codex fallback without its hook witness is refused before another review", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_HOOKS: "missing-on-correction", FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
  });
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /hooks Codex non chargés/);
  assert.match(repo.failure(), /\.codex\/hooks\.json.*non approuvés.*dépôt/);
  assert.match(repo.failure(), /hors du dépôt approuvé/);
  assert.match(repo.failure(), /propriétaire.*codex.*\/hooks/);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
  assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
  assert.equal(repo.events().filter(e => e.phase === "reprise-impossible").length, 1);
  assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
  assert.deepEqual(repo.commits(), ["init"]);
});

for (const option of ["--disable", "--add-dir"]) {
  test(`a Codex correction uses a fresh session when resume cannot accept ${option}`, (t) => {
    const repo = codexRepo({ harnais: "oui", niveau: "standard" });
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_UNSUPPORTED_RESUME: option, FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
    });
    assert.equal(result.code, 0, result.out);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-help-calls")), true, "the resume help call must be recorded");
    const help = jsonLines(repo, "fake-help-calls");
    assert.equal(help.length, 1);
    assert.deepEqual(help[0].args.slice(0, 2), ["exec", "resume"]);
    assert.equal(help[0].args.at(-1), "--help");
    assert.ok(help[0].args.includes(option));
    assert.equal(help[0].cwd, repo.root);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.args.slice(0, 2)), [["exec", "--json"], ["exec", "--json"]]);
    assert.notEqual(calls[0].session, calls[1].session);
    const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
    assert.equal(fallback.length, 1);
    assert.ok(fallback[0].raison.includes(option), fallback[0].raison);
    assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: calls[1].session, run: calls[1].run });
    assert.equal(repo.status(), "termine");
  });
}

test("a Codex correction outside the harness resumes when only add-dir is unsupported", (t) => {
  const repo = codexRepo({ harnais: "non" });
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_UNSUPPORTED_RESUME: "--add-dir", FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
  assert.equal(calls[1].session, calls[0].session);
  assert.equal(calls[1].args.includes("--add-dir"), false);
  const help = jsonLines(repo, "fake-help-calls");
  assert.equal(help.length, 1);
  assert.deepEqual(help[0].args.slice(0, 2), ["exec", "resume"]);
  assert.equal(help[0].args.includes("--add-dir"), false);
  assert.equal(repo.events().filter(e => e.phase === "reprise-impossible").length, 0);
  assert.equal(repo.status(), "termine");
});

test("a Codex resume that changes thread falls back despite its valid hook witness and explains the session mismatch", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_RESUME_SESSION: "unexpected-thread", FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
  assert.equal(calls[1].session, "unexpected-thread");
  assert.deepEqual(jsonLines(repo, "fake-hook-witnesses")[1], { session: calls[1].session, run: calls[1].run });
  assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
  assert.equal(calls[2].args.at(-1), calls[1].args.at(-1));
  assert.notEqual(calls[2].session, calls[0].session);
  assert.notEqual(calls[2].session, calls[1].session);
  const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].session, calls[0].session);
  assert.match(fallback[0].raison, /session.*chang/i);
  assert.ok(fallback[0].raison.includes(calls[0].session), fallback[0].raison);
  assert.ok(fallback[0].raison.includes(calls[1].session), fallback[0].raison);
  assert.doesNotMatch(fallback[0].raison, /hooks|approuv/i);
  assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: calls[2].session, run: calls[2].run });
  assert.equal(jsonLines(repo, "fake-review-calls").length, 2);
  assert.equal(repo.status(), "termine");
});

for (const hooks of ["missing-on-resume", "stale-on-resume"]) {
  test(`a Codex resume without a current witness falls back to a fresh guarded correction: ${hooks}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_HOOKS: hooks, FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
    });
    assert.equal(result.code, 0, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
    assert.equal(calls[2].args.at(-1), calls[1].args.at(-1));
    assert.equal(new Set(calls.map(c => c.run)).size, 3);
    assert.notEqual(calls[2].session, calls[0].session);
    assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: calls[2].session, run: calls[2].run });
    const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].ticket, "T001");
    assert.equal(fallback[0].attempt, 1);
    assert.equal(fallback[0].session, calls[0].session);
    assert.match(fallback[0].raison, /hooks Codex non chargés/);
    assert.equal(jsonLines(repo, "fake-review-calls").length, 2);
    assert.equal(repo.status(), "termine");
  });
}

for (const stage of ["before-turn", "after-turn"]) {
  test(`a Codex resume failure ${stage} only falls back before a turn starts`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_RESUME_FAILURE: stage, FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
    });
    const before = stage === "before-turn";
    assert.equal(result.code, before ? 0 : 2, result.out);
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, before ? 3 : 2);
    assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    const fallback = repo.events().filter(e => e.phase === "reprise-impossible");
    assert.equal(fallback.length, before ? 1 : 0);
    if (before) {
      assert.match(fallback[0].raison, /resume unavailable before turn/);
      assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
      assert.equal(calls[2].args.at(-1), calls[1].args.at(-1));
    } else assert.match(repo.failure(), /processus en échec/);
    assert.equal(jsonLines(repo, "fake-review-calls").length, before ? 2 : 1);
  });
}

test("the separate Claude reviewer does not inherit the Codex startup instructions", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  assert.equal(jsonLines(repo, "fake-review-calls")[0].engine, null);
});

test("Codex resumes a guarded correction with the ticket, report and existing tree before integration", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]) });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  const corrected = calls[1];
  assert.deepEqual(corrected.args.slice(0, 3), ["exec", "resume", calls[0].session]);
  const original = calls[0].args.slice(1, -1).filter((arg, i, args) => !["-s", "-C"].includes(arg) && !["-s", "-C"].includes(args[i - 1]));
  assert.deepEqual(corrected.args.slice(3, -3), original);
  assert.deepEqual(corrected.args.slice(-3, -1), ["-c", 'sandbox_mode="workspace-write"']);
  const prompt = corrected.args.at(-1);
  assert.ok(prompt.includes("T001"));
  assert.ok(prompt.includes("docs/travail/tickets/001-add-greeting.md"));
  assert.ok(prompt.includes(codexDir + "relecture-1.md"));
  assert.ok(prompt.includes(".agents/skills/ticket-codex/SKILL.md"));
  assert.match(prompt, /reprends.*travail.*arbre/i);
  assert.ok(prompt.includes(rejectedReview), "the complete report must reach the correction");
  for (const value of [
    'approval_policy="never"',
    'sandbox_workspace_write.network_access=true', 'model_reasoning_effort="high"',
  ]) assert.ok(corrected.args.some((arg, i) => arg === "-c" && corrected.args[i + 1] === value), corrected.args.join(" "));
  assert.equal(corrected.args.includes("--ignore-user-config"), false);
  assert.ok(corrected.args.includes("--dangerously-bypass-hook-trust"));
  assert.ok(corrected.args.includes("--json"));
  assert.equal(corrected.args[corrected.args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.equal(corrected.args.includes("-s"), false);
  assert.equal(corrected.args.includes("-C"), false);
  assert.equal(corrected.cwd, repo.root);
  assert.equal(corrected.stdin, "");
  assert.deepEqual(corrected.env, calls[0].env);
  assert.equal(corrected.greetingPresent, true);
  assert.equal(corrected.session, calls[0].session);
  assert.ok(corrected.run);
  assert.notEqual(corrected.run, calls[0].run);
  assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: corrected.session, run: corrected.run });
  const reviews = jsonLines(repo, "relectures.jsonl");
  assert.deepEqual(reviews.map(r => [r.revue, r.verdict]), [["revue-1.diff", "à corriger"], ["revue-2.diff", "accepté"]]);
  assert.equal(repo.read(codexDir + "relecture-1.md"), rejectedReview);
  assert.equal(repo.read(codexDir + "relecture-2.md"), correctedReview(acceptedReview));
  assert.equal(repo.status(), "termine");
  const ended = repo.events().find(e => e.phase === "session-terminee");
  assert.equal(ended.relectures, 2);
  assert.equal(ended.tours, 2);
  assert.deepEqual(ended.jetons, { input_tokens: 20, cached_input_tokens: 8, output_tokens: 10, reasoning_output_tokens: 4 });
  assert.equal(jsonLines(repo, "codex-1.jsonl").length, 10);
  assert.deepEqual(jsonLines(repo, "codex-1.jsonl").filter(e => e.type === "thread.started").map(e => e.thread_id), calls.map(c => c.session));
});

test("an unreadable Codex review resumes a correction naming its recorded report", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const unreadable = "Rapport incomplet : relire les preuves.";
  const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([unreadable, acceptedReview]) });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
  assert.ok(calls[1].args.at(-1).includes(codexDir + "relecture-1.md"));
  assert.ok(calls[1].args.at(-1).includes(unreadable));
  assert.equal(repo.read(codexDir + "relecture-1.md"), unreadable);
  assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(r => r.verdict), ["illisible", "accepté"]);
  assert.deepEqual(JSON.parse(repo.read(codexDir + "hooks-started.json")), { session: calls[1].session, run: calls[1].run });
});

test("a Codex correction reviewer receives the previous report and exact interdiff while the first review stays complete", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]) });
  assert.equal(result.code, 0, result.out);
  const reviews = jsonLines(repo, "fake-review-calls");
  assert.equal(reviews.length, 2);
  assert.doesNotMatch(reviews[0].prompt, /interdiff|relecture-\d+\.md|relecture de correction/i);
  assert.match(reviews[1].prompt, /relecture de correction/i);
  assert.ok(reviews[1].prompt.includes(codexDir + "relecture-1.md"), reviews[1].prompt);
  assert.ok(reviews[1].prompt.includes(codexDir + "revue-2.interdiff"), reviews[1].prompt);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir + "revue-2.interdiff")), true);
});

test("a complete Codex review can restart from a legacy recorded state without an interdiff", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  repo.write(codexDir + "revue-1.diff", "old review\n");
  repo.write(codexDir + "reviewed-state.json", JSON.stringify({ revue: "revue-1.diff", fichiers: {} }));
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  const reviews = jsonLines(repo, "fake-review-calls");
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].prompt, /revue-2\.diff/);
  assert.doesNotMatch(reviews[0].prompt, /interdiff|relecture de correction/i);
});

for (const previous of ["corrupt", "legacy", "missing"]) {
  test(`a Codex correction refuses a missing interdiff after a ${previous} state without crashing`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]), FAKE_CODEX_REVIEW_STATE: previous,
    });
    assert.equal(result.code, 2, result.out);
    assert.match(repo.failure(), /interdiff.*absent/i);
    assert.ok(repo.failure().includes(codexDir + "reviewed-state.json"), repo.failure());
    assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
    assert.deepEqual(repo.commits(), ["init"]);
    assert.doesNotMatch(result.out, /TypeError/);
  });
}

test("a Codex correction with an unresolved finding refuses the attempt without a third session", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]), FAKE_UNCORRECTED: "1",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.equal(jsonLines(repo, "fake-review-calls").length, 2);
  assert.ok(repo.failure().includes(codexDir + "relecture-2.md"), repo.failure());
  assert.match(repo.failure(), /non corrigé.*palier suivant/s);
  assert.equal(jsonLines(repo, "relectures.jsonl").at(-1).verdict, "à corriger");
  assert.deepEqual(repo.commits(), ["init"]);
});

test("Codex escalates immediately after an unresolved correction and starts a complete review on the next rung", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "2"], {
    FAKE_REVIEWS: JSON.stringify([rejectedReview, rejectedReview, acceptedReview]), FAKE_UNCORRECTED: "1",
  });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args.slice(0, 2), ["exec", "--json"]);
  assert.notEqual(calls[2].session, calls[0].session);
  assert.ok(calls[2].args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(calls[2].args.at(-1).includes("echec-1.txt"));
  assert.ok(repo.failure().includes(codexDir + "relecture-2.md"), repo.failure());
  assert.match(repo.failure(), /non corrigé.*palier suivant/s);
  assert.deepEqual(repo.events().filter(e => e.phase === "session-terminee").map(e => e.relectures), [2, 1]);
  assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.palier), [0, 1]);
  const reviews = jsonLines(repo, "fake-review-calls");
  assert.doesNotMatch(reviews[2].prompt, /interdiff|relecture-\d+\.md|relecture de correction/i);
});

for (const count of ["missing", "inconnu", "-1", "0 restant", "0.5"]) {
  test(`an absent or unreadable correction count refuses Codex without another correction: ${count}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]), FAKE_UNCORRECTED: count,
    });
    assert.equal(result.code, 2, result.out);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
    assert.ok(repo.failure().includes(codexDir + "relecture-2.md"), repo.failure());
    assert.deepEqual(repo.commits(), ["init"]);
  });
}

test("three rejected Codex reviews with resolved findings exhaust two corrections and the next attempt raises the Sol effort", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const reports = Array.from({ length: 3 }, (_, i) => (i ? correctedReview(rejectedReview) : rejectedReview) + `\nNouveau constat ${i + 1}.`);
  const result = repo.codex(["--attempts", "2"], { FAKE_REVIEWS: JSON.stringify([...reports, acceptedReview]) });
  assert.equal(result.code, 0, result.out);
  const calls = jsonLines(repo, "fake-codex-calls");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => c.args.slice(0, 2)), [["exec", "--json"], ["exec", "resume"], ["exec", "resume"], ["exec", "--json"]]);
  assert.equal(calls[1].args[2], calls[0].session);
  assert.equal(calls[2].args[2], calls[0].session);
  assert.notEqual(calls[3].session, calls[0].session);
  assert.deepEqual(calls.map(c => c.args[c.args.indexOf("-m") + 1]), Array(4).fill("gpt-6.1-sol"));
  assert.ok(calls[3].args.includes('model_reasoning_effort="xhigh"'));
  for (let i = 1; i <= 2; i++) {
    assert.ok(calls[i].args.at(-1).includes(reports[i - 1]));
    assert.ok(calls[i].args.at(-1).includes(codexDir + `relecture-${i}.md`));
  }
  assert.ok(repo.failure().includes(reports[2]), repo.failure());
  assert.equal(jsonLines(repo, "relectures.jsonl").length, 4);
  assert.deepEqual(repo.events().filter(e => e.phase === "session-terminee").map(e => e.relectures), [3, 1]);
  assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.palier), [0, 1]);
  assert.ok(calls[3].args.at(-1).includes("echec-1.txt"));
  assert.equal(repo.status(), "termine");
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /Co-Authored-By: Codex \(GPT-6.1 Sol\) <noreply@openai.com>/);
});

test("a Codex session that edits the quality check without harness permission is refused by the gates", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_EDIT: "scripts/check.mjs" });
  assert.equal(result.code, 2, result.out);
  assert.match(repo.failure(), /harnais a été modifié sans que le ticket l'autorise.*scripts\/check\.mjs/);
  assert.equal(jsonLines(repo, "relectures.jsonl")[0].verdict, "accepté");
  assert.deepEqual(repo.commits(), ["init"]);
});

test("the loop protects Codex hooks, instructions and their shared entry point without harness permission", (t) => {
  for (const file of [".codex/hooks.json", ".agents/skills/example/SKILL.md", "AGENTS.md"]) {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_EDIT: file });
    assert.equal(result.code, 2, result.out);
    assert.match(repo.failure(), /harnais a été modifié sans que le ticket l'autorise/);
    assert.ok(repo.failure().includes(file));
    assert.deepEqual(repo.commits(), ["init"]);
  }
});

test("a fixed Codex model keeps a separate Claude reviewer and applies the requested effort", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--model", "gpt-6-astra", "--effort", "xhigh"]);
  assert.equal(result.code, 0, result.out);
  const { args } = jsonLines(repo, "fake-codex-calls")[0];
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(jsonLines(repo, "fake-review-calls")[0].model, "opus");
});

test("Codex usage remains unknown in dollars through integration", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex();
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.events().find(e => e.phase === "integre").cout_usd, null);
  assert.doesNotMatch(result.out, /0\.00 \$/);
});

test("Codex prints a single action per completed command or file change item", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex([], { FAKE_CODEX_SCENARIO: "actions" });
  assert.equal(result.code, 0, result.out);
  const shown = result.out.split("\n").filter(line => /^\[boucle\] \d\d:\d\d /.test(line)).map(line => line.slice(14));
  assert.deepEqual(shown, ["  Bash node --test", "  Write core/greeting.cjs, core/farewell.cjs"]);
});

test("a failed Claude reviewer cannot accept a Codex change even when its output contains an acceptance", (t) => {
  for (const failure of ["error", "exit"]) {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEW_FAILURE: failure });
    assert.equal(result.code, 2, result.out);
    assert.deepEqual(jsonLines(repo, "relectures.jsonl").map(r => r.verdict), Array(3).fill("illisible"));
    assert.deepEqual(repo.commits(), ["init"]);
  }
});

test("the separate Claude reviewer runs outside ticket mode while Codex keeps its ticket environment", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls")[0].env.LOOP, "1");
  assert.equal(jsonLines(repo, "fake-review-calls")[0].loop, null);
  assert.equal(repo.read(codexDir + "relecture-1.md"), acceptedReview);
});

test("a blocked Codex verdict preserves the owner question and stops after one session without review", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex([], { FAKE_CODEX_SCENARIO: "blocked", FAKE_REVIEWS: JSON.stringify(Array(16).fill(rejectedReview)) });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
  assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  assert.equal(repo.status(), "bloque");
  assert.equal(repo.events().find(e => e.phase === "bloque").raison, "Quel fournisseur choisir ?");
  assert.ok(result.out.includes("Quel fournisseur choisir ?"), result.out);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("Codex hands back an absent, unreadable or partial verdict without asking for review", (t) => {
  for (const scenario of ["missing-verdict", "unreadable-verdict", "partial"]) {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_SCENARIO: scenario });
    assert.equal(result.code, 2, result.out);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false, scenario);
    assert.equal(jsonLines(repo, "fake-codex-calls").length, 1);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 0);
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    assert.deepEqual(repo.commits(), ["init"]);
  }
});

test("a Codex correction that becomes blocked preserves its new question without another review", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_SCENARIO: "blocked-after-correction", FAKE_REVIEWS: JSON.stringify(Array(4).fill(rejectedReview)),
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
  assert.equal(repo.events().find(e => e.phase === "bloque").raison, "Quel fournisseur choisir ?");
  assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 1);
  assert.deepEqual(repo.commits(), ["init"]);
});

test("Codex receives a null input device with immediate end of input", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  const call = jsonLines(repo, "fake-codex-calls")[0];
  assert.equal(call.stdinIsDevice, true);
  assert.equal(call.stdin, "");
});

test("a failed Codex session cannot be reviewed or integrated despite its finished verdict", (t) => {
  for (const failure of ["turn.failed", "error", "exit"]) {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], { FAKE_CODEX_FAILURE: failure });
    assert.equal(result.code, 2, result.out);
    assert.equal(JSON.parse(repo.read(codexDir + "verdict.json")).statut, "TERMINÉ");
    assert.equal(repo.events().filter(e => e.phase === "tentative-refusee").length, 1);
    const ended = repo.events().find(e => e.phase === "session-terminee");
    assert.equal(ended.code, 1);
    assert.equal(ended.relectures, 0);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
    assert.deepEqual(repo.commits(), ["init"]);
  }
});

test("a custom Codex model signs integration with the Codex engine name", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--model", "custom-codex-model", "--attempts", "1"]);
  assert.equal(result.code, 0, result.out);
  assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Co-Authored-By: Codex <noreply@openai\.com>$/m);
});

test("a fixed Claude model dry run uses readable defaults for effort and reviewer", (t) => {
  const repo = loopRepo();
  t.after(repo.cleanup);
  const result = repo.loop("done", ["--dry-run", "--model", "custom-claude-model"]);
  assert.equal(result.code, 0, result.out);
  const levels = result.out.split("\n").filter(line => line.startsWith("[boucle] Palier"));
  assert.deepEqual(levels, Array(3).fill("[boucle] Palier fixe : custom-claude-model, effort par défaut, relecteur hérité."));
  assert.doesNotMatch(result.out, /effort null|relecteur null|undefined/);
  assert.equal(repo.git("status", "--porcelain").stdout, "");
});

for (const reconnects of [[1], [2, 1]]) {
  test(`Codex integrates recovered stream errors and records each invocation: ${reconnects}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_RECONNECTIONS: JSON.stringify(reconnects),
      FAKE_REVIEWS: JSON.stringify(reconnects.length === 1 ? [acceptedReview] : [rejectedReview, acceptedReview]),
    });
    assert.equal(result.code, 0, result.out);
    assert.equal(repo.status(), "termine");
    const calls = jsonLines(repo, "fake-codex-calls");
    assert.equal(calls.length, reconnects.length);
    if (calls.length > 1) assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", calls[0].session]);
    const recovered = repo.events().filter(e => e.phase === "reconnexion");
    assert.deepEqual(recovered.map(e => [e.ticket, e.attempt, e.invocation]),
      calls.flatMap((call, i) => Array.from({ length: reconnects[i] }, () => ["T001", 1, call.run])));
    for (const call of calls) {
      assert.ok(result.out.split("\n").some(line => line.startsWith("[boucle]") &&
        line.includes(`T001 tentative 1 invocation ${call.run}`) && line.includes("reconnexion")), result.out);
    }
    const stream = jsonLines(repo, "codex-1.jsonl");
    assert.equal(stream.filter(e => e.type === "error").length, reconnects.reduce((sum, n) => sum + n, 0));
    assert.equal(stream.filter(e => e.type === "turn.completed").length, calls.length);
    const ended = repo.events().find(e => e.phase === "session-terminee");
    assert.equal(ended.code, 0);
    assert.equal(ended.tours, calls.length);
    assert.equal(ended.relectures, calls.length);
    assert.deepEqual(ended.jetons, {
      input_tokens: 10 * calls.length, cached_input_tokens: 4 * calls.length,
      output_tokens: 5 * calls.length, reasoning_output_tokens: 2 * calls.length,
    });
    assert.equal(repo.events().find(e => e.phase === "integre").tentatives, 1);
  });
}

for (const failure of ["unfinished-error", "failed-then-completed", "error", "exit", "missing-hooks"]) {
  test(`Codex recovery never hides a terminal failure: ${failure}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const result = repo.codex(["--attempts", "1"], {
      FAKE_CODEX_RECONNECTIONS: "[1]",
      FAKE_CODEX_FAILURE: failure === "missing-hooks" ? "" : failure,
      FAKE_CODEX_HOOKS: failure === "missing-hooks" ? "missing" : "valid",
    });
    assert.equal(result.code, 2, result.out);
    assert.deepEqual(repo.commits(), ["init"]);
    assert.equal(repo.events().find(e => e.phase === "session-terminee").relectures, 0);
    assert.equal(fs.existsSync(path.join(repo.root, codexDir, "fake-review-calls")), false);
  });
}

test("a recovered invocation cannot cover an unfinished error in a resumed correction", (t) => {
  const repo = codexRepo();
  t.after(repo.cleanup);
  const result = repo.codex(["--attempts", "1"], {
    FAKE_CODEX_RECONNECTIONS: "[1,0]", FAKE_CODEX_FAILURES: JSON.stringify(["", "unfinished-error"]),
    FAKE_REVIEWS: JSON.stringify([rejectedReview, acceptedReview]),
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(jsonLines(repo, "fake-codex-calls").length, 2);
  assert.equal(jsonLines(repo, "fake-review-calls").length, 1);
  assert.deepEqual(repo.commits(), ["init"]);
  assert.match(repo.failure(), /transport never recovered/);
});

const correctionReports = require("./helpers/correction-reports/expected.json");
for (const fixture of correctionReports) {
  test(`Codex carries complete findings from a historical correction report: ${fixture.file}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const report = fs.readFileSync(path.join(__dirname, "helpers/correction-reports", fixture.file), "utf8");
    const ownReserve = "Validation manuelle restant à programmer.";
    const result = repo.codex(["--attempts", "1"], {
      FAKE_REVIEWS: JSON.stringify([rejectedReview, report]), FAKE_CODEX_RESERVES: JSON.stringify([ownReserve]),
    });
    assert.equal(result.code, 0, result.out);
    const expected = [ownReserve, ...[...fixture.findings, ...fixture.deviations].map(lines =>
      `${codexDir}relecture-2.md : ${lines.join("\n")}`)];
    const kept = repo.events().find(e => e.phase === "integre").reserves;
    assert.deepEqual(kept, expected);
    assert.equal(fixture.findings.length, Number(/(\d+) hors périmètre/.exec(report)[1]));
    const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
    assert.doesNotMatch(journal, /Nombre de constats discordant|relecture-1.md|preuve manquante|nom à préciser/);
    for (const reserve of expected) {
      const item = reserve.split("\n").map((line, i) => i && line ? `  ${line}` : line).join("\n");
      assert.equal(journal.split(item).length - 1, 1, item);
    }
    assert.match(repo.git("log", "-1", "--format=%B").stdout,
      new RegExp(`^Reserves: ${expected.length}, listed in the ticket journal\\.$`, "m"));
    assert.deepEqual(JSON.parse(repo.read(codexDir + "verdict.json")).reste, [ownReserve]);
    assert.equal(jsonLines(repo, "fake-review-calls").length, 2);
  });
}

for (const title of [
  "**1. Réserve sur le diagnostic**",
  "- **Réserve sur le diagnostic**",
  "- (1) Hors périmètre (réserve) : diagnostic",
  "### 1. Réserve sur le diagnostic",
  "## 1. Réserve sur le diagnostic",
]) {
  test(`Codex keeps a finding with its location and class in the body: ${title}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const body = "\n\n- Où : `core/legacy.cjs:8`.\n\n- Problème : diagnostic perdu.\n\n- Attendu : ajouter un code.\n- Classe : hors périmètre.";
    const report = ["VERDICT : accepté", "CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre", "",
      "## Réserves hors périmètre", "", title + body, "", "## Synthèse", "",
      "- core/legacy.cjs:8 : hors périmètre, voir la réserve ci-dessus.", "", "## Critères", "",
      "1. core/legacy.cjs:8 : hors périmètre cité pour rappel."].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
    assert.equal(result.code, 0, result.out);
    const kept = repo.events().find(e => e.phase === "integre").reserves;
    const normalizedTitle = title.replace(/^(?:#{1,6}\s+|[-*+]\s+)/, "");
    assert.deepEqual(kept, [`${codexDir}relecture-2.md : ${normalizedTitle}${body}`]);
    assert.doesNotMatch(committedTicket(repo).split("### Réserves à la clôture\n")[1], /Synthèse|pour rappel|ci-dessus/);
  });
}

for (const body of [
  "- **Problème.** Le diagnostic est perdu.\n- **Attendu.** Ajouter un code.",
  "- **Classe** : hors périmètre.\n- **Problème.** Le diagnostic est perdu.",
  "1. Reproduire le diagnostic perdu.\n2. Vérifier le code d’erreur.",
]) {
  test(`Codex keeps fields and numbered steps inside the current finding: ${body.split("\n")[0]}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const findings = [
      `1. \`core/legacy.cjs:8\` — hors périmètre\n\n${body}\n\nLa suite reste dans le même constat.`,
      "2. `docs/notes.md:3` — hors périmètre\n\n- Attendu : actualiser l’exemple.",
    ];
    const report = ["VERDICT : accepté", "CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre", "",
      "## Constats", "", ...findings.map(finding => `### ${finding}`), "", "## Critères", "", "1. Critère couvert."].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
    assert.equal(result.code, 0, result.out);
    const expected = findings.map(finding => `${codexDir}relecture-2.md : ${finding}`);
    assert.deepEqual(repo.events().find(e => e.phase === "integre").reserves, expected);
    const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
    for (const reserve of expected) {
      const item = reserve.split("\n").map((line, i) => i && line ? `  ${line}` : line).join("\n");
      assert.equal(journal.split(item).length - 1, 1, journal);
    }
    assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 2, listed in the ticket journal\.$/m);
  });
}

for (const title of ["### 1. Réserve sur le diagnostic — hors périmètre", "**1. Réserve — hors périmètre**", "- **Réserve hors périmètre**"]) {
  for (const marker of ["-", "1."]) {
    test(`Codex keeps location lists inside a finding body: ${title}, ${marker}`, (t) => {
      const repo = codexRepo();
      t.after(repo.cleanup);
      const body = ["**Où :**", `${marker} \`core/legacy.cjs:8\``, `${marker === "-" ? "-" : "2."} docs/notes.md:3 : exemple périmé.`,
        "", "**Ce qui ne va pas.** Le diagnostic est perdu.", "", "**Attendu.** Ajouter un code.",
        "", "Le paragraphe final appartient au même constat."].join("\n");
      const finding = `${title.replace(/^(?:#{1,6}|[-*+])\s+/, "")}\n\n${body}`;
      const report = ["VERDICT : accepté", "CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre", "",
        "## Constats", "", title, "", body, "", "## Synthèse", "", "Un constat hors périmètre."].join("\n");
      const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
      assert.equal(result.code, 0, result.out);
      const expected = `${codexDir}relecture-2.md : ${finding}`;
      assert.deepEqual(repo.events().find(e => e.phase === "integre").reserves, [expected]);
      const journal = committedTicket(repo).split("### Réserves à la clôture\n")[1];
      const item = expected.split("\n").map((line, i) => i && line ? `  ${line}` : line).join("\n");
      assert.equal(journal.split(item).length - 1, 1, journal);
      assert.match(repo.git("log", "-1", "--format=%B").stdout, /^Reserves: 1, listed in the ticket journal\.$/m);
    });
  }
}

for (const section of ["### Synthèse", "#### Critères d'acceptation", "### Suivi des constats"]) {
  test(`Codex excludes finding reminders below a nested review section: ${section}`, (t) => {
    const repo = codexRepo();
    t.after(repo.cleanup);
    const finding = "`core/legacy.cjs:8` — hors périmètre\n\n- Problème : diagnostic perdu.\n- Attendu : ajouter un code.";
    const report = ["VERDICT : accepté", "CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre", "",
      "## Constats", "", `### ${finding}`, "", section, "",
      "1. core/legacy.cjs:8 : hors périmètre cité pour rappel.", "",
      "| Constat | Classe |", "| --- | --- |", "| diagnostic | hors périmètre |"].join("\n");
    const result = repo.codex(["--attempts", "1"], { FAKE_REVIEWS: JSON.stringify([rejectedReview, report]) });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(repo.events().find(e => e.phase === "integre").reserves,
      [`${codexDir}relecture-2.md : ${finding}`]);
  });
}

const reloadRepo = () => loopRepo({
  "docs/travail/tickets/001-add-greeting.md": ticketText({ harnais: "oui", niveau: "simple" }),
  "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", titre: "Add the farewell" }),
  "docs/travail/tickets/003-add-welcome.md": ticketText({ id: "T003", titre: "Add the welcome" }),
});
const observedLoop = (repo, id) => JSON.parse(repo.read(`.harness-state/tickets/${id}/loop-observed.json`));

for (const module of ["scripts/loop/models.mjs", "scripts/quality/ratchet.mjs"]) {
  test(`an integrated module is loaded by a fresh instance before the next ticket: ${module}`, (t) => {
    const repo = reloadRepo();
    t.after(repo.cleanup);
    const append = '\nif (process.argv[1]?.endsWith("loop/run.mjs")) {\n' +
      '  fs.appendFileSync(".harness-state/quality-loaded", String(process.pid) + "\\n");\n}\n';
    const result = repo.loop("reload-module", ["--max", "2", "--ticket", "T001", "--no-retro"], {
      FAKE_RELOAD_MODULE: module, FAKE_RELOAD_APPEND: module.includes("quality") ? append : "",
      FAKE_MARKER: "inherited value with spaces",
    });
    assert.equal(result.code, 0, result.out);
    const first = observedLoop(repo, "T001");
    const second = observedLoop(repo, "T002");
    assert.notEqual(second.pid, first.pid, "the next ticket must run in a new loop process");
    assert.equal(first.lock, String(first.pid));
    assert.equal(second.lock, String(second.pid));
    assert.equal(second.cwd, repo.root);
    assert.equal(second.marker, "inherited value with spaces");
    if (module.includes("models")) assert.equal(second.plan.model, "fresh model with spaces");
    else assert.equal(repo.read(".harness-state/quality-loaded"), `${second.pid}\n`);
    assert.deepEqual(repo.commits(), ["T002: Add the farewell", "T001: Add the greeting", "init"]);
    assert.equal(repo.read(".harness-state/tickets/T002/fake-attempts"), "1");
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T003")), false);
    assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.ticket), ["T001", "T002"]);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
    assert.equal(repo.git("status", "--porcelain").stdout, "");
  });
}

function startObservedLoop(t, repo, args, env = {}) {
  const output = path.join(repo.root, ".harness-state/output.log");
  fs.writeFileSync(output, "existing output\n");
  const fd = fs.openSync(output, "a");
  const child = spawn(process.execPath, ["scripts/loop/run.mjs", "--no-push", ...args], {
    cwd: repo.root, detached: true, stdio: ["ignore", fd, fd],
    env: repo.env({ HARNESS_CLAUDE_BIN: path.join(repo.root, ".harness-state/fake-claude.cjs"),
      FAKE_SCENARIO: "reload-module", FAKE_OBSERVER_PID: String(process.pid), ...env }),
  });
  fs.closeSync(fd);
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  t.after(async () => {
    signal("SIGCONT");
    signal("SIGTERM");
    await ended;
  });
  const waitFor = (name) => new Promise((resolve, reject) => {
    const file = path.join(repo.root, ".harness-state", name);
    const check = () => {
      if (!fs.existsSync(file)) return;
      const value = fs.readFileSync(file, "utf8");
      if (!value) return;
      process.off("SIGWINCH", check);
      resolve(value);
    };
    ended.then(() => {
      if (!fs.existsSync(file)) {
        process.off("SIGWINCH", check);
        reject(new Error(`The loop exited before ${name}: ${repo.read(".harness-state/output.log")}`));
      }
    }, reject);
    process.on("SIGWINCH", check);
    t.after(() => process.off("SIGWINCH", check));
    check();
  });
  return { child, ended, waitFor, output, signal };
}

const holdSuccessor = [
  'import { spawnSync as notifyLoop } from "node:child_process";',
  'if (process.send && process.argv[1]?.endsWith("loop/run.mjs")) {',
  '  const notify = \'process.kill(Number(process.argv[1]), "SIGSTOP");\' +',
  '    \'require("node:fs").writeFileSync(".harness-state/successor-ready", process.argv[1]);\' +',
  '    \'process.kill(Number(process.env.FAKE_OBSERVER_PID), "SIGWINCH");\';',
  '  notifyLoop(process.execPath, ["-e", notify, String(process.pid)]);',
  '  process.stderr.write("successor stderr\\n");',
  '}',
  '',
].join("\n");

const noProcess = (pid) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

for (const failure of ["SIGINT", "SIGTERM", "exception", "exit-code"]) {
  test(`a stopped first instance preserves its exit without a handover failure: ${failure}`, { timeout: 20000 }, async (t) => {
    const repo = reloadRepo();
    const crash = [
      'if (process.send) process.on("SIGUSR2", () => {',
      '  if (process.env.FAKE_WORKER_STOP === "exception") throw new TypeError("simulated worker failure");',
      '  process.exit(7);',
      '});',
      '',
    ].join("\n");
    repo.write("scripts/loop/models.mjs", repo.read("scripts/loop/models.mjs") + "\n" + crash);
    assert.equal(repo.git("add", "scripts/loop/models.mjs").code, 0);
    assert.equal(repo.git("commit", "-q", "-m", "worker failure fixture").code, 0);
    const signal = failure.startsWith("SIG") ? failure : null;
    const run = startObservedLoop(t, repo, ["--max", "2", "--no-retro"], {
      FAKE_SCENARIO: "stop-worker", FAKE_WORKER_SIGNAL: signal ?? "SIGUSR2", FAKE_WORKER_STOP: failure,
    });
    t.after(repo.cleanup);
    const ended = await run.ended;
    const code = failure === "exception" ? 1 : 7;
    assert.equal(repo.events().some(e => e.phase === "relance-echouee"), false);
    assert.deepEqual(ended, { code: signal ? null : code, signal });
    assert.doesNotMatch(repo.read(".harness-state/output.log"), /La relève de la boucle a échoué/);
    if (failure === "exception") assert.match(repo.read(".harness-state/output.log"), /TypeError: simulated worker failure/);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
    noProcess(Number(repo.read(".harness-state/loop/lock")));
    noProcess(run.child.pid);
    noProcess(-run.child.pid);
  });
}

test("a held handover keeps one owner, the launch history and redirected output", { timeout: 20000 }, async (t) => {
  const repo = reloadRepo();
  const run = startObservedLoop(t, repo, ["--max", "2", "--no-retro"], {
    FAKE_RELOAD_MODULE: "scripts/loop/models.mjs", FAKE_RELOAD_APPEND: "\n" + holdSuccessor, FAKE_HOLD_SECOND: "1",
  });
  t.after(repo.cleanup);
  const successor = Number(await run.waitFor("successor-ready"));
  const first = observedLoop(repo, "T001");
  noProcess(first.pid);
  assert.equal(repo.read(".harness-state/loop/lock"), String(run.child.pid));
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
  const before = fs.statSync(path.join(repo.root, ".harness-state/loop/lock")).mtimeMs;
  const ordinary = repo.loop("done", ["--no-retro"]);
  assert.equal(ordinary.code, 1, ordinary.out);
  assert.match(ordinary.out, /Une boucle tourne déjà/);
  process.kill(successor, "SIGCONT");
  assert.equal(Number(await run.waitFor("second-ready")), successor);
  assert.equal(repo.read(".harness-state/loop/lock"), String(successor));
  noProcess(first.pid);
  // Le verrou garde l'instant du premier lancement : c'est l'identité de la boucle pour qui la lit de l'extérieur.
  assert.ok(Math.abs(fs.statSync(path.join(repo.root, ".harness-state/loop/lock")).mtimeMs - before) < 0.01);
  process.kill(successor, "SIGCONT");
  assert.deepEqual(await run.ended, { code: 0, signal: null });
  noProcess(successor);
  noProcess(run.child.pid);
  noProcess(-run.child.pid);
  const output = repo.read(".harness-state/output.log");
  assert.ok(output.startsWith("existing output\n"));
  for (const id of ["T001", "T002"]) assert.match(output, new RegExp(`${id} intégré`));
  assert.match(output, /successor stderr/);
  assert.equal(repo.events().filter(e => e.phase === "integre").length, 2);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
});

test("fixed options, initial exclusions and tuning counters survive a module reload", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  repo.write("notes/café personnel.md", "mine\n");
  seedJournal(repo, [observation({ id: "R-T008-1", impact: "fort" })]);
  repo.write(".claude/skills/ticket/SKILL.md", "# Ticket\n");
  repo.git("add", ".claude/skills/ticket/SKILL.md");
  repo.git("commit", "-q", "-m", "instructions");
  const args = ["--max", "2", "--ticket", "T001", "--no-retro", "--tune-every", "2", "--model", "custom model with spaces",
    "--effort", "max", "--permission-mode", "mode with spaces", "--budget-usd", "3", "--timeout-min", "7", "--compact-window", "12345"];
  const result = repo.loop("reload-module", args, { FAKE_RELOAD_MODULE: "scripts/loop/models.mjs", FAKE_TUNE: "edits-skill" });
  assert.equal(result.code, 0, result.out);
  for (const id of ["T001", "T002"]) {
    const call = observedLoop(repo, id);
    assert.deepEqual(call.plan, { model: "custom model with spaces", effort: "max", review: null });
    assert.equal(call.window, "12345");
    for (const [key, value] of [["--permission-mode", "mode with spaces"], ["--max-budget-usd", "3"]]) {
      assert.equal(call.args[call.args.indexOf(key) + 1], value);
    }
    assert.equal(fs.existsSync(path.join(repo.root, `.harness-state/tickets/${id}/fake-retro-call`)), false);
    assert.deepEqual(JSON.parse(repo.read(`.harness-state/tickets/${id}/untracked-before.json`)), ["notes/café personnel.md"]);
  }
  const phases = repo.events().map(e => e.phase);
  assert.ok(phases.indexOf("relance") < phases.indexOf("harmonisation"), phases.join(","));
  assert.equal(phases.filter(p => p === "harmonisation").length, 1);
  assert.equal(phases.filter(p => p === "harmonisation-integree").length, 1);
  assert.equal(repo.read("notes/café personnel.md"), "mine\n");
  assert.doesNotMatch(repo.git("log", "--name-only", "--format=", "-3").stdout, /notes/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T003")), false);
});

test("the due retrospective and tuning finish once in the retiring instance before the successor starts", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  seedJournal(repo, [observation({ id: "R-T008-1", impact: "fort" })]);
  repo.write(".claude/skills/ticket/SKILL.md", "# Ticket\n");
  repo.git("add", ".claude/skills/ticket/SKILL.md");
  repo.git("commit", "-q", "-m", "instructions");
  const result = repo.loop("reload-module", ["--max", "2", "--tune-every", "1"], {
    FAKE_RELOAD_MODULE: "scripts/loop/models.mjs", FAKE_TUNE: "edits-skill",
  });
  assert.equal(result.code, 0, result.out);
  const events = repo.events();
  const rank = (phase) => events.findIndex(e => e.phase === phase);
  assert.ok(rank("retro") < rank("harmonisation-integree"));
  assert.ok(rank("harmonisation-integree") < rank("relance"));
  assert.ok(rank("relance") < events.findIndex(e => e.phase === "session" && e.ticket === "T002"));
  assert.deepEqual(events.filter(e => e.phase === "retro").map(e => e.ticket), ["T001", "T002"]);
  assert.equal(events.filter(e => e.phase === "harmonisation-integree").length, 1);
});

test("Codex remains the engine with its fixed model and effort after reload", (t) => {
  const repo = loopRepo({
    "docs/travail/tickets/001-add-greeting.md": ticketText({ harnais: "oui" }),
    "docs/travail/tickets/002-add-farewell.md": ticketText({ id: "T002", harnais: "oui" }),
  });
  t.after(repo.cleanup);
  const bin = linkFakeAgent(repo, "codex");
  const args = ["--engine", "codex", "--max", "2", "--no-retro", "--model", "custom codex model", "--effort", "xhigh"];
  const result = repo.loop("done", args, { HARNESS_CODEX_BIN: bin, FAKE_CODEX_EDIT: "scripts/loop/models.mjs" });
  assert.equal(result.code, 0, result.out);
  const calls = ["T001", "T002"].map(id => {
    const entries = repo.read(`.harness-state/tickets/${id}/fake-codex-calls`).trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 1);
    return entries[0];
  });
  assert.notEqual(calls[0].loopPid, calls[1].loopPid);
  for (const call of calls) {
    assert.equal(call.loopLock, String(call.loopPid));
    assert.equal(call.args[call.args.indexOf("-m") + 1], "custom codex model");
    assert.ok(call.args.includes('model_reasoning_effort="xhigh"'));
  }
  assert.deepEqual(repo.events().filter(e => e.phase === "session").map(e => e.moteur), ["codex", "codex"]);
});

for (const file of ["docs/notes.md", "scripts/loop/README.md", "scripts/quality/settings.json", "core/other.cjs"]) {
  test(`an integrated non-module path keeps the current instance: ${file}`, (t) => {
    const repo = reloadRepo();
    t.after(repo.cleanup);
    repo.write(file, file.endsWith(".json") ? "{}\n" : "// initial\n");
    repo.git("add", file);
    repo.git("commit", "-q", "-m", "fixture");
    const append = file.endsWith(".json") ? "\n" : "\n// documentation\n";
    const result = repo.loop("reload-module", ["--max", "2", "--no-retro"], { FAKE_RELOAD_MODULE: file, FAKE_RELOAD_APPEND: append });
    assert.equal(result.code, 0, result.out);
    assert.equal(observedLoop(repo, "T001").pid, observedLoop(repo, "T002").pid);
    assert.equal(repo.events().some(e => e.phase.startsWith("relance")), false);
  });
}

test("tightening only the baseline does not reload the loop", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  assert.equal(repo.node("scripts/quality/ratchet.mjs", ["--init"]).code, 0);
  repo.git("add", "scripts/quality/baseline.json");
  repo.git("commit", "-q", "-m", "baseline");
  const result = repo.loop("adds-test-case", ["--max", "2", "--no-retro"], { FAKE_TEST_FILE: "tests/sample.test.cjs" });
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.events().filter(e => e.phase === "integre").length, 2);
  assert.equal(repo.events().some(e => e.phase.startsWith("relance")), false);
});

test("a module integration at max one starts no successor ticket or reload", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  const result = repo.loop("reload-module", ["--max", "1", "--no-retro"], { FAKE_RELOAD_MODULE: "scripts/loop/models.mjs" });
  assert.equal(result.code, 0, result.out);
  assert.equal(repo.events().some(e => e.phase.startsWith("relance")), false);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
});

for (const failure of ["quality", "review", "commit", "push"]) {
  test(`a refused module integration never starts a successor: ${failure}`, (t) => {
    const repo = reloadRepo();
    t.after(repo.cleanup);
    if (failure === "commit") {
      repo.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
      fs.chmodSync(path.join(repo.root, ".git/hooks/pre-commit"), 0o755);
    }
    const env = { FAKE_SCENARIO: "reload-module", FAKE_RELOAD_MODULE: "scripts/loop/models.mjs" };
    if (failure === "quality") {
      env.FAKE_RELOAD_MODULE = "scripts/quality/ratchet.mjs";
      env.FAKE_RELOAD_APPEND = "\n// " + "x".repeat(200) + "\n";
    }
    if (failure === "review") env.FAKE_RELOAD_AFTER_REVIEW = "1";
    const args = ["--max", "2", "--no-retro", "--attempts", "1"];
    let result;
    if (failure === "push") {
      addRemote(repo, '#!/bin/sh\necho push >> ../push-calls\nexit 1\n');
      result = loopWithPush(repo, args, env);
      assert.equal(repo.read(".harness-state/push-calls"), "push\n");
    } else result = repo.loop("reload-module", args, env);
    assert.equal(result.code, failure === "push" ? 3 : 2, result.out);
    assert.equal(repo.events().some(e => e.phase.startsWith("relance")), false);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
    assert.equal(repo.commits().length, failure === "push" ? 2 : 1);
  });
}

test("renamed and deleted integrated module paths trigger reload without consulting ticket permissions", async (t) => {
  const repo = harnessRepo({
    "scripts/loop/old module.cjs": "module.exports = 1;\n",
    "scripts/quality/deleted.mjs": "export const value = 1;\n",
    "docs/other.mjs": "export const value = 1;\n",
  });
  t.after(repo.cleanup);
  const before = repo.git("rev-parse", "HEAD").stdout.trim();
  assert.equal(repo.git("mv", "scripts/loop/old module.cjs", "docs/moved.cjs").code, 0);
  assert.equal(repo.git("rm", "scripts/quality/deleted.mjs").code, 0);
  repo.write("docs/other.mjs", "export const value = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "move and delete");
  const { integratedModules } = await import(pathToFileURL(path.join(__dirname, "../../scripts/loop/restart.mjs")).href);
  assert.deepEqual(integratedModules(repo.git, before), ["scripts/loop/old module.cjs", "scripts/quality/deleted.mjs"]);
});

test("a reload starts the next ticket after a successful local push with no duplicate push", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  const remote = addRemote(repo, '#!/bin/sh\necho push >> ../push-calls\nexit 0\n');
  const result = loopWithPush(repo, ["--max", "2", "--no-retro"], {
    FAKE_SCENARIO: "reload-module", FAKE_RELOAD_MODULE: "scripts/loop/models.mjs",
  });
  assert.equal(result.code, 0, result.out);
  assert.notEqual(observedLoop(repo, "T001").pid, observedLoop(repo, "T002").pid);
  assert.equal(repo.read(".harness-state/push-calls"), "push\npush\n");
  const local = repo.git("rev-parse", "HEAD").stdout;
  assert.equal(repo.git("--git-dir", remote, "rev-parse", "work").stdout, local);
});

for (const failure of ["dirty-tree", "module-load"]) {
  test(`a failed successor stops the launch, records its cause and leaves no process: ${failure}`, { timeout: 20000 }, async (t) => {
    const repo = reloadRepo();
    const failImport = '\nif (process.send && process.argv[1]?.endsWith("loop/run.mjs")) throw new Error("simulated loader failure");\n';
    const run = startObservedLoop(t, repo, ["--max", "2", "--no-retro"], {
      FAKE_RELOAD_MODULE: "scripts/loop/models.mjs",
      FAKE_RELOAD_APPEND: "\n" + holdSuccessor + (failure === "module-load" ? failImport : ""),
    });
    t.after(repo.cleanup);
    const successor = Number(await run.waitFor("successor-ready"));
    const first = observedLoop(repo, "T001");
    noProcess(first.pid);
    if (failure === "dirty-tree") {
      repo.write("package.json", '{ "name": "changed" }\n');
      const ordinary = repo.loop("done", ["--no-retro"]);
      assert.equal(ordinary.code, 1, ordinary.out);
      assert.match(ordinary.out, /fichiers suivis sont modifiés/);
      process.kill(successor, "SIGCONT");
    } else process.kill(successor, "SIGCONT");
    assert.deepEqual(await run.ended, { code: 1, signal: null });
    noProcess(first.pid);
    noProcess(successor);
    noProcess(run.child.pid);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T002")), false);
    assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/loop/lock")), false);
    const failed = repo.events().find(e => e.phase === "relance-echouee");
    assert.equal(failed.cause, failure === "module-load" ? "LOOP_MODULE_FAILED" : "LOOP_WORKER_FAILED");
    assert.match(failed.raison, failure === "module-load" ? /simulated loader failure/ : /code 1/);
    assert.match(repo.read(".harness-state/output.log"), /La relève de la boucle a échoué/);
    if (failure === "module-load") assert.match(repo.read(".harness-state/output.log"), /simulated loader failure/);
  });
}

test("the supervisor reloads its own owner before launching a fresh worker", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  const append = '\nif (!process.send && process.argv[1]?.endsWith("loop/run.mjs")) {\n' +
    '  fs.writeFileSync(".harness-state/supervisor-reloaded", String(process.pid));\n}\n';
  const result = repo.loop("reload-module", ["--max", "2", "--no-retro"], {
    FAKE_RELOAD_MODULE: "scripts/loop/restart.mjs", FAKE_RELOAD_APPEND: append,
  });
  assert.equal(result.code, 0, result.out);
  const supervisor = Number(repo.read(".harness-state/supervisor-reloaded"));
  assert.ok(supervisor > 0);
  noProcess(supervisor);
  assert.notEqual(observedLoop(repo, "T001").pid, observedLoop(repo, "T002").pid);
});

test("the successor still refuses a change made after review and preserves the blocked exit code", (t) => {
  const repo = reloadRepo();
  t.after(repo.cleanup);
  const result = repo.loop("reload-module", ["--max", "3", "--no-retro", "--attempts", "1"], {
    FAKE_RELOAD_MODULE: "scripts/loop/models.mjs", FAKE_RELOAD_AFTER_REVIEW: "T002",
  });
  assert.equal(result.code, 2, result.out);
  assert.equal(repo.events().filter(e => e.phase === "relance").length, 1);
  assert.match(repo.read(".harness-state/tickets/T002/echec-1.txt"), /modifié depuis la dernière relecture/);
  assert.equal(fs.existsSync(path.join(repo.root, ".harness-state/tickets/T003")), false);
  assert.deepEqual(repo.commits(), ["T001: Add the greeting", "init"]);
});
