# MonProjet — consignes pour Claude Code

<!-- Gabarit installé par evolutive-harness : remplace les passages entre chevrons, puis supprime ce commentaire. -->

<Une phrase : ce que fait le projet et pour qui.> Présentation dans `README.md`.

Ces consignes valent aussi pour Codex : `AGENTS.md` est un lien vers ce fichier.

## Avant de modifier du code

1. Lis `docs/standards.md` : ce sont les règles, et la plupart sont vérifiées par une machine.
2. Lis le code que tu vas toucher en entier, ses appelants et ses tests. Lis les ADR de `docs/adr/` qui
   concernent la zone.
3. Pour traiter un ticket de `docs/travail/tickets/`, une session Claude suit la skill `ticket` ; une
   session Codex suit `.agents/skills/ticket-codex/SKILL.md`. Pour en écrire, la skill `decoupage`.
   Pour écrire un test, la skill `tests`.

## Frontières

<Les couches du projet et ce que chacune a le droit d'importer. Exemple :
- `src/domaine/` : règles métier, sans accès disque, réseau ni variables d'environnement ;
- `src/adapters/` : implémentations des accès extérieurs ;
- `src/app/` : point d'entrée et composition.>

## Contrôler

```sh
node scripts/check.mjs --changed   # fichiers modifiés : règles, cliquet, tests modifiés
node scripts/check.mjs             # tout, tests en séquentiel
```

Un contrôle « non lancé » n'est pas un contrôle réussi : dis-le tel quel. Ne déclare jamais un résultat
que tu n'as pas observé.

## Ce qui ne se fait pas

- Affaiblir ou supprimer un test, ou relancer un test instable jusqu'à ce qu'il passe.
- Modifier le harnais (liste dans `scripts/loop/harness-files.mjs`) ou le plancher du cliquet pour faire
  passer un contrôle.
- Nommer un fichier, un test ou un commentaire d'après un ticket ou un chantier (« F07 », « T012 ») :
  le code décrit un comportement, l'historique vit dans Git et dans les tickets.
- Committer ou pousser sans demande. Pendant un ticket, c'est la boucle qui intègre.
- <Ce qui touche à la production, aux identifiants, aux services payants ou au matériel.>

## Faire évoluer le harnais

- Après chaque ticket, la rétrospective propose des changements du harnais. Le propriétaire les tranche :
  `node scripts/loop/retro.mjs liste`.
- Un changement du harnais passe par un ticket `harnais: oui`, ou par une session interactive où le
  propriétaire l'a ouvert pour une durée bornée (`docs/travail/README.md`, « Garde-fous »).
- Une amélioration utile à d'autres projets remonte dans evolutive-harness (`install.mjs --compare`).

## Machine

<Ce que la machine supporte : nombre de sous-agents à la fois, un seul navigateur, tests en séquentiel.>

## Langue

Documentation, messages affichés à l'utilisateur et consignes : français. Identifiants de code, noms de
tests et messages de commit : anglais.
