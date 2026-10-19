// Extrait exact de .harness-state/tickets/T202/codex-1.jsonl:157-158, trace du 17 octobre 2026.
const CAPACITY_EVENTS = [
  { type: "error", message: "Selected model is at capacity. Please try a different model." },
  { type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } },
];

// Refus réel du fournisseur, conservé avec sa ponctuation et sa date sans fuseau.
const QUOTA_MESSAGE = "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits " +
  "or try again at Oct 22nd, 2026 8:41 AM.";
const QUOTA_EVENTS = [
  { type: "error", message: QUOTA_MESSAGE },
  { type: "turn.failed", error: { message: QUOTA_MESSAGE } },
];

// Avertissements de démarrage de .harness-state/tickets/T202/codex-1.jsonl:101-104, le 17 octobre 2026.
const STARTUP_WARNING_MESSAGES = [
  "Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n" +
    "  user (/Users/Dabi/.codex/config.toml): `features.rmcp_client` is ignored.",
  "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
];
const STARTUP_WARNING_EVENTS = [0, 1, 0, 1].map((index, i) => ({
  type: "item.completed", item: { id: `item_${i}`, type: "error", message: STARTUP_WARNING_MESSAGES[index] },
}));

// Une session externe factice permet de vérifier le protocole sans appeler de fournisseur réel.
const CODEX_SESSION = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(".harness-state", "tickets", process.env.HARNESS_TICKET);
fs.mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
if (args[0] === "mcp") {
  fs.appendFileSync(path.join(dir, "fake-mcp-calls"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
  console.log(process.env.FAKE_CODEX_MCP_LIST || JSON.stringify([
    { name: "docs", enabled: true }, { name: "offline", enabled: false },
  ]));
  process.exit(process.env.FAKE_CODEX_MCP_FAILURE ? 1 : 0);
}
const calls = path.join(dir, "fake-codex-calls");
const rank = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\\n").length : 0;
if (args.includes("--help")) {
  fs.appendFileSync(path.join(dir, "fake-help-calls"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
  const unsupported = JSON.parse(process.env.FAKE_CODEX_UNSUPPORTED_RESUMES || "null")?.[rank] ?? process.env.FAKE_CODEX_UNSUPPORTED_RESUME;
  if (args[0] === "exec" && args[1] === "resume" && unsupported && args.includes(unsupported)) {
    console.error(process.env.FAKE_CODEX_HELP_DIAGNOSTIC || "unexpected argument: " + unsupported);
    process.exit(1);
  }
  console.log("--disable <FEATURE> --add-dir <DIR>");
  process.exit(0);
}
const scenario = process.env.FAKE_CODEX_SCENARIO;
const resumeFailure = args[1] === "resume" && process.env.FAKE_CODEX_RESUME_FAILURE;
let failure = resumeFailure === "after-turn" ? "exit" : process.env.FAKE_CODEX_FAILURE;
failure = JSON.parse(process.env.FAKE_CODEX_FAILURES || "null")?.[rank] ?? failure;
const resumedSession = process.env.FAKE_CODEX_RESUME_SESSION || args[2];
const session = args[1] === "resume" ? resumedSession : "codex-thread-" + (rank + 1);
const blocked = scenario === "blocked" || (scenario === "blocked-after-correction" && rank > 0);
const names = ["LOOP", "TICKET", "TICKET_FILE", "EDIT", "ALLOW_INSTALL"];
const env = Object.fromEntries(names.map(name => [name, process.env["HARNESS_" + name]]));
const stdinIsDevice = fs.fstatSync(0).isCharacterDevice();
// Une régression vers un pipe doit échouer sur une assertion, sans attendre sa fermeture.
const stdin = stdinIsDevice ? fs.readFileSync(0, "utf8") : null;
let previousAlive = false;
if (rank > 0) {
  const previous = JSON.parse(fs.readFileSync(calls, "utf8").trim().split("\\n").at(-1));
  try {
    process.kill(previous.pid, 0);
    previousAlive = true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
const call = {
  args, cwd: process.cwd(), stdin, stdinIsDevice, env, engine: process.env.HARNESS_ENGINE,
  loopPid: process.ppid, loopLock: fs.readFileSync(".harness-state/loop/lock", "utf8"),
  launchedAt: fs.statSync(".harness-state/loop/lock").mtimeMs,
  session, run: process.env.HARNESS_HOOK_RUN, greetingPresent: fs.existsSync("core/greeting.cjs"),
  greeting: fs.existsSync("core/greeting.cjs") ? fs.readFileSync("core/greeting.cjs", "utf8") : null,
  pid: process.pid, previousAlive, reviewCount: fs.existsSync(path.join(dir, "fake-review-calls")) ?
    fs.readFileSync(path.join(dir, "fake-review-calls"), "utf8").trim().split("\\n").length : 0,
};
fs.appendFileSync(calls, JSON.stringify(call) + "\\n");
const beforeWork = JSON.parse(process.env.FAKE_CODEX_BEFORE_WORK_EVENTS || "null")?.[rank];
if (beforeWork) {
  for (const event of beforeWork) console.log(JSON.stringify(event));
  process.exit(1);
}
const capacity = ${JSON.stringify(CAPACITY_EVENTS)};
if (failure === "capacity-before-thread") {
  for (const event of capacity) console.log(JSON.stringify(event));
  process.exit(1);
}
const hooks = JSON.parse(process.env.FAKE_CODEX_HOOKS_BY_INVOCATION || "null")?.[rank] ?? process.env.FAKE_CODEX_HOOKS;
if (hooks !== "missing" && !(rank > 0 && hooks === "missing-on-correction") &&
    !(args[1] === "resume" && hooks === "missing-on-resume")) {
  const { spawnSync } = require("node:child_process");
  const input = { cwd: process.cwd(), session_id: session, hook_event_name: "SessionStart" };
  const started = spawnSync(process.execPath, [".claude/hooks/session-context.mjs"], { input: JSON.stringify(input), encoding: "utf8" });
  if (started.status !== 0) throw new Error("startup hook failed: " + started.stdout + started.stderr);
  fs.appendFileSync(path.join(dir, "fake-hook-witnesses"), fs.readFileSync(path.join(dir, "hooks-started.json"), "utf8").trim() + "\\n");
}
if (args[1] === "resume" && hooks === "stale-on-resume") {
  const previous = JSON.parse(fs.readFileSync(calls, "utf8").split("\\n")[0]);
  fs.writeFileSync(path.join(dir, "hooks-started.json"), JSON.stringify({ session, run: previous.run }));
}
if (["before-turn", "before-turn-warnings", "before-thread-warnings"].includes(resumeFailure)) {
  if (resumeFailure !== "before-thread-warnings") console.log(JSON.stringify({ type: "thread.started", thread_id: session }));
  if (resumeFailure.endsWith("warnings")) {
    for (const event of ${JSON.stringify(STARTUP_WARNING_EVENTS)}) console.log(JSON.stringify(event));
  }
  console.log(JSON.stringify({ type: "error", message: "resume unavailable before turn" }));
  process.exit(1);
}
fs.mkdirSync("core", { recursive: true });
if (!blocked) fs.writeFileSync("core/greeting.cjs", "module.exports = () => 'hello';\\n");
if (process.env.FAKE_CODEX_JOURNAL) fs.appendFileSync(process.env.HARNESS_TICKET_FILE, process.env.FAKE_CODEX_JOURNAL);
const greeting = JSON.parse(process.env.FAKE_CODEX_GREETINGS || "null")?.[rank];
if (greeting) fs.writeFileSync("core/greeting.cjs", "module.exports = () => " + JSON.stringify(greeting) + ";\\n");
if (process.env.FAKE_UNTRACKED_CHANGE) {
  const file = path.join(dir, "untracked-before.json");
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.env.FAKE_UNTRACKED_CHANGE === "add") before.push("core/greeting.cjs");
  if (process.env.FAKE_UNTRACKED_CHANGE === "remove") before.pop();
  fs.writeFileSync(file, JSON.stringify(before));
  if (process.env.FAKE_UNTRACKED_CHANGE === "delete") fs.rmSync(file);
}
if (process.env.FAKE_CODEX_EDIT) {
  const file = process.env.FAKE_CODEX_EDIT;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, "\\n// La doublure simule une modification interdite du harnais.\\n");
}
if (process.env.FAKE_CODEX_STAGE) {
  const { spawnSync } = require("node:child_process");
  const staged = spawnSync("git", ["add", "--", process.env.FAKE_CODEX_STAGE]);
  if (staged.status !== 0) throw new Error("fake staging failed");
}
const verdict = {
  statut: blocked ? "BLOQUÉ" : "TERMINÉ", resume: blocked ? "Quel fournisseur choisir ?" : "fake codex",
  preuves: ["fake proof"], reste: JSON.parse(process.env.FAKE_CODEX_RESERVES || "[]"),
};
if (scenario === "partial") verdict.statut = "PARTIEL";
if (scenario !== "missing-verdict") fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(verdict));
if (scenario === "unreadable-verdict") fs.writeFileSync(path.join(dir, "verdict.json"), "{ incomplete");
if (rank > 0 && process.env.FAKE_CODEX_REVIEW_STATE) {
  const file = path.join(dir, "reviewed-state.json");
  const change = process.env.FAKE_CODEX_REVIEW_STATE;
  if (change === "corrupt") fs.writeFileSync(file, "{ incomplete");
  if (change === "missing") fs.rmSync(file, { force: true });
  if (change === "legacy") {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    delete state.arbre;
    fs.writeFileSync(file, JSON.stringify(state));
  }
}
const events = [
  { type: "thread.started", thread_id: session },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "command_execution", command: "node --test", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { type: "file_change", changes: [{ path: "core/greeting.cjs", kind: "add" }], status: "completed" } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 } },
];
if (process.env.FAKE_CODEX_SCENARIO === "actions") {
  events.splice(2, 2,
    { type: "item.started", item: { type: "command_execution", command: "pending command" } },
    { type: "item.completed", item: { type: "command_execution", command: "node\\n --test" } },
    { type: "item.completed", item: { type: "file_change", changes: [
      { path: path.resolve("core/greeting.cjs"), kind: "update" }, { path: "core/farewell.cjs", kind: "delete" },
    ] } },
  );
}
const reconnects = Number(JSON.parse(process.env.FAKE_CODEX_RECONNECTIONS || "[]")[rank] || 0);
for (let i = 0; i < reconnects; i++) {
  events.splice(2 + i, 0, { type: "error", message: "transport interrupted " + (i + 1) });
}
if (failure === "unfinished-error") {
  events.splice(events.length - 1, 1, { type: "error", message: "transport never recovered" });
}
if (failure === "failed-then-completed") events.splice(events.length - 1, 0, { type: "turn.failed", error: { message: "explicit failure" } });
if (["turn.failed", "error"].includes(failure)) events.push({ type: failure, error: { message: "simulated Codex failure" } });
if (failure === "capacity") events.splice(events.length - 1, 1, ...capacity);
if (failure === "capacity-error-only") events.splice(events.length - 1, 1, capacity[0]);
if (failure === "capacity-failed-only") events.splice(events.length - 1, 1, capacity[1]);
if (failure === "capacity-after-usage") events.push({ type: "turn.started" }, ...capacity);
if (failure === "capacity-recovered") events.splice(2, 0, capacity[0]);
if (failure === "capacity-tool") events.splice(2, 0,
  { type: "item.completed", item: { type: "command_execution", command: "cat fixture", aggregated_output: capacity[0].message } },
  { type: "item.completed", item: { type: "agent_message", text: capacity[0].message } },
);
if (failure === "capacity-stderr") {
  console.error(capacity[0].message);
  process.exitCode = 1;
}
if (failure === "capacity-signal") {
  for (const event of capacity) console.log(JSON.stringify(event));
  process.kill(process.pid, "SIGTERM");
}
const byTicket = JSON.parse(process.env.FAKE_CODEX_EVENTS_BY_TICKET || "null")?.[process.env.HARNESS_TICKET];
const custom = byTicket?.[rank] ?? JSON.parse(process.env.FAKE_CODEX_EVENTS || "null")?.[rank];
if (custom) events.splice(0, events.length, ...custom);
if (process.env.FAKE_CODEX_STDERR) process.stderr.write(process.env.FAKE_CODEX_STDERR);
for (const event of events) console.log(JSON.stringify(event));
if (failure === "exit") process.exitCode = 1;
`;

module.exports = { CODEX_SESSION, CAPACITY_EVENTS, QUOTA_EVENTS, STARTUP_WARNING_EVENTS };
