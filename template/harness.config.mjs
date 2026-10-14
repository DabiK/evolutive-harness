// Configuration du harnais pour ce projet. Lue par scripts/check.mjs, le cliquet et la boucle.
// Avec CLAUDE.md et docs/standards.md, c'est le seul fichier du harnais propre au projet : le reste (le noyau)
// se met à jour depuis evolutive-harness. Valeurs par défaut et rôle de chaque clé : scripts/quality/config.mjs.
export default {
  project: "MonProjet",

  // Dossiers du code de production : règles par fichier (catch vides) et mesures du cliquet.
  productionDirs: ["src"],
  testDir: "tests",

  // Suites de tests. En contrôle complet, `command` reçoit tous les fichiers de la suite ; avec --changed, ceux
  // qui sont modifiés. Les tests du harnais (tests/harness/) sont lancés à part par scripts/check.mjs.
  suites: [
    { name: "tests JS", command: ["node", "--test", "--test-concurrency=1"], files: /^tests\/(?!harness\/).*\.test\.(cjs|mjs|js)$/ },
    // { name: "tests Python", command: ["python3", "-B", "-m", "pytest", "-q"], files: /^tests\/test_.*\.py$/ },
  ],

  // Mesures propres au projet, ajoutées au cliquet : un motif compté dans le code de production.
  // `direction: "max"` ne peut que baisser, "min" ne peut que monter. `perFile` compte les fichiers plutôt que les
  // occurrences ; `except` liste les fichiers exclus.
  measures: {
    // inner_html: { pattern: /\.innerHTML\b/g, direction: "max" },
    // process_env_hors_config: { pattern: /\bprocess\.env\b/, perFile: true, except: ["src/config.js"], direction: "max" },
  },

  // Échelle de modèles de la boucle, du moins cher au plus fort, et modèle de la rétrospective.
  // Absente, celle de scripts/loop/models.mjs.
  // models: {
  //   ladder: [
  //     { model: "claude-sonnet-5-5", alias: "sonnet", effort: "high" },
  //     { model: "claude-opus-5-5", alias: "opus", effort: "high" },
  //   ],
  //   retro: "claude-sonnet-5-5",
  // },
};
