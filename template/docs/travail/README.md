# Travailler par tickets avec la boucle

La boucle traite les tickets de `docs/travail/tickets/` un par un. Pour chaque ticket elle lance une
session d'agent fraîche (Claude par défaut), puis relance elle-même tous les contrôles avant de committer et de pousser.
La session propose ; le script décide.

Ce dossier contient :

| Quoi | Où |
| --- | --- |
| Les tickets, un fichier chacun, numérotés dans l'ordre d'exécution | `tickets/NNN-<sujet>.md` |
| Le modèle d'un ticket | `tickets/_gabarit.md` |

Les sources qui justifient chaque ticket (audit, spécification, décision) sont citées dans le ticket.

## Avant de lancer

- Être sur une branche de travail, jamais `main`.
- N'avoir aucun fichier suivi modifié : `git status` propre, fichiers non suivis mis à part.
- Avoir relu et committé les tickets. Un ticket est un contrat : la boucle refuse une session qui en
  modifie les critères, et elle refuse un ticket que Git ne suit pas.
- Avoir relu en priorité les tickets qui installent une dépendance, touchent au harnais, suppriment des
  tests ou demandent un ADR, et tranché ceux qui attendent une décision (« Trancher un ticket qui attend
  une décision », plus bas).
- Ne rien écrire d'autre dans le dépôt pendant que la boucle tourne : tout fichier apparu pendant un
  ticket part dans le commit de ce ticket.
- Machine branchée, sans mise en veille. Une session de ticket lance des sous-agents et tous les tests :
  pas d'autre agent ni de navigateur lourd à côté.

## Lancer

```sh
node scripts/loop/run.mjs --dry-run       # dit quel ticket partirait, sur quel modèle, sans rien lancer
node scripts/loop/run.mjs                 # le prochain ticket prêt, puis s'arrête
node scripts/loop/run.mjs --max 5
node scripts/loop/run.mjs --ticket T012
```

| Option | Défaut | Rôle |
| --- | --- | --- |
| `--max <n>` | 1 | nombre de tickets à enchaîner |
| `--engine claude\|codex\|opencode` | `claude` | moteur de l'exploration et de l'implémentation ; relecteur Claude |
| `--fallback-engine claude` | aucun | avec `--engine codex` : une relève Claude après un quota Codex (plus bas) |
| `--ticket <id>` | prochain prêt | traiter ce ticket précisément |
| `--attempts <n>` | jusqu'en haut de l'échelle | sessions fraîches par ticket avant de le bloquer (3 avec `--model`) |
| `--model <m>` | l'échelle | fige le modèle de toutes les tentatives, sans escalade |
| `--effort <e>` | celui du palier | remplace l'effort de chaque palier |
| `--no-retro` | rétrospective | ne pas lancer la rétrospective après le ticket |
| `--tune-every <n>` | 0 (jamais) | harmoniser les consignes du harnais tous les n tickets intégrés (plus bas) |
| `--timeout-min <n>` | 120 | durée maximale d'une session |
| `--compact-window <n>` | 200000 | plafond de contexte d'une session, en tokens ; 0 pour ne pas le fixer |
| `--budget-usd <n>` | aucun | plafond de dépense d'une session |
| `--no-push` | pousse | committer sans pousser |
| `--permission-mode <m>` | `auto` | mode de permission des sessions |

Le prochain ticket prêt est le premier, dans l'ordre des numéros, dont le statut est `a-faire`, dont
tous les bloqueurs (`bloque_par`) sont `termine`, et qui n'attend aucune décision. Un ticket `en-cours`
ou `bloque` arrête la file : il attend une décision.

La boucle lit l'en-tête d'un ticket et le début de sa section « Hypothèses bloquantes ». Un ticket dont
la section commence par « Décision attendue du propriétaire : » n'est jamais lancé : il reste `a-faire`,
et ceux qui en dépendent attendent avec lui. La boucle continue avec les tickets prêts qui n'en dépendent
pas, et nomme une fois, au premier ticket choisi, ceux qui attendent une décision (`--dry-run` compris).
Quand plus rien n'est prêt, la raison d'arrêt les nomme et la boucle s'arrête (code 0).
`--ticket` sur un tel ticket est refusé avant toute session, avec la question (code 1). Pour trancher :
« Trancher un ticket qui attend une décision », plus bas.

Pendant la session, la boucle affiche une ligne par outil appelé, avec le temps écoulé :
`[boucle] 03:12  Read src/session.js`. Les lignes plus en retrait viennent d'un sous-agent.

Ordre de grandeur, mesuré sur Opus dans le premier projet qui a porté ce harnais : un petit ticket
(quelques lignes dans un test) prend une trentaine de tours, 15 à 20 minutes et 3 à 4 $ ; un ticket qui
modifie la boucle et ses tests, autour de 7 $. Commencer par `--max 1`, lire le résultat, puis monter.

### Moteur Codex

```sh
node scripts/loop/run.mjs --engine codex --dry-run
node scripts/loop/run.mjs --engine codex --no-push --max 1
```

Codex suit `.agents/skills/ticket-codex/SKILL.md` : il explore et implémente lui-même, tests d'abord,
déclare les écarts avant de coder, tient le journal et écrit son verdict. `AGENTS.md` est un lien vers
`CLAUDE.md`. La boucle enregistre ensuite l'état relu et lance un processus Claude séparé avec
`--agent relecteur`, au modèle Claude du palier (au moins le deuxième palier pour un ticket standard).
Elle garde le rapport dans `relecture-<n>.md` et le verdict dans `relectures.jsonl`.
Quand la dernière relecture accepte, ses constats hors périmètre et ses écarts acceptés s'ajoutent
aux réserves de la session. Chaque réserve cite ce rapport ; la boucle les reporte dans « Réserves
à la clôture » du journal et les compte dans le message du commit. Les rapports précédents ne sont
pas repris et le verdict de Codex reste inchangé.
Si le nombre de constats extraits diffère du nombre annoncé par `CONSTATS`, une réserve de repli
remplace cette extraction : elle indique les deux nombres et renvoie au rapport complet. Les écarts
acceptés restent des réserves distinctes.

