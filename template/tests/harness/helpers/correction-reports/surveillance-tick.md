VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 1 hors périmètre
NON CORRIGÉS : 0

## Constats du rapport précédent

### Constat 1 (`mineur`) : corrigé

**Où :** `tests/surveillance-runtime.test.cjs:116`, qui servait de preuve pour `runtime/surveillance-runtime.cjs:165`.

**Rappel :** le premier test passait aussi sans le `catch` de `publish`. Dans ce test, l'exception partait de `failed()` et finissait absorbée par le `.catch(() => {})` de `write()`.

**Preuve de la correction :**

- **Test discriminant.** Le nouveau test (`tests/surveillance-runtime.test.cjs:153-178`) fait lever le callback hôte dès que `state.enabled` est vrai. Il exerce donc la publication appelée par le cœur : `Surveillance.start()` → `observe()`/`emit()` → `onChange` du runtime → `publish`.
- **Effet du `catch` sans lui.** `Surveillance.emit()` (`core/surveillance.cjs:916`) intercepte l'exception et appelle `fail()`. Le message arrive alors dans `snapshot().error`. L'assertion `runtime.snapshot().error === null` (l. 165) dépend donc directement du `catch` local.
- **Mutation relue.** `mutate-publication.cjs` retire en mémoire uniquement le bloc `try { onChange(shown); } catch { … }`, en vérifiant qu'il n'y a qu'une seule correspondance. La regex paresseuse s'arrête bien au `}` indenté de quatre espaces, puisque les commentaires le sont de six. Aucun fichier n'est modifié.
- **Rouge observé.** `publication-mutation-red.log` montre l'échec attendu à la l. 165 : `'publication refusée'` au lieu de `null`.
- **Vert observé.** `publication-green.log` : 2/2 avec le module normal.
- **Suite des assertions.** Elles vérifient que la détection et la vérification ont lieu (`agent.calls.detect/verify === 1`, compteur public de l'agent simulé). Elles vérifient aussi que le dernier enregistrement contient la session, la revendication `sourced` et `error: null`. Avec une horloge fixe à 0, ce dernier enregistrement vient bien de `flush()`.
- **Documentation.** Le commentaire du `catch` (l. 168) et la réserve du journal disent maintenant que ce `catch` cache l'échec au diagnostic du cœur. Ils précisent aussi que le premier test n'isole pas ce `catch`. C'est exact à la lecture de `write()` (l. 207-212).
- **Premier test intact.** `revue-2.interdiff` ne modifie aucune de ses assertions.

### Constat 2 (`hors périmètre`) : nommé dans la réserve, défaut maintenu en réserve

- La réserve « Tick partiel et sans diagnostic » du journal indique maintenant que `app/main.cjs:184` (`setInterval(() => surveillance.tick(), 1000)`) n'a aucune garde.
- Elle précise que l'exception y remonte au processus principal Electron. Elle limite le comportement conservé au seul hôte headless et demande que le futur contrat de reprise traite cet écart.
- J'ai vérifié la ligne : `app/main.cjs:184` est inchangée et sans garde.
- Le défaut lui-même n'est pas corrigé, et ce ticket ne l'autorise pas. Je le garde donc comme seul constat `hors périmètre`, à reporter en réserve.

## Constat restant

### `app/main.cjs:184` : `hors périmètre`

- **Ce qui ne va pas :** le tick de surveillance de l'hôte Mac n'a aucune protection. Une exception du cœur y devient une exception non interceptée du processus principal. L'hôte headless, lui, l'absorbe.
- **Attendu :** le ticket qui définira le contrat de reprise d'un tick partiel traite les deux hôtes de la même façon. Ce n'est pas un `catch` vide, donc rien à faire dans T177.

## Régressions dans le code de la correction

- **Code de production :** la correction ajoute une seule ligne, un commentaire dans le `catch` de `publish`. Le comportement ne change pas.
- **Test ajouté :**
  - il appelle la fabrique par son API (`createSurveillanceRuntime`, `start`, `observe`, `flush`, `snapshot`) ;
  - les attentes sont bornées par `until` ;
  - il est fermé par `t.after(() => runtime.close())`, qui publie `enabled: false` sans lever ;
  - le nom est en anglais et l'erreur provoquée porte un `code`.
- **Résultats rapportés :** `check-full-correction-1.log` indique 1 400/1 400 tests JS et Python OK. `cas_de_test` passe de 1208 à 1213 (cinq ajouts au total) et `catch_vides_prod` de 19 à 6. Aucun test n'est supprimé ni assoupli dans l'interdiff.

## Écarts et contestations

- `ecarts.md` ne déclare aucun écart, ni pour la tentative initiale ni pour cette correction. Je n'en trouve pas non plus : il n'y a rien à trancher.
- Le fichier ne contient aucune contestation d'un constat de la relecture 1.

## Ce que je n'ai pas vérifié

- **Aucun contrôle relancé.** Je n'avais pas de shell : ni `node scripts/check.mjs`, ni le test sous mutation, ni le test normal. Le rouge, le vert et les contrôles complets viennent des journaux `publication-mutation-red.log`, `publication-green.log` et `check-full-correction-1.log`. Ils sont cohérents avec ma lecture du code et du script de mutation, mais je ne les ai pas observés moi-même.
- **Journal du ticket hors diff.** Le fichier du ticket n'apparaît pas dans `revue-2.fichiers`. Je l'ai lu dans l'arbre de travail.