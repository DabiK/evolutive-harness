// Modèle de chaque tentative d'un ticket : une échelle de paliers, un point de départ fixé par le niveau
// du ticket, un palier de plus à chaque tentative refusée. Aucun effet de bord.
// Le projet peut remplacer les échelles et les niveaux dans harness.config.mjs (`models.ladder`, `models.codexLadder`,
// `models.levels`).

/** Du moins cher au plus fort. `alias` est le nom qu'accepte le paramètre `model` d'un sous-agent. */
export const LADDER = [
  { model: "claude-sonnet-5-5", alias: "sonnet", effort: "high" },
  { model: "claude-opus-5-5", alias: "opus", effort: "high" },
  { model: "claude-opus-5-5", alias: "opus", effort: "xhigh" },
  { model: "claude-fable-5-1", alias: "fable", effort: "high" },
];

/** Échelle du moteur Codex, palier pour palier avec celle de Claude ; le relecteur reste Claude. */
export const CODEX_LADDER = [
  { model: "gpt-6.1-sol", effort: "high" },
  { model: "gpt-6.1-sol", effort: "xhigh" },
  { model: "gpt-6-astra", effort: "xhigh" },
  { model: "gpt-6-astra", effort: "max" },
];

/**
 * Niveau d'un ticket : palier de départ, et palier en dessous duquel le relecteur ne descend pas.
 * Le relecteur est le dernier filet avant les contrôles de la boucle : sauf sur un ticket simple, il
 * reste au moins sur le deuxième palier quand l'implémentation tourne sur le premier.
 */
export const LEVELS = {
  simple: { start: 0, reviewFloor: 0 },
  standard: { start: 0, reviewFloor: 1 },
  sensible: { start: 1, reviewFloor: 1 },
  critique: { start: 2, reviewFloor: 2 },
};

/** Échelles et niveaux du projet (`models` de harness.config.mjs), complétés par ceux d'ici. */
export function modelSettings(models = {}) {
  return {
    ladder: models.ladder?.length ? models.ladder : LADDER,
    codexLadder: models.codexLadder?.length ? models.codexLadder : CODEX_LADDER,
    levels: { ...LEVELS, ...models.levels },
  };
}

const DEFAULT_SETTINGS = modelSettings();

/** Niveau déclaré dans l'en-tête (`niveau:`), sinon déduit de ce que le ticket autorise. */
export function levelOf(ticket) {
  if (ticket.niveau) return ticket.niveau;
  if (ticket.harnais) return "critique";
  if (ticket.adr || ticket.supprimeTests || ticket.installe) return "sensible";
  return "standard";
}

const top = ({ ladder }) => ladder.length - 1;
const startOf = (level, settings) => Math.min(settings.levels[level].start, top(settings));

/** Palier de la tentative `attempt` (à partir de 1) : un de plus par tentative refusée, plafonné au dernier. */
export function rungFor(level, attempt, settings = DEFAULT_SETTINGS) {
  return Math.min(startOf(level, settings) + attempt - 1, top(settings));
}

/** Tentatives nécessaires pour monter du palier de départ jusqu'en haut de l'échelle. */
export function attemptsToTop(level, settings = DEFAULT_SETTINGS) {
  return settings.ladder.length - startOf(level, settings);
}

/** Ce que la session et son relecteur utilisent à ce palier. */
export function plan(level, attempt, settings = DEFAULT_SETTINGS, engine = "claude") {
  const rung = rungFor(level, attempt, settings);
  const review = settings.ladder[Math.min(Math.max(rung, settings.levels[level].reviewFloor), top(settings))];
  // Le relecteur reste sur l'échelle Claude ; seule l'implémentation change de moteur, au même palier ou au plus haut du sien.
  const own = engine === "codex" ? settings.codexLadder[Math.min(rung, settings.codexLadder.length - 1)] : settings.ladder[rung];
  return { rung, ...own, reviewModel: review.alias };
}

/**
 * « claude-opus-5-5 » → « Claude Opus 5.5 », « gpt-6.1-sol » → « Codex (GPT-6.1 Sol) ». Un nom qui ne suit aucun de ces
 * formats garde celui de son moteur.
 */
export function displayName(model, engine = "claude") {
  const gpt = /^gpt-([\d.]+)-([a-z]+)$/.exec(model || "");
  if (gpt) return `Codex (GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)})`;
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model || "");
  if (!match) return engine === "codex" ? "Codex" : "Claude";
  const [, family, major, minor] = match;
  return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}