Seul un verdict TERMINÉ déclenche la relecture. Un BLOQUÉ arrête la boucle immédiatement avec sa
raison, y compris après une correction. Un verdict absent, illisible ou PARTIEL refuse la tentative
sans relecture ; la tentative suivante peut reprendre le travail à partir du rapport d'échec.
Le relecteur tourne hors mode ticket : les hooks ne lui demandent pas de corriger ni d'écrire le verdict.

Une relecture « à corriger » ou « illisible » reprend la session de la tentative par
`codex exec resume <thread_id>`, avec les réglages du palier et un nouveau témoin de hooks vérifié.
Sa consigne nomme le ticket, le chemin du rapport `relecture-<n>.md` et transmet son contenu complet.
La session conserve son contexte et corrige le travail présent dans l'arbre. Si les options requises
ne sont pas acceptées, si le témoin manque ou si la reprise échoue avant tout tour, la boucle lance
une session neuve pour la même correction. L'événement `reprise-impossible` en donne la raison.
Ce repli relit les consignes et vérifie aussi son témoin. Deux corrections au plus par tentative,
puis refus et escalade ; chaque tentative sur un nouveau palier démarre dans une session neuve.
Les contrôles de la boucle restent communs ; la rétrospective et l'harmonisation restent sur Claude.
Le verdict appartient à la session, la boucle ne le réécrit pas.

Pour les deux moteurs, la première relecture de chaque tentative reste complète. Chaque relecture
suivante est une relecture de correction par un relecteur neuf : il reçoit le rapport précédent
`relecture-<n>.md` et `revue-<n>.interdiff`, le diff exact entre les deux états relus. L'enregistrement
conserve un arbre Git incluant les nouveaux fichiers du ticket, sans toucher à l'index réel ni à
l'arbre de travail. Le relecteur vérifie chaque ancien constat bloquant ou mineur, cherche les
régressions dans le code changé et classe les nouveaux mineurs sur du code inchangé en réserves
hors périmètre. Un nouveau bloquant reste possible partout.

Le rapport de correction ajoute `NON CORRIGÉS : <n>` juste après `CONSTATS : …` ; une relecture
complète n'a pas cette ligne. Un constat non corrigé refuse la tentative immédiatement, en nommant
le rapport : la boucle passe au palier suivant sans redemander la même correction au même modèle.
Une ligne absente ou illisible vaut un constat non corrigé. Dans le flux Claude, l'orchestrateur
rend alors PARTIEL et met le constat et le chemin du rapport dans `reste`. Même avec tous les anciens
constats corrigés, deux corrections refusées épuisent la tentative.

| Palier | Modèle Codex | Effort |
| --- | --- | --- |
| 0 | `gpt-6.1-sol` | high |
| 1 | `gpt-6.1-sol` | xhigh |
| 2 | `gpt-6-astra` | xhigh |
| 3 | `gpt-6-astra` | max |

C'est l'échelle par défaut de `scripts/loop/models.mjs` ; le projet la remplace dans `harness.config.mjs`
(`models.codexLadder`). Une échelle Codex plus courte que celle de Claude reste sur son dernier palier.
Le niveau fixe le départ comme pour Claude : un ticket `sensible` démarre donc sur Sol 6.1 xhigh.
`--model` et `--effort` remplacent ces réglages ; le
relecteur reste Claude. `--dry-run` affiche le moteur et les paliers prévus. Toute valeur de moteur
autre que `claude` ou `codex` est refusée au démarrage. Les binaires se remplacent pour les tests
par `HARNESS_CODEX_BIN` et `HARNESS_CLAUDE_BIN`.

La boucle lance `codex exec --json` avec stdin ignoré et impose `workspace-write`,
`approval_policy="never"`, `sandbox_workspace_write.network_access=true` et
`--dangerously-bypass-hook-trust`. Elle passe `HARNESS_ENGINE=codex` et la confiance du projet avec
`-c 'projects."<racine>".trust_level="trusted"'`. La config utilisateur reste chargée, car elle contient
l'approbation des hooks ; `--ignore-user-config` empêcherait leur chargement.

Ses autres apports sont neutralisés par `--disable plugins`, `--disable apps`, `--disable memories`,
`--disable image_generation` et `-c 'notify=[]'`. Avant chaque session, le même binaire
(`HARNESS_CODEX_BIN`) exécute `codex mcp list --json` avec ces mêmes `--disable`. La boucle ajoute
`-c mcp_servers.<nom>.enabled=false` pour chaque serveur actif, sans toucher aux serveurs inactifs.
Une liste en échec ou illisible refuse la session avant tout `exec` ; la raison nomme la liste des
serveurs MCP. Le constructeur exporté des arguments est partagé avec la preuve réelle.
Une session neuve reçoit `-s workspace-write` et `-C <racine>`. Une reprise part de la racine et reçoit
`-c 'sandbox_mode="workspace-write"'`, car `exec resume` n'accepte ni `-s` ni `-C`.
Pour un ticket `harnais: oui`, elle reçoit aussi `--add-dir <racine>/.codex` et
`--add-dir <racine>/.agents` : ces dossiers sont inscriptibles, sous le contrôle des gardes du projet.
Un autre ticket ne reçoit aucun `--add-dir`.
Avant chaque reprise, la boucle vérifie par l'aide du binaire que `exec resume` accepte les
`--disable` imposés et, pour un ticket de harnais, les `--add-dir`. Un refus entraîne le repli sur
une session neuve, avec toutes ces options conservées.
`--timeout-min` borne chaque processus.
`--budget-usd`, `--permission-mode` et `--compact-window` concernent les sessions Claude ; ils ne
remplacent pas les réglages imposés à Codex.

Le flux de chaque session, corrections comprises, s'ajoute au même
`.harness-state/tickets/<ID>/codex-<tentative>.jsonl`.
Les événements enregistrent le moteur, les jetons cumulés par catégorie, les tours, la durée mesurée
et le nombre de relectures. Le coût en dollars reste `null`, car le flux Codex ne le donne pas.
Une erreur du flux ou un processus Codex en échec refuse la tentative, même avec un verdict TERMINÉ,
sauf le repli technique d'une reprise décrit plus haut.

