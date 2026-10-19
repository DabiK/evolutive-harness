VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre
NON CORRIGÉS : 0

Les trois constats mineurs de la relecture 1 sont corrigés. La correction ne crée aucune régression. Deux réserves hors périmètre restent ouvertes, déjà notées par la relecture 1.

## Les trois constats de la relecture 1

**Constat 1, `tests/state-views.test.cjs:194-198` avec `runtime/headless-runtime.cjs:303` et `:307` : corrigé.**
- **Dans la fonction pure :** `overlayView` décide maintenant elle-même de l'absence de session. Elle applique `sessionId ?? null` et `elapsedMs ?? null` (`runtime/state-views.cjs:316` et `:320`).
- **Dans l'hôte :** il ne fait plus ce choix. Il transmet `this.session?.id` et `watch?.now()` (`headless-runtime.cjs:303` et `:307`). L'heure arrive toujours en paramètre, et le module ne lit pas l'horloge.
- **Dans le test :** il transmet `undefined` pour ces deux champs et exige `null` dans le résultat (`tests/state-views.test.cjs:195-198` et `:205-218`). Il échouerait si ce choix disparaissait.
- **Preuve :** `correction-overlay-red.log` montre l'échec attendu avant la correction (`sessionId: undefined` et `elapsedMs: undefined` au lieu de `null`), sur une assertion et non sur un import. `correction-overlay-green.log` montre 5 tests verts après.

**Constat 2, `runtime/state-views.cjs:321` : corrigé.** Le commentaire d'origine est revenu, mot pour mot, à la ligne 322 : « How the registry is kept: the ambient display tells a restoration from a session without results. » C'est exactement la ligne retirée de l'hôte.

**Constat 3, `runtime/state-views.cjs:37` : corrigé.** Le commentaire sur `refusal` est revenu, mot pour mot, au-dessus du constructeur (ligne 37) : « The transport turns `status` into the HTTP status and `code` into a reason a client can act on. »

## Régressions dans le code de la correction

- **`this.session?.id || null` devenu `this.session?.id` puis `?? null` :** les deux formes ne diffèrent que pour un identifiant vide ou valant zéro. Ce cas n'existe pas :
  - une session neuve reçoit un `randomUUID()` (`headless-runtime.cjs:366`) ;
  - une archive ne s'ouvre qu'après `library.dir(id)`, qui refuse tout identifiant hors de `SESSION_ID` (`adapters/session-library.cjs:67-68`), en amont d'`open` et de `resume`.
- **`watch ? watch.now() : null` devenu `watch?.now()` puis `?? null` :** les deux formes ne diffèrent que si `now()` rend `null` ou `undefined`. Or `SessionClock.now()` rend toujours un nombre (`core/session-clock.cjs:4`).
- **Bilan :** la réponse de `/v1/overlay` est identique, au champ près.
- **Ce qui ne change pas :**
  - `derive()` garde sa propre clé de mémoïsation `this.session?.id || null` dans l'hôte, ce que le ticket demande ;
  - le nombre de lignes de l'hôte reste 860, le critère 3 tient donc toujours ;
  - les nouvelles lignes ne contiennent ni `process.`, ni `setTimeout`, ni `setInterval`, ni `Date.now`, le critère 4 tient donc toujours.
- **Standards :** les commentaires rétablis disent pourquoi et sont en anglais, comme le reste de `runtime/`. Ils font moins de 160 caractères, et le format est vert.

## Critères d'acceptation après la correction

- **Critère 1.4 :** il est maintenant tenu dans son intention, pas seulement à la lettre (voir le constat 1 ci-dessus).
- **Critères 2 à 5 :** inchangés depuis la relecture 1. La correction ne touche ni `PANEL_SEGMENTS`, ni les fichiers sous `tests/` déjà existants, ni `server/http.cjs`.
- **Critère 6 :** `correction-check-full.log` est vert. Il compte 1074 tests JS sur 92 fichiers et 84 tests Python OK (1 ignoré). Les règles, le format et le cliquet sont verts. Le lint n'a pas été lancé, faute d'ESLint configuré.

**Je n'ai rien relancé moi-même :** je n'avais pas d'outil pour exécuter des commandes. Les résultats d'exécution viennent des journaux. Le code, je l'ai lu sur le disque, et il correspond au diff relu.

## Réserves hors périmètre, reprises de la relecture 1

**1. `runtime/state-views.cjs:37-38` (hors périmètre)**
- **Problème :** `refusal` est un constructeur d'erreur générique. Il sert aussi aux refus de l'hôte qui ne concernent pas les vues, et il vit pourtant dans le module des vues.
- **Suite possible :** un module d'erreurs de transport dédié, que le ticket ne prévoit pas.

**2. `runtime/state-views.cjs:285` et la vue `snapshot` de `runtime/headless-runtime.cjs` (hors périmètre)**
- **Problème :** la langue par défaut `"fr"` est écrite à deux endroits. Les standards veulent qu'une constante vive à un seul endroit.
- **Pourquoi hors périmètre :** `snapshot` reste dans l'hôte, comme le ticket le prévoit.

## Écarts déclarés et constats contestés

- **Écart accepté, `refusal` déplacé dans le module (déclaré dans `ecarts.md`) :** même décision qu'à la relecture 1, et pour la même raison. `surveillanceHistory` et `surveillanceDetail`, que le ticket ordonne de déplacer, ont besoin de `refusal`. Le laisser dans l'hôte aurait obligé à le recopier. Le problème de cohésion reste en réserve 1.
- **Contestations :** aucun constat n'a été contesté, et aucun nouvel écart n'a été déclaré dans la reprise.