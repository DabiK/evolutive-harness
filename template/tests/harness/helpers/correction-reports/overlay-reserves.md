VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 4 hors périmètre
NON CORRIGÉS : 0

## Suivi des constats de `relecture-1.md`

**1. `tv/app/surveillance-view.js:572` — mineur : corrigé.**
- La table s'appelle désormais `countedSequences` (`:493`, `:533`, `:570-571`).
- La JSDoc annonce `onShown(card)`, première apparition de la carte dans la session, pour le compteur local (`:468`).
- Le commentaire dit pourquoi la carte n'est comptée qu'une fois : une carte réaffichée après une interruption ne doit pas incrémenter le compteur (`:572`).
- L'appel ne passe plus que la carte (`:573`).
- Plus aucune occurrence de `declared` ni de `onShown(card, …)` dans `tv/`. Le seul consommateur est `companion.js:743`, qui ne lit aucun argument : pas de régression.
- Un test le prouve : `tests/tv-paired-page.test.cjs:376`. Le rouge est consigné dans `correction-red-callback.log` : l'appel recevait encore `'11111111-…'` en second argument, et l'assertion `:401` échouait.

**2. `tv/app/surveillance-view.js:743-750` — mineur : corrigé.**
- Le ternaire imbriqué est remplacé par `if` / `else if` (`:743-748`). Les deux textes et la chaîne vide quand aucun cas ne s'applique sont identiques à avant.
- Le gel `no-nested-ternary` de `tv/app/surveillance-view.js` passe de 10 à 9 dans `eslint-suppressions.json:612`. Aucune autre ligne du gel ne change dans l'interdiff.
- `correction-check-full.log` montre « gel du lint » et « cliquet » au vert.

**3. `scripts/smoke-tv-end-to-end.mjs:177` — mineur : corrigé.**
- Le commentaire (`:176-177`) dit maintenant que les routes `/ambient` retirées gardent une réponse 404 et que le panneau ne les appelle plus. C'est ce que fait la ligne `:183` : `json(404, {})`.
- Ce changement entre dans le périmètre (« adapter seulement les mocks ambient des smokes partagés »).
- Le comportement du smoke est inchangé ; il n'a été contrôlé que par `node --check`.

## Code changé par la correction : régressions et nouveaux constats

- **Nouveau cas `tests/tv-paired-page.test.cjs:376-422`.**
  - Il passe par `TVLensSurveillance.Overlay`, la même API exportée qu'utilise `companion.js:729`, chargée depuis la vraie page dans le banc T185.
  - Le temps est injecté (`now`), et le test n'observe que le DOM (`overlay-card`) et les arguments du rappel.
  - Il échouerait dans trois cas :
    - un second argument revient dans le rappel (`:401`) ;
    - la carte est comptée deux fois après la pause (`:410`) ;
    - le compteur n'est plus remis à zéro à la session suivante (`:421`).
  - Ce n'est pas un cas de remplissage : le dédoublonnage après interruption et la remise à zéro par session n'étaient couverts par aucun test.
- **Cas existants.** L'interdiff ajoute seulement du code à la fin du fichier (`@@ -372,3 +372,51`). Les cas appairés déjà livrés sont inchangés. `tests/helpers/tv-page.cjs` n'apparaît pas dans le diff.
- **Critère 5.** P = 1270, n = 1, a = 2, M final = 1271, donc 1271 ≥ 1269. La ligne `cas_de_test` du plancher baisse exactement de 1. La correction ne touche pas `scripts/quality/baseline.json`.
- **Aucune nouvelle infraction aux standards** sur les lignes ajoutées : pas de ternaire imbriqué, lignes de moins de 160 caractères, commentaires qui disent pourquoi.
- **Remarque, non comptée.** Les nouveaux commentaires sont en français dans des fichiers commentés en anglais. La consigne « Langue » de `CLAUDE.md` ne classe pas les commentaires, et le ticket 134 l'a déjà lue comme imposant le français. Aucune règle écrite n'est donc enfreinte.

## Constats hors périmètre (réserves reportées, toujours présents)

**4. `tv/app/surveillance-overlay.js:286`** — hors périmètre
- `OverlayQueue.prototype.seen` n'a plus d'appelant en production.
- Le ticket et l'ADR 0017 imposent de conserver la file et ses tests.
- Attendu : le traiter avec le retrait différé de l'API overlay.

**5. `docs/README.md:13`** — hors périmètre
- L'index présente encore `lg-ambient.md` comme « Code livré, affichage désactivé par défaut ».
- Ce fichier ne figure pas parmi les cinq documents que le ticket énumère.
- Attendu : un ticket documentaire.

**6. `runtime/headless-runtime.cjs:344`, `runtime/state-views.cjs:322`, `tests/server-surveillance.test.cjs:126`** — hors périmètre
- Ces commentaires nomment encore l'affichage ambient comme consommateur de l'API overlay.
- Le ticket interdit de toucher la projection runtime.
- Attendu : les reprendre avec le retrait différé (ADR 0017).

**7. `tests/tv-paired-page.test.cjs:46` et `:58`** — hors périmètre
- Le mock `network()` répond encore 200 sur `/ambient`, et le premier cas appairé filtre ces appels.
- Le ticket impose de garder les cas appairés déjà livrés.
- L'absence d'appel est prouvée par le cas `:275`.

## Écarts et contestations

- `ecarts.md` déclare « aucun nouvel écart, aucune contestation des trois mineurs ». Il n'y a donc rien à trancher.
- Je n'ai découvert aucun écart non déclaré à un critère.

## Non vérifié

- Je n'ai lancé ni les tests ni `node scripts/check.mjs`. Les résultats repris ici viennent des journaux de correction et de la lecture du code et des diffs :
  - `correction-red-callback.log` : rouge observé ;
  - `correction-check-full.log` : 1 460 tests réussis, 0 échec, Python OK, `check` vert ;
  - `correction-test-diff.log` ;
  - `correction-prune-lint.log` : vide, ce qui est normal pour `--prune-suppressions`.
- `scripts/smoke-tv-end-to-end.mjs` n'a été contrôlé que par `node --check`. Le smoke navigateur n'a pas été exécuté ; le critère 7 ne l'exige pas.