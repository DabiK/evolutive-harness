VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre
NON CORRIGÉS : 0

## Constats

### 1. Fixture de gate restante dans le test du contrôleur (hors périmètre, réserve reconduite)

**Où :** `tests/test_tv_control.py:167-186`.

**Ce qui ne va pas.** `test_startup_and_shutdown_launch_no_background_work` écrit encore `tvlens-ambient-gate.json` et `ambient.json`, règle `TVLENS_AMBIENT_RUN`, puis vérifie que le contrôleur ne modifie pas le gate. Le gate est désormais retiré de la capture, donc ce test d'absence n'a plus d'objet. Ni T181 ni T182 ne le prévoient.

**Attendu.** Le traiter dans un ticket ultérieur. La réserve figure déjà dans `reste` de `verdict.json`, et le fichier n'a pas changé (`git diff --exit-code -- tests/test_tv_control.py` rend 0, consigné dans `correction-1-static.log`).

## Constats de la relecture 1

**Constat 1, commentaires génériques perdus (mineur) : corrigé.** J'ai comparé ligne par ligne `revue-2.interdiff` et l'état actuel avec l'original supprimé (`revue-2.diff`, lignes 167, 290, 313-345, 515 et 581).

- **Docstring du cas du panneau** (`tests/test_tv_capture.py:268-275`). L'incident est rétabli : 2 blocs sur 10 en 85 s, puis 3 sur 5. Sont aussi rétablis le rectangle 2560×1440 à x=640, le bloc de 8 s perdu avec son audio et ses trois images valides, et le refus sur changement de contexte. Seule la mention du gate tombe (« as for a frame withheld under a card »).
  - La traduction omet que l'ancien refus portait la cause `geometryChanged`. Cette cause reste vérifiée à la ligne 304, et la perte est trop faible pour un constat.
- **Jeux de lectures** (`:283`). « Deux lectures par image, avant puis après la prise ; la dernière réponse fournie se répète. » C'est exact d'après l'en-tête du faux `luna-send` (« last one repeats »).
- **Commentaires des étapes du cas du panneau** : ouverture pendant la deuxième prise (`:294`), rectangle réel par image (`:299`), bloc sans image compté avec sa cause (`:302`) et contexte vidéo distinct d'un déplacement (`:305-306`). Tous sont rétablis.
- **Autres commentaires des tests** : `Server.hold` (`:49`), et l'arrêt pendant le démarrage (`:233`) dont l'original était à la ligne 290 du fichier supprimé. Les deux sont rétablis.
- **Commentaires de production.**
  - Ligne 38 de `tv/capture.py` : « VIDEO ne capture que le plan vidéo ; ce choix reste à valider sur la TV ». La partie générique est gardée, sans le gate.
  - Ligne 140 de `tv/capture.py` : la cause explicite d'un bloc dont toutes les prises traversent un déplacement. Ce commentaire est placé sur la branche `elif moved and not frames`, qu'il explique.

**Constat 2, variable `report` jamais lue (mineur) : corrigé.** Ligne 191, `self.run_capture(server)` est appelé sans affectation. Les quatre assertions du cas n'ont pas changé (lignes 195-198).

**Constat 3 (hors périmètre)** : reconduit plus haut comme réserve. Il n'entre pas dans le compte des non corrigés.

## Régressions dans le code changé par la correction

- **`tv/capture.py`.** La correction n'ajoute que deux lignes de commentaire.
  - Le commentaire de la ligne 140 est placé entre un `if` et son `elif`, au niveau d'indentation de l'`elif`. Python l'accepte : un commentaire ne produit ni INDENT ni DEDENT.
  - La logique `if/elif` est inchangée depuis la relecture 1, qui l'avait jugée équivalente à l'ancien ternaire, sans `overlayVisible`.
- **`tests/test_tv_capture.py`.** La correction ne touche que des commentaires, une docstring et le retrait de l'affectation. Aucune assertion, aucun titre et aucun nombre de cas ne change : il reste 9 cas, et les numéros de ligne cités dans l'inventaire du journal (149, 188, 200, 212, 222, 250, 267, 314) correspondent au fichier actuel.
- **Standards.** Aucune ligne ajoutée ne dépasse 160 caractères et aucune ne référence de ticket. Les commentaires disent pourquoi. Le français est conforme à la consigne de langue (seuls identifiants, noms de tests et commits sont en anglais).

## Critères d'acceptation (rappel, sans changement depuis la relecture 1)

Les cinq critères restent tenus. La correction ne touche ni au comportement, ni aux assertions, ni au comptage.

D'après les journaux de reprise :
- capture : 9 tests OK (`correction-1-capture.log`) ;
- contrôle et transport : 13 tests OK ;
- `check.mjs` complet vert, avec 1430 tests JS et 22 tests Python (`correction-1-check-full.log`) ;
- la recherche `rg` des neuf symboles rend 1 ;
- M = P = 1242, n = 0 ;
- `git diff --exit-code -- scripts/quality/baseline.json` rend 0.

## Écarts et contestations

- **Pas d'écart déclaré.** La section « Reprise après relecture 1 » d'`ecarts.md` dit qu'aucun rouge n'a été fabriqué pour une correction de lisibilité, et que les tests existants ont tourné avant et après. Aucun critère n'exige de rouge pour une correction sans changement de comportement : ce n'est donc pas un écart, et la démarche est juste.
- Je n'ai trouvé aucun écart non déclaré.
- Il n'y a aucune contestation à trancher.

## Non vérifié

Je n'ai lancé aucun test ni aucune commande : je n'ai pas de shell. Les résultats d'exécution ci-dessus viennent des journaux de `.harness-state/tickets/T181/`, pas d'une observation directe.