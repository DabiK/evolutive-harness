// Fausse session OpenCode : `opencode run --format json` et `opencode session export`, sans fournisseur réel. Elle charge
// le vrai plugin du harnais par l'hôte factice, fait passer ses écritures et ses commandes par ses hooks et écrit le flux
// JSONL d'OpenCode 2.0.22 (step_start, tool_use, step_finish, text, error ; la dernière étape sans step_finish).
const path = require("node:path");

const HOST = path.join(__dirname, "opencode-host.cjs");

const OPENCODE_SESSION = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadPlugin } = require(${JSON.stringify(HOST)});
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const dir = path.join(".harness-state", "tickets", process.env.HARNESS_TICKET || "aucun");
fs.mkdirSync(dir, { recursive: true });
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").filter(Boolean) : []);
if (args[0] === "session" && args[1] === "export") {
  fs.appendFileSync(path.join(dir, "fake-opencode-exports"), JSON.stringify({ args, configDir: process.env.OPENCODE_CONFIG_DIR }) + "\\n");
  if (process.env.FAKE_OPENCODE_EXPORT === "fail") process.exit(1);
  const cost = Number(process.env.FAKE_OPENCODE_COST ?? "0.0125");
  const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 1 } };
  console.log(JSON.stringify({ info: { id: args[2], cost, tokens, outcome: "succeeded" }, messages: [] }));
  process.exit(0);
}
const callsFile = path.join(dir, "fake-opencode-calls");
const rank = lines(callsFile).length;
const stdinStat = fs.fstatSync(0);
const stdinIsPipe = stdinStat.isFIFO() || stdinStat.isSocket();
const prompt = fs.readFileSync(0, "utf8");
const configDir = process.env.OPENCODE_CONFIG_DIR;
const names = ["LOOP", "ENGINE", "TICKET", "TICKET_FILE", "EDIT", "ALLOW_INSTALL"];
const call = {
  args, prompt, stdinIsPipe, cwd: process.cwd(), run: process.env.HARNESS_HOOK_RUN,
  env: Object.fromEntries(names.map((name) => [name, process.env["HARNESS_" + name] ?? null])),
  configDir, configEmpty: Boolean(configDir) && fs.existsSync(configDir) && fs.readdirSync(configDir).length === 0,
};
const resumed = option("--session");
const session = resumed || "ses_fake" + (rank + 1);
const scenario = JSON.parse(process.env.FAKE_OPENCODE_SCENARIOS || "null")?.[rank] ?? process.env.FAKE_OPENCODE_SCENARIO ?? "done";
const emit = (type, data = {}) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: session, ...data }));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const verdict = (statut, extra = {}) => {
  const value = { statut, resume: "fake opencode", preuves: ["fake"], reste: [], ...extra };
  write(path.join(dir, "verdict.json"), JSON.stringify(value));
};
(async () => {
  if (resumed && process.env.FAKE_OPENCODE_RESUME_FAILURE === "1") {
    fs.appendFileSync(callsFile, JSON.stringify(call) + "\\n");
    emit("error", { error: { type: "unknown", message: "Session not found: " + resumed } });
    process.exit(1);
  }
  const host = process.env.FAKE_OPENCODE_PLUGIN === "missing" ? null : await loadPlugin(process.cwd());
  call.prompt = host ? await host.prompt(session, prompt) : prompt;
  const tools = [];
  call.tools = tools;
  const tool = async (name, input, execute) => {
    const result = host ? await host.call(session, name, input, execute) : { status: "completed", content: [await execute(input)] };
    tools.push({ name, input, ...result });
    const state = result.status === "completed"
      ? { status: "completed", input, output: result.content.join("\\n") }
      : { status: "error", input, error: result.error };
    emit("tool_use", { part: { type: "tool", tool: name, state } });
    return result;
  };
  const writeTool = (file, text) => tool("write", { path: file, content: text }, async () => {
    write(file, text);
    return "Created file successfully: " + file;
  });
  const shellTool = (command) => tool("shell", { command }, async () => {
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    return (result.stdout || "") + (result.stderr || "");
  });
  const greeting = () => writeTool("core/greeting.cjs", "module.exports = () => 'hello';\\n");
  emit("step_start", { part: { type: "step-start" } });
  const scenarios = {
    async done() {
      await greeting();
      verdict("TERMINÉ");
    },
    async "edits-harness"() {
      await writeTool("scripts/check.mjs", "// weakened\\n");
      await greeting();
      verdict("TERMINÉ");
    },
    async "commits"() {
      await shellTool("git commit -m sneaky");
      await greeting();
      verdict("TERMINÉ");
    },
    async "long-line"() {
      await writeTool("core/greeting.cjs", "module.exports = '" + "x".repeat(200) + "';\\n");
      verdict("TERMINÉ");
    },
    async "no-verdict"() {
      await greeting();
    },
    async blocked() {
      verdict("BLOQUÉ", { resume: "Quel fournisseur choisir ?" });
    },
    async partial() {
      await greeting();
      verdict("PARTIEL", { reste: ["tests"] });
    },
    async compacts() {
      if (host) await host.compaction(session);
      await greeting();
      verdict("TERMINÉ");
    },
  };
  await scenarios[scenario]();
  call.files = fs.existsSync("scripts/check.mjs") ? { check: fs.readFileSync("scripts/check.mjs", "utf8").includes("weakened") } : {};
  fs.appendFileSync(callsFile, JSON.stringify(call) + "\\n");
  const tokens = { input: 10, output: 5, reasoning: 1, cache: { read: 4, write: 0 } };
  emit("step_finish", { part: { type: "step-finish", reason: "tool-calls", cost: 0.001, tokens } });
  emit("step_start", { part: { type: "step-start" } });
  emit("text", { part: { type: "text", text: "FIN" } });
  const failure = JSON.parse(process.env.FAKE_OPENCODE_FAILURES || "null")?.[rank] ?? process.env.FAKE_OPENCODE_FAILURE;
  if (failure === "error") {
    emit("error", { error: { type: "provider.error", message: "simulated OpenCode failure" } });
    process.exitCode = 1;
  }
  if (failure === "exit") {
    process.stderr.write("simulated crash\\n");
    process.exitCode = 2;
  }
})();
`;

module.exports = { OPENCODE_SESSION };
