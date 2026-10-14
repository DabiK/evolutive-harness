---
name: decoupage
description: Découpe un besoin accepté, un rapport d'audit ou un plan en tickets locaux exécutables par la boucle — un fichier par ticket dans docs/travail/tickets/, ordonnés par dépendances, chacun avec ses critères et son test d'acceptation. À utiliser dès qu'on parle de découper, de créer des tickets ou de préparer la boucle.
---

# Découper en tickets

## Avant de découper

Il faut une source stable : un rapport d'audit relu, une spécification acceptée. Un besoin encore flou
ne se découpe pas ; dis ce qui manque.

## Ce qu'est un bon ticket

- **Il tient dans une session fraîche et dans un commit.** Si tu hésites, coupe.
- **Il livre seul quelque chose de vérifiable** : un comportement, ou une mesure du cliquet qui baisse.
  Pas de ticket « préparer la couche X » sans résultat observable.
- **Il est autonome** : quelqu'un qui n'a lu ni l'audit ni les autres tickets peut le traiter. Les
  chemins, les lignes et la version du code auxquels il se réfère y figurent.
- **Ses critères se vérifient par un test ou une commande**, pas par une appréciation.

## Ordre

1. Ce qui rend le reste possible passe d'abord : tests à réécrire avant un reformatage, outillage avant
   les règles qui s'appuient dessus.
2. Un refactor large se séquence en trois temps : **étendre** (la nouvelle forme existe à côté de
   l'ancienne), **migrer** par lots, **contracter** (l'ancienne forme disparaît). Un ticket par temps
   ou par lot.
3. Chaque ticket liste ce qui le bloque. La boucle prend le premier ticket « à faire » dont tous les
   bloqueurs sont terminés et qui n'attend aucune décision du propriétaire (section « Écrire »).

## Écrire

Un fichier par ticket, `docs/travail/tickets/NNN-slug.md`, numéroté dans l'ordre d'exécution, à partir
de `docs/travail/tickets/_gabarit.md`. Champs de l'en-tête :

| Champ | Valeurs | Rôle |
| --- | --- | --- |
| `id` | `T001` | identifiant stable |
| `titre` | texte | sert de message de commit |
| `statut` | `a-faire`, `en-cours`, `termine`, `bloque` | tenu par la boucle |
| `bloque_par` | `T001, T002` ou vide | dépendances |
| `adr` | `oui`, `non` | `oui` dès qu'un choix d'architecture est fait |
| `installe` | `oui`, `non` | autorise l'installation de dépendances (npm, pip, cargo…) pendant ce ticket |
| `harnais` | `oui`, `non` | autorise à modifier le harnais (liste dans `scripts/loop/harness-files.mjs`) |
| `supprime_tests` | `oui`, `non` | autorise la suppression de fichiers de test |

Les trois derniers valent `non` par défaut : les mettre à `oui` est une décision humaine, prise au
découpage et relue.

La section « Hypothèses bloquantes » commence par l'une de deux phrases exactes, que la boucle lit :

- « Aucune décision n'est attendue. » ;
- « Décision attendue du propriétaire : » suivie de la question à trancher avant de commencer.

La boucle ne lance pas un ticket qui attend une décision. Elle continue avec les tickets prêts qui n'en
dépendent pas et nomme ceux qui attendent. Le propriétaire tranche en remplaçant la question par sa
décision, au début de la section. Un accord écrit ailleurs, dans le journal par exemple, ne suffit pas.

## Règles

- N'invente aucune règle métier. Une inconnue devient une hypothèse marquée bloquante dans le ticket.
- Ne publie rien sur un service externe (issues GitHub) sans demande explicite.
- À la fin, donne la liste ordonnée des tickets et les arbitrages restés ouverts.

---
Adapté de la skill `harness-to-tickets` du dépôt harness-codex-claude (elle-même adaptée de mattpocock/skills, licence MIT).
