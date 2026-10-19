VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre
NON CORRIGÉS : 0

Le seul constat à corriger de la relecture 2 est corrigé. La correction ne touche que `tests/mac-ui.test.cjs`, dans le test de composition, et je n'y trouve ni régression ni nouveau constat. Les deux réserves hors périmètre de la relecture 2 restent valables.

## Constats

### 1. `app/recording.js:17-24` : hors périmètre (reporté de la relecture 2, constat 2)
**Problème.** La composition navigateur passe toujours un `env` explicite (`app/ui/browser-capture.mjs:28-35`). La valeur par défaut de `RollingRecorder` (les globaux et `window.tvlens.ingest`) ne sert donc plus en production. Le branchement de l'ingestion existe à deux endroits.

**Attendu.** Un ticket ultérieur retire cette valeur par défaut ou l'aligne. Ce ticket demande de conserver `recording.js` et ses scénarios.

### 2. `docs/adr/0018-un-controleur-injecte-possede-la-capture-du-mac.md:22`, `:82` : hors périmètre (reporté des relectures 1 et 2)
**Problème.** L'ADR cite toujours `openCapture` comme commande publique. Il mentionne aussi l'ancienne protection textuelle de `mac-ui`.

**Attendu.** Une mise à jour de l'ADR, dans un autre ticket : celui-ci est en `adr: non`.

## Constats de la relecture 2

1. **Corrigé (mineur)**, `app/ui/browser-capture.mjs:33-34` et `tests/mac-ui.test.cjs:1338-1665`. Les quatre points attendus sont tenus.
   1. **Durée utile.** `performance.now` passe par une variable `now`, mise à 1000 après les deux `observe` (`:1629`). L'origine vaut 0, l'intervalle mesure donc 1000 ms, au-dessus du seuil de 350 ms (`recording.js:83`).
   2. **Fin du passage par le contrôleur.** Le test appelle `controller.checkpoint()` (`:1630`). J'ai suivi le chemin dans le code :
      - `capture-controller.mjs:69` appelle `recorder.checkpoint`, puis `rotate` et `finish` ;
      - `finish` appelle `flushAudio` de façon synchrone (`capture-controller.mjs:263-275`), donc l'acquittement envoyé à `:1633` résout bien ce flush ;
      - le stub `MediaRecorder` émet maintenant `ondataavailable({ data: chunk })` avant `onstop` (`:1462-1465`), et `item.blobs` contient un fragment réel ;
      - `checkpoint` attend ensuite `pending`, donc l'ingestion est terminée à l'`await` de la ligne `:1634`.
   3. **Passage reçu par `bridge.ingest`.** Le test vérifie :
      - un seul appel (`:1635`) ;
      - `sessionId: "session"` ;
      - l'intervalle `[0, 1000]` ;
      - des images non vides, toutes à `atMs <= 1000` et avec la bonne `dataUrl` ;
      - `clip` en `Uint8Array`, égal en strict (`node:assert/strict`) aux octets du fragment ;
      - un seul `Blob` construit par la classe injectée, avec `{ type: "video/webm" }` et pour unique partie le fragment du recorder (`:1648-1651`).

      Après `release`, aucune deuxième ingestion et le second recorder est arrêté.
   4. **Mutations.** Trois journaux montrent chacun `fail 1` sur assertion, `0 !== 1` à `tests/mac-ui.test.cjs:1635` :
      - `correction-2-mutation-ingest.log` ;
      - `correction-2-mutation-blob.log` ;
      - `correction-2-mutation-wrong-route.log`.

      Par lecture, un remplacement de `environment.Blob` par le `Blob` global serait aussi rouge, à `:1648` (`blobs.length` vaudrait 0). Le vert revient ensuite (`correction-2-browser-green.log`, 1/1).

2. **Hors périmètre (relecture 2, constat 2)** : réserve maintenue, voir le constat 1 ci-dessus.
3. **Hors périmètre (relecture 2, constat 3)** : réserve maintenue, voir le constat 2 ci-dessus.

## Régressions cherchées dans le code de la correction
- **Production.** L'interdiff ne contient que `tests/mac-ui.test.cjs`. `browser-capture.mjs`, le contrôleur et le renderer sont ceux de la relecture 2.
- **Assertions antérieures du test.** Aucune n'est retirée ni assouplie. Les remplacements de stubs gardent leur comportement avant le checkpoint :
  - `ingest` enregistre ses appels et rend toujours `"moment-1"` ;
  - `now` vaut 0 jusqu'à `:1629` ;
  - `ClipBlobStub` hérite du vrai `Blob`.

  L'émission ajoutée de `ondataavailable` n'intervient qu'à l'arrêt d'un recorder, donc après les vérifications d'aperçu et de flush.
- **Nouvelle assertion `media.length === 2`.** Elle constate la rotation réelle de `RollingRecorder` après un checkpoint pendant une capture active. Elle est cohérente avec `recording.js:82`.
- **Standards.** Le temps et les minuteries sont simulés, rien n'est attendu en temps réel. La frontière testée est la fabrique publique de composition, et le passage est observé côté `bridge`. Aucune comparaison de texte source. D'après `correction-2-check-full.log`, le nombre de cas de test monte de 1117 à 1140.
- **Remarque, sans constat.** `:1631-1632` vérifie que le dernier message du worklet est un flush. Comme `randomUUID` rend toujours le même identifiant, ce message ne se distingue pas du flush précédent. Cette ligne pilote le test ; elle ne cherche pas à prouver le flush avant soumission. L'ingestion, elle, est bien prouvée.

## Écarts et contestations
- **Écart accepté, relecture 2** (`ecarts.md`, section « Relecture 2 ») : aucun critère n'est affaibli. Il complète le test de composition existant avec des dépendances de temps et de média simulées, et ne laisse aucun changement de production. C'est ce que montre l'interdiff.
- **Réserves maintenues** (`ecarts.md`, `recording.js` et ADR 0018) : d'accord, elles restent hors périmètre.
- Aucune contestation n'est déclarée.

## Ce que je n'ai pas pu vérifier
- **Tests non relancés.** Je n'ai relancé ni les tests, ni `node scripts/check.mjs`, ni les mutations : je n'ai que des outils de lecture. Les résultats viennent des journaux :
  - `correction-2-browser-green.log` : 1/1 vert ;
  - les trois journaux de mutation : `fail 1` chacun ;
  - `correction-2-mac-suites.log` : 127/127 ;
  - `correction-2-check-full.log` : « check : vert », 1312/1312 tests JS et 33 tests Python dont 1 ignoré.
- **Grep du critère 3.** Je l'ai refait sur `app/renderer.js` avec l'outil de recherche : aucune correspondance.
- **Hors ligne seulement.** La capture native Mac n'est pas exercée. Rien ne garantit que le navigateur attende la promesse de libération à sa fermeture ; le ticket ne le demande pas.