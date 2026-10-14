---
name: ticket
description: Traite un ticket de docs/travail/tickets/ de bout en bout dans une session fraîche — exploration, implémentation et relecture par trois sous-agents, boucle de correction, ADR, contrôle qualité, verdict. À utiliser dès qu'on demande d'exécuter, de traiter ou de reprendre un ticket.
---

# Traiter un ticket

Tu es l'orchestrateur. Tu gardes les décisions et tu délègues le travail : l'exploration à
`explorateur`, le code et les tests à `implementeur`, la relecture à `relecteur`. Tu ne lis pas le code
en détail toi-même et tu n'écris pas de code : ton contexte sert à décider.

Dossier d'état du ticket : `.harness-state/tickets/<ID>/` (hors Git). Crée-le au début.

## 1. Cadrer

Lis le ticket en entier et `docs/standards.md`. Si le journal du ticket contient déjà des jalons, ou si
`.harness-state/tickets/<ID>/` contient un rapport d'échec, c'est une **reprise** : lis-les, regarde
`git status` et `git diff`, et repars du dernier jalon au lieu de recommencer.

## 2. Explorer

Délègue à `explorateur` avec le chemin du ticket. Écris son rapport dans
`.harness-state/tickets/<ID>/exploration.md` et résume-le en cinq lignes dans le journal du ticket.

Si l'exploration contredit le ticket sur un point qui change le périmètre, **arrête-toi** : verdict
BLOQUÉ, avec l'écart constaté. Tu ne réécris pas le ticket et tu n'improvises pas un autre périmètre.

Si l'exploration montre qu'un critère ne peut pas être tenu tel qu'il est écrit, tranche avant
l'implémentation. Si le tenir demande de sortir du périmètre, ou si l'écart affaiblit ce que le
critère prouve : verdict BLOQUÉ. Sinon, écris l'écart dans `.harness-state/tickets/<ID>/ecarts.md` : le
critère, ce qui change, et la preuve qui le remplace. Le relecteur l'accepte ou le refuse ; un écart
qu'il découvre sans qu'il ait été déclaré est un constat `bloquant`.

## 3. Implémenter

Délègue à `implementeur` : le ticket, le rapport d'exploration, et le plan d'incréments retenu. Un seul
implémenteur à la fois.

## 4. Écrire l'ADR

Si le ticket porte `adr: oui`, écris l'ADR dans `docs/adr/` à partir de `docs/adr/0000-gabarit.md`,
avec le numéro suivant, avant la relecture : il en fait partie. Un ADR dit la décision, son contexte et
ses conséquences ; l'historique des essais va dans le journal du ticket.

## 5. Relire

Enregistre l'état relu, puis délègue à un `relecteur` neuf :

```sh
node scripts/loop/reviewed-state.mjs record      # hors boucle : ajouter --ticket <ID>
```

La commande écrit dans le dossier d'état `revue-<n>.diff` (les fichiers suivis par rapport à `HEAD`,
puis chaque fichier nouveau en entier), `revue-<n>.fichiers` (la liste des fichiers) et
`reviewed-state.json`, et affiche leurs chemins. Donne au relecteur le chemin du ticket, ces deux
fichiers `revue-<n>` et `.harness-state/tickets/<ID>/ecarts.md` quand il existe, rien d'autre. Ton avis
ne lui parvient que par `ecarts.md` (un écart déclaré, un constat contesté avec sa raison), jamais par
ton message ; le compte rendu de l'implémenteur ne lui est pas donné. Lance-le au premier plan et ne lui
fixe pas de modèle : dans la boucle, un hook impose celui du palier et enregistre son verdict dans
`relectures.jsonl`. Le hook lit ce verdict sur deux lignes du rapport, `VERDICT : …` et
`CONSTATS : <n> bloquant, <n> mineur, <n> hors périmètre`. Un « accepté » qui compte un bloquant ou un
mineur est enregistré « à corriger » ; un « accepté » sans ligne `CONSTATS` lisible, « illisible ».

Après une relecture, toute modification autre que le journal du ticket demande une nouvelle relecture,
y compris une correction exigée à la fin par un contrôle rouge. La boucle compare l'état final à la
dernière relecture enregistrée et refuse le ticket s'ils diffèrent, si aucune relecture n'est
enregistrée, ou si le dernier relecteur n'a pas rendu « accepté » sur cette revue.

## 6. Corriger, puis relire de nouveau

Verdict « à corriger » : tout constat `bloquant` ou `mineur` retourne à `implementeur`, puis enregistre
de nouveau l'état relu et fais relire par un **nouveau** `relecteur`. Tu peux aussi contester un constat
au lieu de le faire corriger : écris-le dans `.harness-state/tickets/<ID>/ecarts.md` avec une raison
précise, et le relecteur suivant tranche ; un constat qu'il maintient retourne à l'implémenteur. Les
constats `hors périmètre` ne se corrigent pas dans le ticket : ils deviennent des réserves (étape 8).
Trois tours au plus. Au-delà, verdict PARTIEL avec les constats restants.

## 7. Laisser une trace

Mets à jour le journal du ticket : un jalon par étape, avec la commande lancée et son résultat réel.
Tu ne modifies rien au-dessus de la ligne `## Journal`.

## 8. Conclure

Lance `node scripts/check.mjs` en entier. S'il est rouge, la correction repasse par l'implémenteur et
par une nouvelle relecture (étapes 5 et 6). Puis écris `.harness-state/tickets/<ID>/verdict.json` :

```json
{ "statut": "TERMINÉ", "resume": "ce qui est livré, en deux phrases", "revue": "accepté", "adr": "docs/adr/0011-….md", "preuves": ["node scripts/check.mjs : vert, 0 échec"], "reste": [] }
```

- `TERMINÉ` : critères couverts, dernière relecture acceptée, contrôle vert. Une relecture « à
  corriger » suivie d'un TERMINÉ est refusée.
- `PARTIEL` : du travail utile est fait mais il en reste ; dis quoi dans `reste`.
- `BLOQUÉ` : impossible d'avancer sans une décision ; dis laquelle dans `resume`.

Un TERMINÉ met ses réserves dans `reste`. Une réserve est un constat `hors périmètre`, un écart accepté
par le relecteur (écrit « Écart accepté, critère N : … »), ce qui n'a pas pu être vérifié, ou une
question pour le propriétaire ; jamais un constat `bloquant` ou `mineur`. Elles ne bloquent pas
l'intégration : la boucle les reporte dans le journal du ticket (jalon « Réserves à la clôture ») et
donne leur nombre dans le message du commit, tu n'as donc pas à les recopier dans le journal. Une
réserve ne remplace pas un PARTIEL ou un BLOQUÉ quand un critère n'est pas couvert.

Un statut est un constat, pas un objectif : PARTIEL dit la vérité vaut mieux que TERMINÉ faux, que la
boucle refusera de toute façon après ses propres contrôles.

Tu ne committes pas et tu ne pousses pas : la boucle le fait après avoir tout revérifié.
