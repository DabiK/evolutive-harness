VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre
NON CORRIGÉS : 0

La correction règle le seul constat mineur de la relecture 1. Je ne trouve ni régression ni nouveau constat dans le code modifié. Les deux constats hors périmètre de la relecture 1 restent des réserves.

## Constats

### 1. `app/main.cjs:344-373`, `sessionRows` (hors périmètre, repris de la relecture 1)
- **Problème :** le bug existait avant le refactor. `sessions:list` ne passe pas par `exclusive`. Si une fin de session remet `loaded` à `null` pendant `await library.list(...)`, `sessions.map(...)` lit `loaded.runtime.readOnly` et lève une `TypeError`.
- **Attendu :** un ticket ultérieur, qui capture la session avant l'`await` ou rend la lecture sûre après. Le ticket interdit tout changement de comportement.

### 2. Critère 4, couverture des lectures tardives (hors périmètre, repris de la relecture 1)
- **Problème :** la seule lecture figée dont on sait que les tests la voient est celle de `sessionState` (`tests/mac-ipc-contract.test.cjs:280`). On ne sait pas si les tests verraient une lecture figée ailleurs : les deux `getSession`, `getInstruction`, le microtask `drain`, le titre dans `compose.onChange`, `sweep` et `sessionRows`.
- **Attendu :** une réserve pour le propriétaire, à examiner avant T149 et T150. Le ticket interdit d'ajouter des tests.

## Suivi de la relecture 1

| Constat | Classe | État | Preuve |
| --- | --- | --- | --- |
| 1. `app/main.cjs:506-507` : déclaration scindée | mineur | **Corrigé** | Voir ci-dessous |
| 2. `sessionRows` | hors périmètre | Réserve | Repris plus haut, ne compte pas dans NON CORRIGÉS |
| 3. Couverture du critère 4 | hors périmètre | Réserve | Repris plus haut, ne compte pas dans NON CORRIGÉS |

Preuves de la correction du constat 1 :
- **Le code :** `revue-2.interdiff` ne contient qu'un changement, la réunion des deux lignes en une seule. Au même endroit, `app/main.cjs:506` se lit `let archive = id === loaded?.runtime.watch.id ? (library.dir(id), null) : await library.read(id);`.
- **Le comportement ne change pas.** Il est identique à la forme scindée, et à l'original `id === watch?.id` : le chaînage optionnel s'arrête dès `loaded?`, donc `undefined` quand aucune session n'est chargée.
- **Le journal :** l. 110 et 119-126, il reconnaît la scission et donne la sortie réelle du `grep`.

## Régressions dans le code modifié par la correction

- **Le reste du code :** il est inchangé depuis la relecture 1. `correction-1.diff` et l'interdiff n'ont qu'un seul bloc de modifications.
- **Les affectations de `loaded` :** il n'y en a que trois, l. 44 (initialisation), l. 332 (`adopt`) et l. 423 (`letGo`).
- **Les tests :** les trois bancs du Mac passent, 56 réussis et 0 échec (`correction-1-mac-before.log`, pris sur la forme scindée, dont le comportement est le même).
- **Le contrôle complet :** il est vert après la correction (`correction-1-check-full.log`) : 1 074/1 074 tests JS, Python OK avec 1 test ignoré, cliquet amélioré (535 → 523).

## Critères d'acceptation

| Critère | Résultat |
| --- | --- |
| 1. Aucun des neuf noms n'est déclaré par `let` | Tenu sur le fond, avec un écart accepté (ci-dessous). Les déclarations `let` relues (l. 39-45, 83-586) ne déclarent aucun des neuf noms. |
| 2. Fin de session en une affectation | Tenu : `loaded = null;` à la l. 423, dans `letGo`, qui reste synchrone. |
| 3. Aucun test modifié | Tenu selon les journaux. `correction-1-scope.log` : `git diff --stat` ne cite qu'`app/main.cjs` et le ticket, et `git diff -- tests` est vide. Les dossiers non suivis `design/continuous-context/` et `experiments/` étaient déjà là avant le ticket (`untracked-before.json`). |
| 4. Mutation temporaire | Tenu (relecture 1). La limite est reprise au constat 2. |
| 5. `node scripts/check.mjs` vert | Tenu selon `correction-1-check-full.log`. |

## Écarts et contestations

**Écart accepté, critère 1.** La commande du critère rend une ligne, `506:    let archive = id === loaded?.runtime.watch.id ? …`, alors que le critère attend une sortie vide.
- **La ligne rendue :** `grep -w` y reconnaît `watch` dans une lecture de propriété. Le seul nom déclaré sur cette ligne est `archive`.
- **Le fond est tenu :** aucun des neuf noms n'est une liaison `let`.
- **Cette ligne était prévisible :** elle apparaissait déjà, en lecture, dans `declarations-before.log`.
- **Pourquoi l'accepter :** refuser l'écart pousserait à remodeler le code pour satisfaire la commande, ce que la relecture 1 a justement reproché.
- **La déclaration :** l'écart est fait dans `ecarts.md`, avec la sortie réelle conservée (`correction-1-declarations.log`).

Il n'y a aucune contestation à trancher : `ecarts.md` dit qu'il ne conteste pas le constat 1.

## Ce que je n'ai pas pu vérifier

Je n'avais pas de shell. Je n'ai lancé ni les tests, ni `node scripts/check.mjs`, ni `git diff --stat`, ni la commande `grep` du critère 1 sous sa forme exacte. Les critères 3 et 5 et le résultat des tests après correction reposent sur les journaux `correction-1-*.log`.

J'ai vérifié directement :
- la ligne 506 ;
- les déclarations `let`, avec l'outil de recherche ;
- les trois affectations de `loaded`.