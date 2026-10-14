#!/usr/bin/env node
// PreCompact : note chaque compaction d'une session de ticket et dit au résumé ce qu'il doit garder.
// Une session qui se compacte traite un ticket trop gros pour elle : la boucle le signale à partir de ce fichier.
import fs from "node:fs";
import path from "node:path";
import { loopMode, projectDir, readInput, stateDir } from "./lib.mjs";

const input = readInput();
const ticket = process.env.HARNESS_TICKET;
if (!loopMode || !ticket) process.exit(0);

const line = { at: new Date().toISOString(), trigger: input.trigger || null, session: input.session_id || null, agent: input.agent_id || null };
fs.appendFileSync(path.join(stateDir(projectDir(input), "tickets", ticket), "compactions.jsonl"), JSON.stringify(line) + "\n");

// Ce que le hook écrit ici s'ajoute aux consignes du résumé.
console.log(
  [
    `Session de ticket ${ticket}. Le résumé doit conserver mot pour mot :`,
    `- le chemin du ticket (${process.env.HARNESS_TICKET_FILE || "docs/travail/tickets/"}) et ses critères d'acceptation ;`,
    "- l'étape en cours de la skill « ticket » et le dernier jalon écrit dans le journal du ticket ;",
    "- les constats du relecteur qui ne sont pas encore corrigés ;",
    `- l'obligation d'écrire .harness-state/tickets/${ticket}/verdict.json avant de terminer, sans committer ni pousser.`,
  ].join("\n"),
);
