# Journal des versions

Ce que chaque version change pour un projet qui lance `node install.mjs <projet> --update`.

## 0.1.0 — 2026-10-14

Première version, extraite du harnais de TVLens (commit `49cfbb4` et ticket T153 en cours).

- Contrôle unique `scripts/check.mjs`, cliquet `scripts/quality/`, huit hooks, trois rôles, trois skills,
  boucle de tickets avec échelle de modèles, état relu vérifié par empreinte et rétrospective.
- Relecteur à deux lignes lues par la boucle : `VERDICT : …` et
  `CONSTATS : <n> bloquant, <n> mineur, <n> hors périmètre`. « accepté » exige zéro bloquant et zéro
  mineur ; les écarts aux critères se déclarent dans `.harness-state/tickets/<ID>/ecarts.md`.
- Rendu générique : `harness.config.mjs` porte les dossiers, les suites de tests, les mesures propres au
  projet, le nom et l'échelle de modèles ; variables d'environnement préfixées `HARNESS_` ; tests du
  harnais dans `tests/harness/`, lancés à part et hors des mesures du projet ; liste des fichiers
  protégés unique (`scripts/loop/harness-files.mjs`), étendue à `harness.config.mjs` et `tests/harness/`.
- Garde-fou d'installation étendu à pnpm, yarn, bun, pip, uv, poetry, cargo, go et bundle.
- Le format et le lint du projet ne jugent pas le noyau ; le contrôle et l'installeur exigent la racine
  d'un dépôt Git ; les dépôts jetables des tests ignorent la configuration Git de la machine.
- L'ouverture d'une session interactive annonce les propositions de la rétrospective en attente.
- `install.mjs` : installation, mise à jour par verrou d'empreintes, comparaison, remontée.
