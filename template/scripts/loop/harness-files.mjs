// Les fichiers du harnais, en deux listes. Une seule source pour le hook guard-write, la boucle, le contrôle
// qualité et l'installeur d'evolutive-harness.

/** Ce qui définit les règles : intouchable par un ticket, sauf s'il porte « harnais: oui ». */
export const PROTECTED = [
  ".claude/",
  ".codex/",
  ".agents/",
  "scripts/check.mjs",
  "scripts/quality/",
  "scripts/loop/",
  "tests/harness/",
  "harness.config.mjs",
  "CLAUDE.md",
  "AGENTS.md",
  "docs/standards.md",
  // Les réglages du lint et du format : les relâcher ferait passer un contrôle rouge sans corriger le code.
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.cjs",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierignore",
];

/**
 * Le noyau : ce qu'evolutive-harness installe et met à jour à l'identique dans chaque projet. Son style est tenu
 * dans evolutive-harness ; le format et le lint du projet ne le jugent pas.
 */
export const CORE = [
  ".claude/hooks/",
  ".claude/agents/",
  ".claude/skills/",
  ".codex/hooks.json",
  ".agents/skills/",
  "scripts/check.mjs",
  "scripts/quality/config.mjs",
  "scripts/quality/metrics.mjs",
  "scripts/quality/ratchet.mjs",
  "scripts/loop/",
  "tests/harness/",
  "docs/travail/README.md",
  "docs/travail/tickets/_gabarit.md",
  "docs/adr/0000-gabarit.md",
];

const listed = (list, file) => list.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

/** Vrai si le chemin (relatif au projet, avec des « / ») appartient au harnais. */
export const isHarnessFile = (file) => listed(PROTECTED, file);

/** Vrai si le chemin appartient au noyau installé par evolutive-harness. */
export const isCoreFile = (file) => listed(CORE, file);