Les six hooks de `.codex/hooks.json` partagent les scripts Claude, avec résolution de la racine par Git :
contexte au démarrage, gardes avant commande et écriture, contrôle rapide après édition, trace des
compactions et porte de fin de tour. Les hooks de sous-agents ne concernent pas cette session Codex.
Un patch est refusé si un seul de ses chemins est interdit, déplacement compris ; chaque fichier
de code encore présent est contrôlé après édition. Le contexte de démarrage indique la skill Codex.
Le contexte et le refus de fin sans verdict choisissent la skill Codex avec `HARNESS_ENGINE=codex`
ou en l'absence de `CLAUDE_PROJECT_DIR`, y compris en interactif ; sinon ils nomment la skill `ticket`.

Le propriétaire approuve les hooks dans `codex`, puis `/hooks`. Cette approbation vit dans sa config
utilisateur et porte sur le chemin absolu de `.codex/hooks.json` : la boucle Codex tourne seulement
dans le dépôt approuvé. Un worktree ou une copie demande sa propre approbation. `hooks.json` reste
figé : modifier un script appelé conserve l'approbation ; changer la définition d'un hook demande
une nouvelle approbation avec `/hooks`.

Avant chaque processus, corrections comprises, la boucle renouvelle `HARNESS_HOOK_RUN` et retire l'ancien
témoin `.harness-state/tickets/<ID>/hooks-started.json`. `session-context.mjs` écrit l'identifiant du
lancement et celui de la session dans ce témoin. Après le processus et avant toute relecture, la boucle
vérifie les deux, ainsi que la conservation du `thread_id` sur une reprise. Si la session change,
la boucle se replie sur une session neuve ; la raison nomme l'identifiant attendu et celui reçu.
Un témoin absent, illisible ou périmé déclenche le repli si c'est une reprise ; sur une session neuve, la tentative
est refusée avec « hooks Codex non chargés », même si la session a rendu TERMINÉ. Ce refus indique les causes probables : hooks de
`.codex/hooks.json` non approuvés pour ce dépôt ou session hors du dépôt approuvé. Le propriétaire
les approuve avec `codex`, puis `/hooks`. La confiance seule ne constitue donc pas une preuve.

Un hook Codex en erreur laisse passer l'appel : les contrôles de la boucle restent le dernier mur.
Le bac à sable interdit l'écriture dans `.git`. Sans ticket de harnais, `.codex` et `.agents` restent
aussi en lecture seule.

### Capacité et quota Codex

Un refus « Selected model is at capacity » reprend la même session Codex, trois fois au plus, après 15,
30 puis 60 secondes, dans l'échéance de `--timeout-min` ; l'événement `capacite-reprise` le trace, et
`capacite-epuisee` dit pourquoi les reprises s'arrêtent. `HARNESS_CODEX_SKIP_CAPACITY_WAIT=1` supprime
l'attente, pour les tests.

