---
name: tests
description: Méthode de test du projet pour qui écrit le code et ses tests ensemble — un comportement à la fois, rouge vu puis vert minimal, frontières publiques, horloge et dépendances injectées. À charger avant d'écrire ou de modifier un test, ou de corriger un bug.
---

# Écrire les tests

## D'où vient un test

- De l'attendu : critères du ticket, règles de `docs/`, ADR. Jamais de l'implémentation.
- Un test se lit comme une phrase de spécification. Son fichier porte le nom du module ou du
  comportement (`session-archive.test.cjs`), jamais celui d'un ticket, d'un chantier ou d'une revue.
- Un nouveau test rejoint le fichier du module qu'il couvre. On ne crée un fichier que pour un module
  qui n'en a pas.

## Où tester

- Par une frontière publique : l'export d'un module, une route HTTP, une commande, un message.
- Jamais contre le **texte** du code source (`readFileSync` d'un fichier de production puis `assert.match`).
  Si la logique n'est pas importable, la rendre importable fait partie du travail.
- Jamais contre les internes : champs non exportés, drapeaux, ordre des appels.

## Ce qu'on maîtrise au lieu de l'attendre

- Le temps : horloge et minuteries injectées. Pas de `setTimeout` réel ni d'attente « assez longue » ;
  on attend un signal explicite (une promesse résolue par l'événement), pas une durée.
- Le réseau : port `0`, jamais un numéro fixe.
- Les fichiers : un dossier temporaire par test, supprimé à la fin.
- Les fournisseurs (API externes, modèles, services payants) : toujours des doublures, par les points
  d'injection existants.

## Cycle

1. Un comportement observable, un test.
2. **Rouge** : lance-le et vois-le échouer sur son assertion, pas sur un import ou une faute de frappe.
3. **Vert** : le plus petit changement qui le fait passer.
4. **Nettoyage** du code et du test, tout reste vert.
5. `node scripts/check.mjs --changed`.

Pour un bug : d'abord le test qui le reproduit, rouge, puis la correction.

## Interdits

- Supprimer ou assouplir un test pour obtenir le vert.
- Relancer un test instable jusqu'à ce qu'il passe. Un échec intermittent se reproduit volontairement,
  s'explique, puis se corrige ; en attendant il se rapporte tel quel.
- Affirmer un résultat qu'on n'a pas observé : un test non lancé est dit non lancé.
- Comparer un message d'erreur français mot pour mot, sauf si ce texte est ce que voit l'utilisateur.
  Une erreur s'identifie par son code.

## Lancer

```sh
node --test tests/mon-module.test.cjs      # un fichier
node scripts/check.mjs --changed           # fichiers modifiés
node scripts/check.mjs                     # tout, en séquentiel
```

---
Adapté de la skill `harness-testing` du dépôt harness-codex-claude (elle-même adaptée de mattpocock/skills, licence MIT).
