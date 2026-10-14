# Travailler par tickets avec la boucle

La boucle traite les tickets de `docs/travail/tickets/` un par un. Pour chaque ticket elle lance une
session Claude Code fraîche, puis relance elle-même tous les contrôles avant de committer et de pousser.
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
| `--ticket <id>` | prochain prêt | traiter ce ticket précisément |
| `--attempts <n>` | jusqu'en haut de l'échelle | sessions fraîches par ticket avant de le bloquer (3 avec `--model`) |
| `--model <m>` | l'échelle | fige le modèle de toutes les tentatives, sans escalade |
| `--effort <e>` | celui du palier | remplace l'effort de chaque palier |
| `--no-retro` | rétrospective | ne pas lancer la rétrospective après le ticket |
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

### Modèle de chaque tentative

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
   rapport. Le hook `record-review` enregistre le verdict de chaque relecteur dans `relectures.jsonl`.
3. Si le verdict est TERMINÉ, la boucle vérifie elle-même :
   - le ticket n'a pas changé au-dessus de son journal ;
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

Codes de sortie : 0 terminé, 1 refus au démarrage, 2 ticket bloqué, 3 commit fait mais push refusé.

## Lire un échec

La dernière ligne de la boucle dit dans quel cas on est.

| La boucle affiche | Ce que ça veut dire | Où regarder |
| --- | --- | --- |
| un refus avant toute session (code 1) | branche `main`, fichier suivi modifié, file invalide, ticket non suivi par Git, ou ticket demandé par `--ticket` qui ne peut pas partir (inconnu, pas prêt, en attente d'une décision, ou file arrêtée par un autre ticket `en-cours` ou `bloque`) | le message lui-même ; corriger puis relancer |
| `Tentative n refusée : …` | la session n'a pas rendu de verdict, s'est dite PARTIELLE, ou s'est dite TERMINÉE alors qu'un contrôle refuse | `.harness-state/tickets/<ID>/echec-<n>.txt` |
| `<ID> est bloqué : …` (code 2) | la session s'est dite BLOQUÉE, ou toutes les tentatives ont été refusées | la raison affichée, puis le journal du ticket |
| `Le commit est fait mais le push a échoué` (code 3) | le ticket est intégré en local, rien d'autre n'est lancé | `git status`, puis `git push` à la main |

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
| `.harness-state/loop/events.jsonl` | une ligne par événement, avec la charge de la machine : session lancée (niveau, modèle, effort, palier, relecteur), session terminée (tours, durée, coût, coût par modèle, sous-agents, refus de permission, compactions), refus, intégration et blocage (tentatives, coût total), rétrospective |
| `.harness-state/tickets/<ID>/verdict.json` | le verdict de la dernière session, ses preuves et ses réserves (`reste`) |
| `.harness-state/tickets/<ID>/session-<n>.json` | le compte rendu final de la session (tours, durée, coût) |
| `.harness-state/tickets/<ID>/session-<n>.jsonl` | le flux entier de la session, message par message |
| `.harness-state/tickets/<ID>/exploration.md` | le rapport d'exploration |
| `.harness-state/tickets/<ID>/ecarts.md` | les écarts aux critères déclarés avant l'implémentation et les constats contestés, que le relecteur tranche |
| `.harness-state/tickets/<ID>/revue-<n>.diff`, `revue-<n>.fichiers` | chaque relecture : le diff relu, fichiers nouveaux en entier, et la liste des fichiers |
| `.harness-state/tickets/<ID>/reviewed-state.json` | l'état de la dernière relecture, que la boucle compare à l'état final |
| `.harness-state/tickets/<ID>/relectures.jsonl` | le verdict de chaque relecteur, la revue qu'il a lue et son modèle |
| `.harness-state/tickets/<ID>/retro-entree.md`, `retro.json` | ce que la rétrospective a reçu, et ce qu'elle a rendu |

Un verdict TERMINÉ peut garder des réserves dans `reste` : un constat de relecture hors périmètre, un
écart à un critère accepté par le relecteur, ce qui n'a pas pu être vérifié, ou une question pour le
propriétaire. La boucle intègre et les affiche.

## Rétrospective

Après chaque ticket, intégré ou bloqué, une courte session Sonnet en lecture seule relit ce que la
boucle a observé (tentatives, modèles, coûts, refus, sous-agents, verdicts) et propose des
améliorations du harnais, chacune avec sa preuve. Elle coûte quelques dizaines de centimes ; son
échec est signalé et n'arrête jamais la boucle.

Les propositions s'accumulent dans `.harness-state/retours/observations.jsonl`, au statut `propose`.
Après un lot de tickets :

```sh
node scripts/loop/retro.mjs liste                     # propositions ouvertes, par cible puis impact
node scripts/loop/retro.mjs liste --tous              # avec celles déjà tranchées
node scripts/loop/retro.mjs decider R-T003-2 accepte "fait dans la skill ticket"
node scripts/loop/retro.mjs decider R-T003-4 ticket:T015
node scripts/loop/retro.mjs decider R-T004-1 refuse "voulu : garde-fou"
```

Une proposition acceptée n'est appliquée par personne d'autre que le propriétaire : la rétrospective
propose, elle ne modifie rien.

Un échec qui ne se produit que sous charge se reproduit et s'explique avant d'être écarté : on ne
relance pas la boucle jusqu'à ce qu'elle passe.

`.harness-state/` est hors Git : c'est de l'état local. Le dossier d'un ticket se supprime sans risque
une fois le ticket intégré.

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
branche, session Claude ou Codex imbriquée, `gh`, installation de dépendance non autorisée (npm, pnpm,
yarn, bun, pip, uv, poetry, cargo, go, bundle), écriture
hors du projet, modification du harnais ou d'un autre ticket, création d'un fichier de test nommé
d'après un chantier. Un ticket `harnais: oui` lève le verrou du harnais et peut modifier le gabarit des
tickets, jamais un autre ticket. Un sous-agent lancé en arrière-plan est ramené au premier plan. Chaque fichier
écrit est contrôlé aussitôt, et la session ne peut pas se terminer sans verdict ni se dire TERMINÉE sur
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