Un quota épuisé (« You've hit your usage limit ») ne consomme pas de tentative : le ticket repasse à
`a-faire`, le travail reste dans l'arbre, l'événement `quota-epuise` porte la date de reprise annoncée
quand le fournisseur la donne, et la boucle s'arrête avec le code 5. Avec
`--engine codex --fallback-engine claude`, elle demande à la place une seule relève : elle capture l'état
du travail (diff, index, statuts et empreintes, journal des relectures) dans le dossier du ticket, puis
une session Claude reprend ce travail au palier Claude de la tentative en cours. `--model` et `--effort`
du lancement Codex ne la suivent pas ; la suite du lancement reste sur Claude. Le successeur vérifie
l'état transmis avant de partir : un changement, une absence ou une seconde consommation refuse la
reprise sans toucher au travail. Une nouvelle relecture après le quota et tous les contrôles habituels
conditionnent l'intégration.

### Moteur OpenCode

```sh
node scripts/loop/run.mjs --engine opencode --dry-run
node scripts/loop/run.mjs --engine opencode --no-push --max 1
```

OpenCode (version 2, CLI `opencode`) suit `.agents/skills/ticket-opencode/SKILL.md` : comme Codex, il
explore et implémente lui-même, tests d'abord, déclare ses écarts, tient le journal et écrit son
verdict ; la boucle enregistre l'état relu, le fait relire par un processus Claude séparé
(`--agent relecteur`, au modèle Claude du palier) et applique les mêmes contrôles, réserves et
relectures de correction que pour Codex. La rétrospective et l'harmonisation restent sur Claude.

| Palier | Modèle OpenCode | Variante |
| --- | --- | --- |
| 0 | `opencode-go/deepseek-v4.1-flash` | high |
| 1 | `opencode-go/deepseek-v4.1-flash` | max |
| 2 | `opencode-go/deepseek-v4-pro` | high |
| 3 | `opencode-go/deepseek-v4-pro` | max |

C'est l'échelle par défaut de `scripts/loop/models.mjs` ; le projet la remplace dans
`harness.config.mjs` (`models.opencodeLadder`). `model` est un identifiant que liste `opencode models`
(`fournisseur/modèle`), `effort` sa variante : la boucle passe `-m <model>#<effort>`. `--model` et
`--effort` les remplacent, le relecteur reste Claude. Les identifiants du fournisseur se règlent une
fois, hors de la boucle : `opencode auth login`, puis `opencode auth list` pour vérifier.

Chaque tentative est une session lancée par
`opencode run --standalone --format json --agent ticket-opencode --title "<projet> <ID> tentative <n>" -m …`.
`--standalone` donne à la session un serveur privé, enfant de la boucle, qui hérite de ses variables
`HARNESS_*` : le serveur d'arrière-plan partagé d'OpenCode ne les verrait pas. La consigne passe par
l'entrée standard, aussitôt fermée : `opencode run` lit son entrée tant qu'elle n'est pas un terminal,
et une entrée restée ouverte le laisse attendre sans fin. `OPENCODE_CONFIG_DIR` pointe vers un dossier
vide (`.harness-state/opencode/config`) : ni serveurs MCP, ni plugins, ni agents, ni `AGENTS.md` de la
configuration personnelle ; les identifiants, rangés dans le dossier de données d'OpenCode, restent
disponibles. Un fournisseur déclaré seulement dans la configuration personnelle se redéclare dans
`.opencode/opencode.jsonc` du projet.

L'agent `.opencode/agents/ticket-opencode.md` autorise tout sauf les sous-agents (`subagent`), les
questions (`question`) et le mode code (`execute`, qui ferait passer les outils par un script) ; il garde
l'invite système d'OpenCode. Les skills de `.claude/skills/` et `.agents/skills/` lui sont visibles,
comme `AGENTS.md`, lien vers `CLAUDE.md`.

Le plugin `.opencode/plugins/harness.js` branche les scripts de `.claude/hooks/` sur la session, comme
`.codex/hooks.json` pour Codex. Avant `write`, `edit`, `patch` et `shell`, il lance `guard-write` ou
`guard-bash` avec l'entrée de Claude Code ; un refus passe par l'évaluation des permissions d'OpenCode
(même identifiant d'appel) et arrive au modèle comme une erreur de l'outil, avec sa raison. Après une
édition, `after-edit` ajoute au résultat de l'outil un contrôle rapide en échec. Au premier message de
chaque session, `session-context` ajoute le contexte du dépôt à la consigne et écrit le témoin
`hooks-started.json` (session et `HARNESS_HOOK_RUN` de l'invocation). Une compaction passe par
`record-compaction`. Un garde-fou qui ne peut pas tourner refuse l'appel en boucle et le soumet à la
personne présente en interactif. Sans témoin valide après une invocation, la tentative est refusée
avec « plugin OpenCode non chargé ».

OpenCode n'a pas de fin de tour bloquante : après chaque invocation, la boucle lance elle-même
`.claude/hooks/stop-gate.mjs`. Sans verdict, ou sur un verdict TERMINÉ au contrôle rouge, elle reprend
la session (`--session <id>`) avec la raison, deux fois au plus par session. Une relecture « à
corriger » reprend aussi la session, avec le rapport ; une reprise qui échoue avant tout travail se
replie sur une session neuve (`reprise-impossible`). Une erreur du flux ou un processus en échec refuse
la tentative.

Le flux de la tentative, reprises comprises, s'ajoute à `.harness-state/tickets/<ID>/opencode-<n>.jsonl`.
La dernière étape d'une session n'y porte pas de coût : le coût et les jetons de l'événement
`session-terminee` viennent de `opencode session export <id> --standalone`, session par session.
Un export manquant laisse le coût à `null` plutôt que de le sous-estimer. Le quota et la saturation
d'un fournisseur OpenCode ne sont pas reconnus à part : ils refusent la tentative comme une autre
erreur. `--fallback-engine` reste propre à Codex. Le commit est signé
`Co-Authored-By: OpenCode (<modèle>) <noreply@opencode.ai>`. `HARNESS_OPENCODE_BIN` remplace le CLI pour
les tests.

En interactif, OpenCode charge le même plugin depuis son serveur d'arrière-plan : les écritures du
harnais et les commandes à risque y demandent confirmation, comme avec Claude. Les sessions de la
boucle restent dans la base d'OpenCode (`opencode session list` dans le projet), sous leur titre.

Ordre de grandeur, mesuré le 19 octobre 2026 sur OpenCode 2.0.22 : un ticket minuscule (une fonction et
ses deux tests) a pris 20 étapes de DeepSeek V4.1 Flash (variante high), 8 minutes dont la plupart pour
le contrôle complet, et 0,01 $ côté OpenCode ; la relecture Opus s'y ajoute et n'est pas comptée.

### Relève après intégration de la boucle elle-même

`run.mjs` confie le travail à un processus enfant et reste superviseur : il garde la commande, ses
sorties et le verrou, et ne traite aucun ticket. Quand un ticket intégré a modifié un module `.mjs` ou
`.cjs` de `scripts/loop/` ou `scripts/quality/` et qu'il reste des tickets à traiter, l'enfant rend la
main et le superviseur en lance un neuf : le ticket suivant tourne avec le code qui vient d'être intégré.
Le verrou passe d'un processus à l'autre sans disparaître et garde l'heure du premier lancement ;
`--max`, `--tune-every` et leurs compteurs, les options et les fichiers non suivis du départ sont
conservés. Une relève qui échoue est journalisée (`relance-echouee`) et arrête la commande.

### Modèle de chaque tentative Claude

Chaque tentative tourne sur un palier d'une échelle, du moins cher au plus fort. L'échelle par défaut
est dans `scripts/loop/models.mjs` ; le projet la remplace dans `harness.config.mjs` (`models.ladder`,
et `models.levels` pour les niveaux) :

| Palier | Modèle | Effort |
| --- | --- | --- |
| 0 | Sonnet 5.5 | high |
| 1 | Opus 5.5 | high |
| 2 | Opus 5.5 | xhigh |
| 3 | Fable 5.1 | high |

Le niveau du ticket fixe le palier de départ et le palier en dessous duquel le relecteur ne descend
pas. Une tentative refusée fait monter d'un palier ; par défaut la boucle tente jusqu'en haut.

| Niveau | Départ | Relecteur au moins | Par défaut pour |
| --- | --- | --- | --- |
| `simple` | 0 | 0 | — (à déclarer) |
| `standard` | 0 | 1 | tout ticket sans autre marque |
| `sensible` | 1 | 1 | `adr`, `supprime_tests` ou `installe` à `oui` |
| `critique` | 2 | 2 | `harnais: oui` |

Le champ `niveau:` de l'en-tête remplace le niveau déduit. Le modèle du relecteur est imposé par le
hook `guard-agent`, à partir de `HARNESS_REVIEW_MODEL` ; les autres sous-agents héritent du modèle de la
session. Le commit est signé du modèle de la tentative qui a abouti.

## Ce que fait la boucle pour un ticket

1. Elle passe le ticket à `en-cours` et lance `claude -p` avec la consigne de suivre la skill `ticket`.
2. La session explore (sous-agent `explorateur`), implémente (`implementeur`), fait relire
   (`relecteur`) après avoir enregistré l'état relu (`node scripts/loop/reviewed-state.mjs record`),
   corrige au besoin, puis écrit son verdict dans
   `.harness-state/tickets/<ID>/verdict.json`. Les sous-agents tournent au premier plan : le hook
   `guard-agent` corrige tout lancement en arrière-plan, qui ferait finir la session avant leur
   rapport. Le hook `record-review` enregistre le verdict de chaque relecteur dans `relectures.jsonl`,
   et son rapport dans `relecture-<n>.md`.
3. Si le verdict est TERMINÉ, la boucle vérifie elle-même :
   - le ticket n'a pas changé au-dessus de son journal ;
   - `untracked-before.json` contient toujours la liste des fichiers non suivis gardée en mémoire
     au démarrage ; un ajout, un retrait, une suppression ou une liste illisible refuse la tentative,
     pour Claude comme pour Codex, même si le relecteur a accepté ;
   - le harnais n'a pas été touché, sauf ticket marqué `harnais: oui` ;
   - aucun fichier de test n'a été supprimé, sauf ticket marqué `supprime_tests: oui` ;
   - un ADR a été ajouté si le ticket porte `adr: oui` ;
   - une relecture est enregistrée, et l'état final du dépôt est celui que le dernier relecteur a lu,
     journal du ticket et fichiers non suivis d'avant la session mis à part ;
   - le dernier relecteur a rendu « accepté », sur cette même revue ;
   - `node scripts/check.mjs` est vert en entier.
4. Tout est bon : elle resserre le cliquet, passe le ticket à `termine`, committe
   (`<ID>: <titre>`) et pousse. Elle affiche le coût total du ticket et les réserves (`reste`) du verdict.
5. Sinon : elle écrit la raison du refus et lance une nouvelle session fraîche, un palier plus haut, qui
   reprend à partir du journal et du rapport d'échec. Après le nombre de tentatives prévu, le ticket
   passe à `bloque`.
6. Intégré ou bloqué, elle lance la rétrospective du ticket (plus bas), puis s'arrête si le ticket est
   bloqué ou le push refusé.
7. Avec `--tune-every N`, tous les N tickets intégrés, elle harmonise les consignes du harnais (plus
   bas) avant le ticket suivant.

Codes de sortie : 0 terminé, 1 refus au démarrage, 2 ticket bloqué, 3 commit fait mais push refusé,
4 harmonisation refusée que la boucle n'a pas pu défaire, 5 quota Codex épuisé (ticket remis à faire,
travail conservé).

## Lire un échec

La dernière ligne de la boucle dit dans quel cas on est.

| La boucle affiche | Ce que ça veut dire | Où regarder |
| --- | --- | --- |
| un refus avant toute session (code 1) | branche `main`, fichier suivi modifié, file invalide, ticket non suivi par Git, ou ticket demandé par `--ticket` qui ne peut pas partir (inconnu, pas prêt, en attente d'une décision, ou file arrêtée par un autre ticket `en-cours` ou `bloque`) | le message lui-même ; corriger puis relancer |
| `Tentative n refusée : …` | la session n'a pas rendu de verdict, s'est dite PARTIELLE, ou s'est dite TERMINÉE alors qu'un contrôle refuse | `.harness-state/tickets/<ID>/echec-<n>.txt` |
| `<ID> est bloqué : …` (code 2) | la session s'est dite BLOQUÉE, ou toutes les tentatives ont été refusées | la raison affichée, puis le journal du ticket |
| `Le commit est fait mais le push a échoué` (code 3) | le ticket est intégré en local, rien d'autre n'est lancé | `git status`, puis `git push` à la main |
| `Harmonisation <ID> refusée …` | l'harmonisation est annulée : fichiers suivis remis à `HEAD`, fichiers nouveaux mis de côté ; la file continue | `.harness-state/tickets/<ID>/refus.txt`, et `mis-de-cote/` pour un fichier à récupérer |
| `… sa remise à HEAD est incomplète …` (code 4) | refus non défait ; aucun ticket lancé | fichiers listés, `git status`, `.git/index.lock`, `refus.txt` |

Le rapport `echec-<n>.txt` commence par la raison, puis donne la sortie du contrôle qui a refusé.
Les raisons possibles : « sans verdict », « PARTIELLE » avec ce qui reste, « Le ticket a été modifié
au-dessus de son journal », « Le harnais a été modifié sans que le ticket l'autorise », « Des fichiers
de test ont été supprimés », « Le ticket demande un ADR et aucun n'a été ajouté », « Aucune relecture
n'est enregistrée », « Aucune relecture lisible n'est enregistrée » (`reviewed-state.json` abîmé),
« La liste des fichiers non suivis d'avant la session est perdue » (`untracked-before.json`, écrit par
la boucle, abîmé), « Le changement a été modifié depuis la dernière relecture » suivi des fichiers
concernés, « Aucun verdict de relecteur n'est enregistré », « Le dernier verdict porte sur revue-<n>,
pas sur la dernière revue enregistrée », « Le dernier relecteur n'a pas accepté », « Le contrôle
qualité complet est rouge » suivi de la sortie de `scripts/check.mjs`.

Pour aller plus loin :

| Où | Quoi |
| --- | --- |
| Le journal du ticket (section `## Journal`) | les jalons écrits par la session, avec commandes et sorties |
| `.harness-state/loop/events.jsonl` | une ligne par événement, avec la charge de la machine : session lancée (niveau, modèle, effort, palier, relecteur), session terminée (tours, durée, coût, coût par modèle, sous-agents, refus de permission, compactions), refus, intégration et blocage (tentatives, coût total), rétrospective, harmonisation (lancée : identifiant, sujets, observations ; puis intégrée avec son commit, les observations traitées et, s'il a échoué, la raison du marquage manqué, refusée avec sa raison et les fichiers mis de côté, ou sans changement ; sautée, avec la raison, quand le journal des retours est illisible ; non défaite, avec les fichiers restants, les commandes Git en échec et les fichiers déjà mis de côté, quand la remise à `HEAD` est incomplète) |
| `.harness-state/tickets/<ID>/verdict.json` | le verdict de la dernière session, ses preuves et ses réserves (`reste`) |
| `.harness-state/tickets/<ID>/session-<n>.json` | le compte rendu final de la session (tours, durée, coût) |
| `.harness-state/tickets/<ID>/session-<n>.jsonl` | le flux entier de la session, message par message |
| `.harness-state/tickets/<ID>/codex-<n>.jsonl` | le flux Codex de la tentative, corrections comprises, cité par sa rétrospective |
| `.harness-state/tickets/<ID>/opencode-<n>.jsonl` | le flux OpenCode de la tentative, reprises comprises, cité par sa rétrospective |
| `.harness-state/tickets/<ID>/untracked-before.json` | la liste initiale des non suivis, que les contrôles comparent à la référence en mémoire |
| `.harness-state/tickets/<ID>/exploration.md` | le rapport d'exploration |
| `.harness-state/tickets/<ID>/ecarts.md` | les écarts aux critères déclarés avant l'implémentation et les constats contestés, que le relecteur tranche |
| `.harness-state/tickets/<ID>/revue-<n>.diff`, `revue-<n>.fichiers` | chaque relecture : le diff relu, fichiers nouveaux en entier, et la liste des fichiers |
| `.harness-state/tickets/<ID>/revue-<n>.interdiff` | le diff entre deux états relus successifs, si l'arbre précédent est encore utilisable |
| `.harness-state/tickets/<ID>/reviewed-state.json` | l'état de la dernière relecture, avec son arbre Git ; la boucle le compare à l'état final |
| `.harness-state/tickets/<ID>/relectures.jsonl` | le verdict de chaque relecteur, la revue qu'il a lue et son modèle |
| `.harness-state/tickets/<ID>/relecture-<n>.md` | le rapport du relecteur dont le verdict est la ligne `n` de `relectures.jsonl`, pour un ticket comme pour une harmonisation |
| `.harness-state/tickets/<ID>/retro-entree.md`, `retro.json` | ce que la rétrospective a reçu, et ce qu'elle a rendu |
| `.harness-state/tickets/H<nnn>/observations.json`, `refus.txt` | pour une harmonisation : les observations retenues par la boucle, et la raison d'un refus, que lit l'harmonisation suivante |
| `.harness-state/tickets/H<nnn>/mis-de-cote/` | pour une harmonisation refusée : les fichiers nouveaux apparus pendant la session, sous leur chemin, à récupérer à la main s'ils n'en venaient pas |

Un verdict TERMINÉ peut garder des réserves dans `reste` : un constat de relecture hors périmètre, un
écart à un critère accepté par le relecteur, ce qui n'a pas pu être vérifié, ou une question pour le
propriétaire. La boucle intègre et les affiche.
Avec Codex et OpenCode, elle y ajoute les réserves de la dernière relecture acceptée, chacune avec le
chemin du rapport conservé.

## Rétrospective

Après chaque ticket, intégré ou bloqué, une courte session Sonnet en lecture seule relit ce que la
boucle a observé (tentatives, modèles, coûts, refus, sous-agents, verdicts) et propose des
améliorations du harnais, chacune avec sa preuve. Elle coûte quelques dizaines de centimes ; son
échec est signalé et n'arrête jamais la boucle.
Pour une tentative Codex, son entrée cite `codex-<n>.jsonl`, pour OpenCode `opencode-<n>.jsonl` ; elle
omet le nombre de compactions quand il est inconnu.

Les propositions s'accumulent dans `.harness-state/retours/observations.jsonl`, au statut `propose`.
Après un lot de tickets :

```sh
node scripts/loop/retro.mjs liste                     # propositions ouvertes ou différées, par cible puis impact
node scripts/loop/retro.mjs liste --tous              # avec celles déjà tranchées
node scripts/loop/retro.mjs decider R-T003-2 accepte "fait dans la skill ticket"
node scripts/loop/retro.mjs decider R-T003-4 ticket:T015
node scripts/loop/retro.mjs decider R-T004-1 refuse "voulu : garde-fou"
```

La rétrospective propose, elle ne modifie rien. Sans `--tune-every`, une proposition n'est appliquée
que par le propriétaire. Avec, l'harmonisation des consignes (plus bas) applique aux skills et aux
agents les problèmes qui reviennent, et les marque `harmonisation:<commit>` ; tout ce qui touche aux
contrôles reste au propriétaire. Une proposition qu'elle diffère passe à `differee:<ID>` : `liste` la montre
avec cette décision et sa note jusqu'à ce que le propriétaire la tranche.

Un échec qui ne se produit que sous charge se reproduit et s'explique avant d'être écarté : on ne
relance pas la boucle jusqu'à ce qu'elle passe.

`.harness-state/` est hors Git : c'est de l'état local. Le dossier d'un ticket se supprime sans risque
une fois le ticket intégré.

## Harmonisation des consignes

Avec `--tune-every N`, tous les N tickets intégrés depuis le lancement, après la rétrospective du
dernier, la boucle harmonise les consignes du harnais avant le ticket suivant. Par défaut (`0`), jamais.
`--dry-run` dit si elle est active, et tous les combien.

**Ce qui est retenu**, par le code et non par un modèle : parmi les observations en attente de type
`probleme` dont la cible est `skill` ou `agent`, les seules qu'une harmonisation peut corriger, les sujets
qui reviennent sur au moins deux tickets différents, ou dont une observation est d'impact `fort`. Les plus
fréquents d'abord (à égalité, le premier apparu dans le journal), trois sujets au plus ; un sujet retenu
apporte toutes ses observations de problème en attente qui visent une skill ou un agent. Un sujet qui mêle
plusieurs cibles n'apporte que celles-là, et ses tickets se comptent sur elles seules. Les autres cibles
(`hook`, `boucle`, `controle`, `ticket`, `autre`) restent au propriétaire, par `retro.mjs liste`. Deux
observations ne comptent pour le même sujet que s'il est écrit à l'identique, espaces de début et de fin mis à part : la
rétrospective reprend mot pour mot le sujet d'une proposition déjà ouverte. Sans rien à retenir, la boucle affiche « Rien à harmoniser » et
continue. Un journal des retours illisible (ligne tronquée, écrite à la main) fait sauter
l'harmonisation : la boucle l'affiche (« Harmonisation sautée ») et continue la file.

**La session** : `claude -p`, une seule tentative, au palier du relecteur d'un ticket standard (avec
l'échelle par défaut : Opus 5.5, effort high), relecteur au même palier. `--budget-usd`, `--timeout-min`, `--permission-mode` et
`--compact-window` s'appliquent comme à un ticket ; `--model` et `--effort`, non. Elle a son propre
identifiant, `H001`, `H002`…, jamais réutilisé, et son dossier `.harness-state/tickets/<ID>/`, où la
boucle écrit `observations.json`. Elle suit la skill `harmonisation` : l'agent `harmoniseur` modifie les
consignes, un `relecteur` neuf relit le diff contre les observations et contre la règle « ne retire
aucune vérification », puis viennent `node scripts/check.mjs` et `verdict.json`.

**Ce qu'elle peut modifier** : `.claude/skills/`, `.claude/agents/` et `.agents/skills/`, hors ce que la portée y ferme
(ci-dessous) ; rien d'autre.

**Ce qu'elle ne peut pas modifier** : ses arbitres, c'est-à-dire `.claude/agents/relecteur.md`,
`.claude/agents/harmoniseur.md` et `.claude/skills/harmonisation/`, que la portée ferme bien qu'ils soient
dans ces dossiers ; les contrôles (`scripts/check.mjs`, `scripts/quality/` et le plancher du cliquet,
`scripts/loop/`, `.claude/hooks/`, `.claude/settings.json`) ; les tickets et leur gabarit, `CLAUDE.md`,
`docs/standards.md`. Le hook `guard-write` le refuse pendant la session, et la boucle le revérifie sur le
diff ; les deux lisent la même portée (`scripts/loop/harness-scopes.mjs`). Les modifier reste la décision
du propriétaire, par un ticket `harnais: oui`.

**Une observation différée** : une proposition qui viserait ces fichiers ou les contrôles, ou qui
retirerait une vérification, est différée par la session, avec sa raison. La boucle l'affiche et, si elle
intègre la session ou la termine sans changement, la marque `differee:<ID>` (l'identifiant de
l'harmonisation), avec cette raison en note. Une différée n'est plus retenue par les harmonisations
suivantes : elle attend le propriétaire, qui la voit dans `retro.mjs liste`, avec sa décision et sa note,
et la tranche avec `retro.mjs decider <id> accepte|refuse|ticket:T…`. Après un refus, aucune n'est
marquée.

**Après la session**, la boucle vérifie, dans cet ordre :

1. un verdict TERMINÉ ;
2. un diff (fichiers suivis modifiés, fichiers nouveaux) limité à `.claude/skills/` et `.claude/agents/`,
   hors fichiers fermés, avant de lancer quoi que ce soit : un contrôle modifié n'est jamais exécuté ;
3. une relecture enregistrée sur l'état final, et acceptée par le dernier relecteur ;
4. `node scripts/check.mjs` vert en entier.

Tout passe : un commit `Tune the harness: <resume du verdict>`, avec les identifiants des observations
traitées et la ligne `Co-Authored-By` du modèle. Ces observations passent à `harmonisation:<commit>`,
les différées à `differee:<ID>`, puis la boucle pousse ; un push refusé l'arrête (code 3), comme pour un
ticket. Si le marquage échoue (journal devenu illisible pendant la session), la boucle le dit, avec la
commande `retro.mjs decider` pour le faire à la main, et pousse quand même : le commit est fait. Un
verdict TERMINÉ sans aucun changement ne committe rien : les différées passent à `differee:<ID>`, les
autres observations restent en attente.

**Un refus** (verdict absent ou autre que TERMINÉ, diff hors des consignes, relecture absente, périmée
ou refusée, contrôle rouge) annule la session : la boucle désindexe, remet les fichiers suivis modifiés
dans leur état de `HEAD`, met de côté les fichiers nouveaux absents avant la session, puis vérifie qu'il
ne reste rien de la session et qu'aucune de ces commandes Git n'a échoué. **Mettre de côté**, c'est
déplacer chaque fichier, sous son chemin, dans `.harness-state/tickets/<ID>/mis-de-cote/`, hors Git : la
boucle ne sait pas qui l'a créé pendant la session (la session, le propriétaire, une autre session), et
ne supprime donc rien. Elle affiche la liste de ces fichiers et leur dossier, et l'événement du refus la
porte ; un fichier qui ne venait pas de la session se récupère à la main. Remise réussie : elle écrit la
raison dans `refus.txt`, l'affiche et continue la file ; les observations restent en attente, différées
comprises. Remise incomplète (par exemple un `.git/index.lock` resté en place, ou un fichier qui n'a pas
pu être déplacé) : elle s'arrête avec le code 4, sans lancer de ticket sur un arbre sale, et dit quels
fichiers restent et quoi examiner. Une harmonisation ne bloque donc jamais un ticket ; seuls une remise à
`HEAD` impossible (code 4) ou un push refusé (code 3) arrêtent la boucle.

**Reprise après un refus** : si l'harmonisation précédente, celle au numéro juste inférieur, a été
refusée, la consigne de la suivante nomme son `refus.txt` et, s'il existe, le dernier `relecture-<n>.md`
de son dossier ; la session les lit d'abord. Seule la précédente compte, pas tout l'historique. Après une
harmonisation intégrée, ou pour la première, la consigne n'en nomme aucun.

**Annuler une harmonisation intégrée** : `git revert <commit>` du commit `Tune the harness: …`. Ses
observations restent marquées de ce commit ; les trancher de nouveau avec `retro.mjs decider` (`refuse`
avec une note, ou `ticket:T…`).

## Débloquer un ticket

Le ticket est à `bloque`, la file est arrêtée, le travail en cours est laissé tel quel dans le dossier.
Lire d'abord la raison affichée et le dernier `echec-<n>.txt`, puis `git status` et `git diff`. Quatre
cas.

1. **Le ticket attend une décision.** La session a rendu BLOQUÉ sur une question au propriétaire.
   Écrire la décision au début de la section « Hypothèses bloquantes », à la place de la question,
   remettre `statut: a-faire`, committer, relancer.
2. **Le ticket est faux ou trop gros** (périmètre contredit par le code, critère invérifiable, session
   qui s'est compactée). Corriger ou recouper le ticket, garder ou jeter le travail en cours, remettre
   `statut: a-faire`, committer, relancer.
3. **Le travail est presque bon.** Le finir à la main ou dans une session interactive, lancer
   `node scripts/check.mjs`, passer le ticket à `termine`, committer.
4. **Le harnais se trompe** (contrôle faux, garde-fou trop large). Le corriger avec son test, dans un
   commit séparé, puis remettre le ticket à `a-faire`. Un contrôle se rend plus juste, jamais plus
   permissif pour faire passer un ticket.

Dans tous les cas la boucle ne repart que si `git status` ne montre aucun fichier suivi modifié.

Jeter le travail en cours d'un ticket :

```sh
git stash --include-untracked   # réversible ; `git stash drop` ensuite si le travail est bien à jeter
```

Attention : cette commande emporte aussi les fichiers non suivis qui ne viennent pas du ticket.

### Trancher un ticket qui attend une décision

Un ticket dont la section « Hypothèses bloquantes » commence par
« Décision attendue du propriétaire : » n'est pas `bloque` : il reste `a-faire`, la boucle ne le lance
pas et continue sans lui. Pour le trancher, remplacer la question par la décision, au début de la
section, puis committer. Un accord écrit ailleurs, dans le journal par exemple, ne suffit pas : la
boucle ne lit que le début de la section, et le ticket resterait en attente.

Seul le début de la section compte. Une question posée ailleurs dans le ticket n'arrête pas la boucle :
la session peut rendre BLOQUÉ (cas 1 plus haut) ou trancher à la place du propriétaire. Relire alors
son commit comme une proposition.

## Écrire un ticket

Suivre la skill `decoupage` et partir de `docs/travail/tickets/_gabarit.md`. Un bon ticket tient dans
une session et un commit, livre seul quelque chose de vérifiable, et chacun de ses critères se vérifie
par un test ou une commande. Les champs `installe`, `harnais` et `supprime_tests` valent `non` par
défaut ; les passer à `oui` est une décision à relire. `niveau` vide laisse la boucle le déduire ;
`simple` n'est jamais déduit, il se déclare pour un ticket mécanique (renommage, texte, test isolé).

Ce que les premiers tickets ont appris :

- Aucun critère ne porte sur l'état global du dossier (« `git status` ne montre que… ») : des fichiers
  non suivis étrangers au ticket le rendent impossible à tenir, et la boucle les écarte déjà du commit.
- Les retouches triviales d'un même fichier se regroupent dans un ticket : le coût fixe d'une session
  (explorer, relire, contrôle complet) domine pour un petit changement.
- La section « Hypothèses bloquantes » commence par l'une de deux phrases exactes :
  « Aucune décision n'est attendue. », ou
  « Décision attendue du propriétaire : » suivie de la question. La boucle ne lance pas un ticket qui
  attend une décision : elle continue avec les tickets prêts qui n'en dépendent pas et nomme ceux qui
  attendent. Le propriétaire tranche en remplaçant la question par sa décision, au début de la section ;
  un accord écrit ailleurs ne suffit pas.
- Le ticket cite les chemins et la version du code qu'il a lus. Si le code a bougé depuis, la session
  doit le dire et s'arrêter plutôt que deviner.

## Garde-fous

Dans une session de ticket, les hooks de `.claude/hooks/` refusent : commit, push, changement de
branche, session Claude, Codex ou OpenCode imbriquée, `gh`, installation de dépendance non autorisée (npm, pnpm,
yarn, bun, pip, uv, poetry, cargo, go, bundle), écriture
hors du projet, modification du harnais ou d'un autre ticket, création d'un fichier de test nommé
d'après un chantier. Un ticket `harnais: oui` lève le verrou du harnais et peut modifier le gabarit des
tickets, jamais un autre ticket. Une session d'harmonisation ne le lève que sur les consignes
(`HARNESS_EDIT_SCOPE=consignes`) : `.claude/skills/`, `.claude/agents/` et `.agents/skills/`, sauf
`.claude/agents/relecteur.md`, `.claude/agents/harmoniseur.md` et `.claude/skills/harmonisation/` ; le
reste du harnais et le gabarit lui restent fermés, et une portée inconnue n'ouvre rien. Un sous-agent lancé en arrière-plan est
ramené au premier plan. Chaque fichier écrit est contrôlé aussitôt, et la session ne peut pas se terminer sans verdict ni se dire TERMINÉE sur
un contrôle rouge. La boucle n'intègre ensuite que le changement que le dernier relecteur a lu et
accepté : une modification faite après la relecture, journal du ticket mis à part, ou un dernier
verdict « à corriger », fait refuser le ticket.

Ce sont des garde-fous sur le texte des commandes, pas un bac à sable : ils rattrapent l'erreur, pas la
malveillance. La décision d'intégrer reste celle de la boucle.

En session interactive, modifier le harnais demande une confirmation. Pour l'ouvrir dix heures :

```sh
mkdir -p .harness-state && echo $(( $(date +%s) + 10*3600 )) > .harness-state/harnais-ouvert
```

## Faire évoluer le harnais

Le harnais se resserre avec le projet, toujours par une décision du propriétaire :

| Signal | Où le lire | Ce qui change |
| --- | --- | --- |
| Une proposition de la rétrospective | `node scripts/loop/retro.mjs liste` | `decider <id> accepte`, puis un ticket `harnais: oui` ou une session où le harnais est ouvert ; `decider <id> ticket:T0NN` la rattache au ticket qui la traite |
| Une mesure qui s'améliore | le commit du ticket | la boucle resserre le plancher du cliquet d'elle-même |
| Une règle relue qui revient en relecture | `relectures.jsonl`, les rapports du relecteur | une mesure dans `harness.config.mjs` (`measures`), puis `node scripts/quality/ratchet.mjs --tighten` |
| Des tickets qui montent souvent de palier, ou qui coûtent trop | `.harness-state/loop/events.jsonl` | l'échelle de modèles ou les niveaux dans `harness.config.mjs` (`models`) |
| Une session qui se compacte | `compactions.jsonl`, message de la boucle | des tickets plus petits (skill `decoupage`) ou `--compact-window` |

Une amélioration du noyau utile à d'autres projets remonte dans evolutive-harness :
`node install.mjs <ce projet> --compare` depuis evolutive-harness montre ce qui a divergé, `--pull` la
reprend dans le modèle. Les autres projets la reçoivent par `--update`.
