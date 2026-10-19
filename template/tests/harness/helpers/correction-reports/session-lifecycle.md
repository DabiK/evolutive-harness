VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre
NON CORRIGÉS : 0

Les deux constats mineurs de la relecture 1 sont corrigés. La correction ne change aucun comportement de production : elle touche des commentaires, l'ADR et le test, et je n'y trouve aucune régression. Reste une seule réserve, hors du périmètre de ce ticket.

## Les constats de la relecture 1

### 1. `tests/session-lifecycle.test.cjs:396-425` (mineur) : corrigé

Le constat : le test « … waits for both seals » ne prouvait pas que `seal()` attend les deux scellements.

**Ce qui a changé.** Avant chaque assertion `finished === false`, le test attend maintenant une macrotâche (`setImmediate`, l. 410 et 413). Il libère aussi les verrous dans les deux ordres, d'abord celui du store puis celui des vecteurs, puis l'inverse.

**Pourquoi la preuve tient maintenant.**
- `setImmediate` ne s'exécute qu'une fois la file de microtâches vide. Or la chaîne de `close()` ne passe que par des fonctions `async` sans minuterie. Elle a donc atteint `await Promise.all(sealing)` (`runtime/session-lifecycle.cjs:159`) quand l'assertion s'exécute. C'est exactement ce qui manquait.
- Le test ne peut pas devenir instable sur le code juste : `finished` ne passe à `true` qu'une fois les deux verrous ouverts, donc chaque assertion `false` tient toujours.
- Les deux ordres couvrent les deux mutations à une seule attente :
  - `await sealing[0]` est attrapé quand on libère d'abord le store ;
  - `await sealing[1]` est attrapé quand on libère d'abord les vecteurs.

**Les preuves dans les journaux.**
- `correction-1-seal-original-mutant.log` : l'ancien test passait sur la mutation `await sealing[0]`. La lacune était donc réelle.
- `correction-1-mutations.log` et `correction-1-seal-*-red.log` : quatre mutations échouent sur assertion. Les messages sont les attendus, par exemple `vectorSealGate is still pending after the other seal has settled` à la ligne 414.

### 2. Commentaires « pourquoi » perdus pendant le déplacement (mineur) : corrigé

Chaque point attendu est repris et dit une raison ou un contrat :

| Endroit | Ce que le commentaire rétablit |
| --- | --- |
| `#attemptClosing`, `runtime/session-lifecycle.cjs:53-54` | Un échec de fermeture n'empêche ni l'arrêt des autres fournisseurs ni l'archivage, et l'hôte garde les diagnostics. |
| `close`, `:80-81` | Le contrat de `purge` : les textes restent. Un refus disque ne fait pas échouer `close`. |
| Refus de purge en lecture seule, `:84-85` | Le refus s'applique à une archive seulement ouverte, avec la suppression explicite comme seule voie d'effacement. |
| Nouvelle sauvegarde après refus, `:120-121` | La raison, plus précise qu'avant. |
| Vérification de `saveError`, `:129` | Équivalent fidèle de « Refused before it ever reached the store ». |
| `archive`, `:142-144` | Rejet après libération, dernier état confirmé, et fichiers de l'hôte encore refusés tant qu'il ne les a pas réécrits (le comportement vérifié par `tests/session-durable.test.cjs:710`). |
| `seal`, `:151-152` | La garantie du scellement. |
| Façade, `runtime/session-runtime.cjs:224-228` | Les contrats de `close`, `archive` et `seal`. |

J'ai relu chacun contre le code : tous sont exacts.

## Le nouveau constat

### `runtime/session-lifecycle.cjs:1` et `:55-63` (hors périmètre)

C'est la réserve n° 3 de la relecture 1, toujours valable. `CLOSE_ERROR_MAX_CHARS = 200` et la mise en forme `étape : message` reprennent `said` et `attempt` de `runtime/session-closing.cjs`. Le standard « une constante vit à un seul endroit » n'est donc pas tenu.

Ce n'est pas un défaut de ce ticket : la duplication existait déjà et le ticket interdit de modifier `session-closing.cjs`.

**Ce qui est attendu :** donner plus tard un seul emplacement à cette borne et à cette mise en forme. À garder en réserve, comme l'indique déjà `ecarts.md`.

## Régressions dans le code changé

Je n'en ai trouvé aucune.
- **Code de production :** la correction n'ajoute que des commentaires dans `runtime/session-lifecycle.cjs` et `runtime/session-runtime.cjs`. Aucune instruction ne change.
- **ADR 0020 :** seule la phrase des tailles change, 292 et 185 lignes. Ces chiffres correspondent aux fichiers que j'ai lus, et plus aucun ancien chiffre ne traîne dans l'ADR.
- **Test :** le test des scellements est maintenant une boucle à l'intérieur d'un seul test. Le fichier compte toujours 15 tests, et l'assertion d'ordre des scellements, faite de façon synchrone (l. 408), est conservée.

## Critères d'acceptation

- **Critère 4 :** passe de « tenu sur le code, preuve partielle » à **tenu**, puisque l'attente du scellement des vecteurs est désormais prouvée.
- **Critère 5 :** toujours tenu. Le journal donne la nouvelle mesure : 417 → 292 lignes, plus 185 lignes pour le module.
- **Critère 6 :** toujours tenu.
  - Le seul fichier sous `tests/` dans `revue-2.fichiers` est `tests/session-lifecycle.test.cjs`.
  - Les résultats viennent des journaux : `correction-1-regression.log` 134/134, `correction-1-lifecycle-green.log` 15/15, `correction-1-check-full.log` vert avec 1 343/1 343 tests JS.
- **Critères 1 à 3 :** la correction ne les touche pas. Ils restent tenus comme dans la relecture 1.

**Périmètre :** l'interdiff ne touche que le module, la façade, l'ADR 0020 et le nouveau test. Tout est dans le ticket.

## Écarts et constats contestés

- **Écarts :** `ecarts.md` n'en déclare aucun. Sa section « Relecture 1 » classe le constat 3 en réserve hors périmètre, ce qui correspond à mon classement.
- **Constats contestés :** aucun.

## Remarque, non comptée

Dans l'objet rendu par la façade, les nouveaux commentaires en français (l. 224-228) suivent des commentaires en anglais (l. 210-221). Aucune règle de `docs/standards.md` ni de `CLAUDE.md` ne fixe la langue des commentaires, et le dépôt mélange déjà les deux (par exemple `core/session.cjs:84` et `adapters/codex-rpc.cjs:101`). Je ne le compte donc pas comme un constat.

## Ce que je n'ai pas pu vérifier

Je n'avais pas de shell : je n'ai lancé ni les tests, ni les mutations, ni `check`, ni `wc -l`.
- Les résultats et les mutations viennent des journaux conservés dans `.harness-state/tickets/T173/`.
- Les tailles de fichiers viennent de ma lecture des fichiers.
- Que `close()` se termine bien avant la macrotâche est un raisonnement, que les quatre journaux de mutation en échec confirment.