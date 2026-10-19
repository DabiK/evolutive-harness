// Portées du harnais : ce qu'une session de la boucle peut modifier dans le harnais quand `HARNESS_EDIT_SCOPE` est
// fixé. Le hook guard-write le refuse pendant la session, la boucle le revérifie sur le diff après.
// Aucun import ni effet de bord : le hook importe ce module, et un hook qui plante laisse passer l'écriture.

/** Portée de l'harmonisation des consignes : les skills et les agents, jamais les contrôles. */
export const INSTRUCTIONS_SCOPE = "consignes";

const SCOPES = new Map([[INSTRUCTIONS_SCOPE, Object.freeze([".claude/skills/", ".claude/agents/", ".agents/skills/"])]]);

// Ce qu'une portée ferme dans les dossiers qu'elle ouvre. Le relecteur et la marche de l'harmonisation sont ses arbitres,
// comme les contrôles sont ceux d'un ticket : les modifier reste la décision du propriétaire. Une entrée finie par « / »
// ferme un dossier, sinon un fichier exact.
const CLOSED = new Map([
  [INSTRUCTIONS_SCOPE, Object.freeze([".claude/agents/relecteur.md", ".claude/agents/harmoniseur.md", ".claude/skills/harmonisation/"])],
]);

/** Dossiers que la portée ouvre dans le harnais ; null pour une portée inconnue, qui n'ouvre rien. */
export function scopeDirs(scope) {
  return SCOPES.get(scope) ?? null;
}

const closedBy = (scope) => CLOSED.get(scope) ?? [];
const matches = (entry, file) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry);

/** Vrai si le chemin (relatif au projet, avec des « / ») est dans un dossier que la portée ouvre, hors de ce qu'elle ferme. */
export function inScope(scope, file) {
  const open = (scopeDirs(scope) ?? []).some((dir) => file.startsWith(dir));
  return open && !closedBy(scope).some((entry) => matches(entry, file));
}

/** Ligne qui nomme ce que la portée ferme, pour les messages de refus du hook et de la boucle ; vide si elle ne ferme rien. */
export function closedLine(scope) {
  const closed = closedBy(scope);
  return closed.length ? `La portée « ${scope} » exclut ${closed.join(", ")} : ils restent la décision du propriétaire.` : "";
}
