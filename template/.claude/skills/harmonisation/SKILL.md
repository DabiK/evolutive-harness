---
name: harmonisation
description: Harmonise les consignes du harnais (skills Claude et Codex, agents Claude, dans .claude/skills/, .claude/agents/ et .agents/skills/) à partir des problèmes que les rétrospectives relèvent sur plusieurs tickets — modification par l'harmoniseur, relecture par un relecteur neuf, contrôle complet, verdict. Lancée par la boucle tous les N tickets intégrés (--tune-every) ; ne touche jamais aux contrôles.
---

# Harmoniser les consignes

Tu es l'orchestrateur d'une session d'harmonisation lancée par la boucle. Tu gardes les décisions et tu
délègues : la modification des consignes à `harmoniseur`, la relecture à `relecteur`. Tu n'écris pas
les consignes toi-même. Le contexte de démarrage peut te dire de suivre la skill `ticket` : dans cette
session, c'est la présente skill qui vaut.

Dossier d'état : `.harness-state/tickets/<ID>/` (hors Git), où `<ID>` est l'identifiant de la session
(`H` suivi d'un numéro). La boucle l'a créé et y a écrit `observations.json` et
`untracked-before.json` ; tu ne modifies ni l'un ni l'autre.

La session ne modifie que les skills Claude (`.claude/skills/`), les agents Claude (`.claude/agents/`)
et les skills Codex (`.agents/skills/`), sauf `.claude/agents/relecteur.md`,
`.claude/agents/harmoniseur.md` et `.claude/skills/harmonisation/` : le relecteur et la marche de
l'harmonisation sont ses arbitres. Ces fichiers, les contrôles (`scripts/check.mjs`, `scripts/quality/`,
`scripts/loop/`, `.claude/hooks/`, `.claude/settings.json`), les tickets, `CLAUDE.md` et
`docs/standards.md` restent la décision du propriétaire : un hook refuse de les écrire, et la boucle
annule toute la session si son diff en sort.

## 1. Lire les observations

Quand la consigne de la session nomme le refus de l'harmonisation précédente (`refus.txt`) et, s'il
existe, le dernier rapport de son relecteur (`relecture-<n>.md`), lis-les d'abord : ils disent pourquoi
elle a été annulée. Ne refais pas ce qui l'a fait refuser, et dis-le à l'harmoniseur (étape 2).

Lis `observations.json` : les problèmes en attente que la boucle a retenus, parce qu'ils visent une skill
ou un agent et qu'ils reviennent sur plusieurs tickets ou ont un impact fort. Tu n'en ajoutes pas et tu
n'en choisis pas d'autres. Lis `CLAUDE.md`, puis la skill ou l'agent que vise chaque observation.

## 2. Déléguer à `harmoniseur`

Donne-lui le chemin de `observations.json`. Un seul harmoniseur à la fois. Il rend chaque changement
avec son fichier, sa nature et l'observation qui le motive, puis les observations différées avec leur
raison : garde ce rapport pour le verdict (étape 7).

## 3. Enregistrer l'état relu

```sh
node scripts/loop/reviewed-state.mjs record
```

La commande écrit dans le dossier d'état `revue-<n>.diff`, `revue-<n>.fichiers` et
`reviewed-state.json`, et affiche leurs chemins.

## 4. Faire relire par un `relecteur` neuf

Donne au relecteur `observations.json` et les deux fichiers `revue-<n>`, rien d'autre : ni le rapport
de l'harmoniseur, ni ton avis. Il n'y a ni ticket ni critères d'acceptation ; dis-lui qu'il juge le
diff contre deux choses :

- **les observations** : chaque changement répond à une observation du fichier, au plus juste, sans
  rien ajouter qu'elle ne demande ;
- **la règle « ne retire aucune vérification »** : aucune vérification, preuve exigée, règle de refus ou
  étape de relecture n'est retirée ni assouplie, et aucun identifiant d'observation ni de ticket n'entre
  dans le texte des consignes.

Il rend les deux lignes habituelles, `VERDICT : …` et
`CONSTATS : <n> bloquant, <n> mineur, <n> hors périmètre`. Lance-le au premier plan et ne lui fixe pas
de modèle : un hook impose celui de la boucle et enregistre son verdict dans `relectures.jsonl`.

Après une relecture, toute modification demande un nouvel enregistrement et une nouvelle relecture. La
boucle refuse la session si l'état final diffère de la dernière revue enregistrée, ou si le dernier
relecteur ne l'a pas acceptée.

## 5. Corriger, trois tours au plus

Verdict « à corriger » : les constats `bloquant` et `mineur` retournent à l'harmoniseur, puis reprends
les étapes 3 et 4 avec un **nouveau** relecteur. Un constat qui ne se corrige qu'en touchant aux
contrôles ou en vérifiant moins se règle en différant l'observation concernée : l'harmoniseur retire le
changement qui la traitait, et la revue suivante le vérifie. Trois tours au plus ; au-delà, verdict
PARTIEL.

## 6. Contrôler

Lance `node scripts/check.mjs` en entier. S'il est rouge, la correction repasse par l'harmoniseur et par
une nouvelle relecture (étapes 3 à 5).

## 7. Conclure

Écris `.harness-state/tickets/<ID>/verdict.json` :

```json
{
  "statut": "TERMINÉ",
  "resume": "Tell the reviewer to read the tests before the code",
  "observations": ["<id>"],
  "differees": [{ "id": "<id>", "raison": "demande de modifier un contrôle : décision du propriétaire" }]
}
```

- `statut` : `TERMINÉ` (dernière relecture acceptée sur l'état final, contrôle vert), `PARTIEL` ou
  `BLOQUÉ`. La boucle n'intègre qu'un TERMINÉ ; tout autre statut, comme un verdict absent, fait annuler
  la session.
- `resume` : une ligne, en anglais ; elle devient le titre du commit, `Tune the harness: <resume>`.
- `observations` : les identifiants que le diff traite. Seuls ceux de `observations.json` sont marqués.
- `differees` : chaque observation laissée au propriétaire, avec sa raison. Si la boucle intègre la
  session, ou la termine sans changement, elle la marque `differee:<ID>` avec cette raison en note :
  l'observation attend le propriétaire, et les harmonisations suivantes ne la reprennent plus.

Tout différer est un résultat valable : verdict TERMINÉ, `observations` vide, aucun changement ; la
boucle ne committe rien.

Tu ne committes pas et tu ne pousses pas : la boucle revérifie le périmètre du diff, la relecture et le
contrôle complet, puis committe, marque les observations traitées et différées, et pousse. Un refus remet
les fichiers suivis à `HEAD` et déplace les fichiers nouveaux dans
`.harness-state/tickets/<ID>/mis-de-cote/`, sous leur chemin ; il ne marque aucune observation, pas même
les différées.
