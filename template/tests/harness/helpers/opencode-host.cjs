// Hôte OpenCode factice : charge le plugin du harnais comme OpenCode 2 le fait (un module ESM par défaut, `setup(ctx)`,
// des hooks enregistrés par domaine), puis rejoue chaque appel d'outil dans l'ordre observé sur OpenCode 2.0.22 :
// execute.before, évaluation de la permission (même identifiant d'appel), exécution, execute.after.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PERMISSIONS = { write: "edit", edit: "edit", patch: "edit", shell: "shell" };

// OpenCode charge le plugin avec Bun ; Node, ici, avertirait sur l'erreur standard qu'il détecte un module ESM dans un
// fichier .js sans « type » : cet avertissement propre à l'hôte factice ne doit pas entrer dans les diagnostics testés.
process.removeAllListeners("warning");

async function loadPlugin(root, { agent = "ticket-opencode" } = {}) {
  const hooks = {};
  const domain = (name) => ({
    hook: async (hook, callback) => {
      (hooks[`${name}.${hook}`] ||= []).push(callback);
      return { dispose: async () => {} };
    },
  });
  const ctx = {
    location: { directory: root, project: { directory: root } },
    tool: domain("tool"), permission: domain("permission"), session: domain("session"), shell: domain("shell"),
  };
  const plugin = (await import(pathToFileURL(path.join(root, ".opencode/plugins/harness.js")).href)).default;
  await plugin.setup(ctx);
  // Un hook qui lève une exception serait une erreur fatale de la session OpenCode : l'hôte la remonte telle quelle.
  const trigger = async (key, event) => {
    for (const callback of hooks[key] || []) await callback(event);
    return event;
  };
  let rank = 0;
  return {
    id: plugin.id,
    hooks: Object.keys(hooks).sort(),
    async prompt(sessionID, text) {
      const event = { sessionID, messageID: "msg_fake", prompt: { text, files: [] }, delivery: "steer" };
      await trigger("session.prompt", event);
      return event.prompt.text;
    },
    async compaction(sessionID) {
      const event = { sessionID, agent, model: { providerID: "fake", id: "fake" }, system: [], messages: [], options: {}, tools: {} };
      await trigger("session.compaction", event);
      return event.system;
    },
    /** Un appel d'outil ; `execute` fait l'effet de l'outil et rend son texte. */
    async call(sessionID, tool, input, execute = async () => "ok") {
      const id = `call_fake_${++rank}`;
      const base = { tool, sessionID, agent, messageID: "msg_fake", id };
      const before = await trigger("tool.execute.before", { ...base, input });
      const action = PERMISSIONS[tool];
      if (action) {
        const evaluation = await trigger("permission.evaluate", {
          sessionID, agent, action, resources: [String(input?.path ?? input?.command ?? "*")],
          source: { type: "tool", messageID: "msg_fake", id }, effect: "allow",
        });
        if (evaluation.effect !== "allow") return { status: "error", effect: evaluation.effect, error: evaluation.message };
      }
      const text = await execute(before.input);
      const after = await trigger("tool.execute.after", {
        ...base, input: before.input, status: "completed", result: { content: [{ type: "text", text }] },
      });
      return { status: "completed", content: after.result.content.map((part) => part.text) };
    },
  };
}

module.exports = { loadPlugin };
