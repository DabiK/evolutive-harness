#!/usr/bin/env node
// PreToolUse(Bash) : arrête les commandes destructrices, les contournements et, en boucle, tout ce qui
// relève de l'intégration (commit, push, branches). C'est un garde-fou sur le texte de la commande,
// pas un bac à sable : il rattrape l'erreur, pas la malveillance.
import { decide, loopMode, readInput, refuseOrAsk } from "./lib.mjs";

const command = String(readInput().tool_input?.command || "");

// Toujours contrôlées : refusées en boucle, soumises à confirmation en interactif.
const RISKY = [
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard efface le travail non committé"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean supprime des fichiers non suivis"],
  [/\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/, "push forcé"],
  [/\bgit\s+(commit|push|merge)\b.*--no-verify\b/, "--no-verify contourne les contrôles"],
  [/\bgit\s+branch\s+-D\b/, "suppression forcée d'une branche"],
  [/\bgit\s+worktree\s+remove\b/, "suppression d'un worktree"],
  [/\bgit\s+stash\s+(drop|clear)\b/, "suppression d'un stash"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "abandon de toutes les modifications locales"],
  [/\bsudo\b/, "sudo"],
  [/(^|[;&|]\s*)(ssh|scp|rsync)\s/, "accès à une machine distante"],
  [/\bnpm\s+publish\b/, "publication npm"],
  [/\b(curl|wget)\b.*\|\s*(ba|z)?sh\b/, "exécution d'un script téléchargé"],
];

// En boucle seulement : la boucle intègre elle-même, sur la branche où elle a été lancée.
const LOOP_ONLY = [
  [/\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|tag|stash)\b/, "la boucle committe et pousse elle-même après ses contrôles"],
  [/\bgit\s+switch\b/, "un ticket se traite sur la branche où la boucle a été lancée"],
  [/\bgit\s+checkout\b(?!.*\s--\s)/, "un ticket se traite sur la branche où la boucle a été lancée"],
  [/(^|[;&|]\s*)(claude|codex)\s/, "une session de ticket ne lance pas d'autre session"],
  [/(^|[;&|]\s*)gh\s/, "aucune action GitHub depuis une session de ticket"],
];
// Installation ou retrait de dépendances, pour les gestionnaires courants. `yarn` seul installe.
const INSTALL = [
  /\b(npm|pnpm|bun)\s+(install|i|ci|add|uninstall|remove|rm|update|up)\b/,
  /\byarn\s+(add|remove|install|upgrade)\b/,
  /(^|[;&|]\s*)yarn\s*($|[;&|])/,
  /\b(pip3?|uv\s+pip)\s+(install|uninstall)\b/,
  /\b(uv|poetry)\s+(add|remove|install|sync|update|lock)\b/,
  /\bcargo\s+(add|remove|install|update)\b/,
  /\bgo\s+(get|install)\b/,
  /\bbundle\s+(add|install|update)\b/,
];

/** rm récursif visant la racine, le dossier personnel, le parent, le dépôt entier ou .git. */
function dangerousRemove(text) {
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "rm") continue;
    const rest = tokens.slice(i + 1);
    const recursive = rest.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive");
    const target = rest.some((t) => /^(\/|~\/?|\.\.?\/?|\*|\.git\/?)$/.test(t));
    if (recursive && target) return true;
  }
  return false;
}

if (dangerousRemove(command)) refuseOrAsk("Commande à risque : suppression récursive d'un dossier racine.");
for (const [pattern, why] of RISKY) if (pattern.test(command)) refuseOrAsk(`Commande à risque : ${why}.`);
if (loopMode) {
  for (const [pattern, why] of LOOP_ONLY) if (pattern.test(command)) decide("deny", `Refusé pendant un ticket : ${why}.`);
  if (INSTALL.some((pattern) => pattern.test(command)) && process.env.HARNESS_ALLOW_INSTALL !== "1")
    decide("deny", "Refusé pendant un ticket : ce ticket n'autorise pas l'installation de dépendances (champ « installe: oui »).");
}
