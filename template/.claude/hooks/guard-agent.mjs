#!/usr/bin/env node
// PreToolUse(Agent) : dans une session de ticket, un sous-agent se lance au premier plan, et le relecteur sur
// le modèle que la boucle a choisi pour lui (HARNESS_REVIEW_MODEL).
// Lancé en arrière-plan, un sous-agent rend la main avant d'avoir fini : l'orchestrateur terminerait son tour
// sans verdict. L'appel est corrigé plutôt que refusé : un refus coûte un tour pour aboutir au même appel.
import { loopMode, readInput } from "./lib.mjs";

const input = readInput();
if (loopMode) {
  const call = { ...input.tool_input, run_in_background: false };
  const reviewModel = process.env.HARNESS_REVIEW_MODEL;
  if (call.subagent_type === "relecteur" && reviewModel) call.model = reviewModel;
  const output = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "Sous-agent de ticket : premier plan" + (call.model ? `, modèle ${call.model}` : ""),
    updatedInput: call,
  };
  console.log(JSON.stringify({ hookSpecificOutput: output }));
}
