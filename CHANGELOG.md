# Journal des versions

Ce que chaque version change pour un projet qui lance `node install.mjs <projet> --update`.

## 0.2.0 — 2026-10-19

Rattrapage du harnais de TVLens jusqu'au commit `b893bae` (tickets T154 à T292 qui touchent au harnais),
rendu générique. Ce que `--update` apporte au projet :

- **Moteur Codex.** `node scripts/loop/run.mjs --engine codex` : Codex explore et implémente en suivant
  `.agents/skills/ticket-codex/SKILL.md`, puis la boucle fait relire l'état enregistré par un processus
  Claude séparé (`--agent relecteur`). Les hooks Claude servent aussi à Codex par `.codex/hooks.json` ; un
  témoin de démarrage prouve qu'ils ont tourné. Une correction reprend la session Codex
  (`codex exec resume`), avec repli sur une session neuve. Échelle Codex par défaut dans
  `scripts/loop/models.mjs`, remplaçable par `models.codexLadder` dans `harness.config.mjs`.
- **Capacité et quota Codex.** Un modèle saturé est repris dans la même session (trois fois, 15, 30 puis
  60 s). Un quota épuisé remet le ticket à faire, garde le travail et arrête la boucle (code 5) ; avec
  `--fallback-engine claude`, une seule relève Claude reprend le travail après vérification de l'état
  transmis (`scripts/loop/quota-handoff.mjs`).
- **Relectures de correction.** À partir de la deuxième relecture d'une tentative, le relecteur reçoit le
  rapport précédent et `revue-<n>.interdiff`, et rend `NON CORRIGÉS : <n>` ; un constat non corrigé
  refuse la tentative et fait monter d'un palier. Deux corrections au plus par tentative. Le rapport de
  chaque relecteur est gardé dans `relecture-<n>.md`.
- **Harmonisation des consignes.** `--tune-every <n>` : tous les n tickets intégrés, les problèmes qui
  reviennent dans les rétrospectives sont corrigés dans les skills et les agents par l'agent
  `harmoniseur` (skill `harmonisation`, `scripts/loop/tune.mjs`), relus, contrôlés et committés à part. La
  portée `HARNESS_EDIT_SCOPE=consignes` (`scripts/loop/harness-scopes.mjs`) ferme les contrôles et les
  arbitres. `retro.mjs` accepte les décisions `harmonisation:<commit>` et `differee:H<nnn>`.
- **Relève de la boucle.** `run.mjs` devient superviseur (`scripts/loop/restart.mjs`) : après un ticket qui
  modifie `scripts/loop/` ou `scripts/quality/`, le ticket suivant tourne dans un processus neuf, avec le
  code intégré. Le verrou garde l'heure du premier lancement.
- **Contrôle.** Gel du lint : toute hausse de `eslint-suppressions.json` par rapport à `HEAD` est refusée,
  même sans ESLint. Une mesure du plancher inconnue du noyau et de la configuration rend le cliquet rouge.
  Un échec de `node --test` garde chaque assertion en échec dans le rapport (120 lignes au plus). La boucle
  resserre le plancher par `ratchet.mjs --tighten` dans un processus neuf, avec les définitions de mesure
  présentes sur disque.
- **Garde-fous.** Les patchs Codex (`apply_patch`) sont lus chemin par chemin, déplacements compris ; le
  contrôle rapide passe sur chaque fichier de code d'un patch. Sont ajoutés au harnais protégé : `.codex/`,
  `.agents/`, `AGENTS.md` et les réglages du lint et du format (`eslint.config.*`, `.prettierrc`,
  `.prettierrc.json`, `.prettierignore`).
- **Variables d'environnement** nouvelles : `HARNESS_ENGINE`, `HARNESS_EDIT_SCOPE`, `HARNESS_HOOK_RUN`,
  `HARNESS_TUNE`, `HARNESS_CODEX_BIN`, `HARNESS_CODEX_SKIP_CAPACITY_WAIT`.
- **Installeur.** `AGENTS.md` devient un fichier du projet : un lien vers `CLAUDE.md`, ajouté s'il manque,
  jamais remplacé. Un lien du modèle est installé comme lien.

À faire à la main, car `--update` ne touche pas aux fichiers du projet :

1. Approuver les hooks Codex une fois par dépôt (et par worktree) : lancer `codex` à la racine, puis `/hooks`.
2. Dans `CLAUDE.md`, étape « Avant de modifier du code » : une session Codex suit
   `.agents/skills/ticket-codex/SKILL.md` (voir `template/CLAUDE.md`).
3. Dans `docs/standards.md`, reprendre si utile la section « Le gel du lint » et la règle des mesures
   inconnues du plancher (voir `template/docs/standards.md`).

Pas repris de TVLens : la vue de la boucle (moniteur du terminal `scripts/watch-loop.mjs`, vue web
`scripts/loop-web/` et leur noyau `scripts/loop-view/`), en attente d'une décision ; le compteur de cas de
test scindé en produit et harnais (T196), inutile ici puisque les tests du harnais sont hors des mesures du
projet ; les outils propres au produit (couverture, mesure de latence).

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
