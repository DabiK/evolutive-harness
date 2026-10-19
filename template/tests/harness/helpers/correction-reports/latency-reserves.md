VERDICT : accepté
CONSTATS : 0 bloquant, 0 mineur, 2 hors périmètre
NON CORRIGÉS : 0

Les deux constats à corriger de la relecture 2 sont corrigés, et je n'ai trouvé aucune régression dans le code touché par la correction. Il ne reste que deux réserves hors périmètre, déjà connues. Je n'ai rien exécuté moi-même : je me fonde sur la lecture du code et sur les journaux (détail à la fin).

## Suivi des constats de la relecture 2

**Constat 1 (bloquant), faux refus de transport : corrigé.**
- **État réel au premier polling.** Le conducteur appelle maintenant `session.emit()` avant `views.tv.start()` (`scripts/latency-scenario.cjs:158-159`). C'est la vraie publication de `WatchSession` (`core/session.cjs:506`) qui remplit `c.latest`. Dans `revision-report-one.json`, les trois cas commencent par `server.published` (publication 1). Ensuite viennent `client.requested` avec `publicationId: 1`, puis une vraie réception et une vraie application TV à 70015. Aucun `transport.refused` dans le fichier.
- **`transport.refused` réservé au refus simulé.** `onError` (`scripts/latency-views.cjs:227-237`) n'enregistre l'événement que pour le code `SIMULATED_TRANSPORT_REFUSAL`. Ce code est défini une seule fois, dans `scripts/latency-fixture.cjs:24`. Toute autre exception est conservée (`c.failure`, la première seulement), puis relancée par `assertHealthy()` après chaque avance du conducteur (`scripts/latency-scenario.cjs:49-52`). Le conducteur échoue donc avec la cause d'origine, après la libération qui s'exécute dans son `finally`.
- **Les nouveaux tests échoueraient si le comportement disparaissait.**
  - Le test des cas nominaux était rouge sur le faux refus (`revision-initial-state-red.log`). Sans l'instantané initial, la `TypeError` passerait par `assertHealthy` et ferait échouer `measureLatency()`.
  - La mutation qui requalifie toute exception en refus fait échouer les deux tests d'erreur (`revision-mutation-misclassified-error.log`, sortie 1).
  - Le refus explicite (`refuse: "transport"`) produit exactement un événement avec son code, précédé d'une requête TV, et un bilan de nettoyage nul.
  - J'ai vérifié dans `PollPlan.read` (`tv/app/chat-model.js:254-272`) qu'une erreur sans `status` n'est pas prise pour un refus de vue : elle est relancée vers `onError`.
- Les trois éléments attendus par la relecture 2 sont donc couverts.

**Constat 2 (mineur), sonde de libération sans publication : corrigé.**
- `holdLate()` et `probeLate()` ne font rien sans `c.latest` (`scripts/latency-views.cjs:332-353`).
- `env.release()` s'exécute maintenant dans un `finally` (`scripts/latency-scenario.cjs:96-120`).
- **Libération sans `run()`.** Le test « released before running » était rouge sur `TypeError … reading 'session'` (`revision-empty-release-red.log`). Il exige maintenant :
  - aucun rejet ;
  - un bilan nul ;
  - une seconde libération qui renvoie le même bilan (idempotence) ;
  - aucun événement.
- **Échec précoce.** Le test rouge sur `armed: 1` (`revision-early-failure-red.log`) vérifie que l'erreur d'origine remonte telle quelle et qu'aucune minuterie ne reste armée. Ce test passe par le chemin où une publication existe. Le test précédent couvre le chemin sans publication.

## Régressions dans le code changé par la correction

- **Nouvel ordre de libération** : `session.close()`, puis annulation des attentes, puis `capture.release()`. Je l'ai vérifié contre le produit :
  - `session.stop()` sur une session fermée ne lève rien, car `emit` ne fait rien après fermeture (`core/session.cjs:435`, `:506`).
  - Une ingestion rejetée par une attente annulée est absorbée par `submit().catch(→ onError)` (`app/recording.js:93`). En libération, ce `onError` est neutralisé (`app/ui/capture-controller.mjs:128`).
  - Le rejet n'atteint donc pas `capture.release()` et ne masque pas l'erreur d'origine.
- **Annulation des livraisons Mac et des réponses TV en vol.** Seules les minuteries du réseau simulé par le banc sont annulées. Celles de `state-delivery` et du polling restent mesurées par `armed`. Les publications tardives restent comptées dans `lateEvents`, car `record("server.published")` est appelé avant `views.publish`. La mutation qui retire `c.poll.stop()` reste détectée (`revision-mutation-stop.log` : `armed: 1`, `lateApplications: 1`, `lateEvents: 2`).
- **Ordre d'adoption dans `onReceive`.** Le banc adopte `c.held` après le dessin, alors que `tv/app/companion.js:571-573` l'adopte avant. La différence ne joue que sur un chemin d'échec, où le scénario est de toute façon rejeté. Les mesures nominales ne changent pas. Ce n'est pas un constat.
- **Effet sur la trace.** La publication initiale ne change pas le calcul de la trace : `latency-trace.cjs` sélectionne les publications par contenu et par `closedAtMs`, jamais par rang.
- **Tests existants.** Aucun test n'est supprimé ni assoupli. L'interdiff ajoute seulement six tests en fin de fichier, et le cliquet `cas_de_test` passe de 1305 à 1330.
- **Standards.** Le code d'erreur est stable et nommé à un seul endroit. Le contrôle complet est vert sur les règles, le format, le lint, le gel et le cliquet. Le code ne mentionne aucun ticket.
- **Limite repérée, non comptée.** Une exception TV qui surviendrait pendant `env.clock.advance(0)` de la libération, avant `views.release()`, poserait `c.failed` sans jamais remonter. Avec `deliveryMs > 0`, ce qui est le cas de toutes les configurations testées et de la commande, aucune réponse TV ne peut se résoudre à ce moment-là. Je ne le compte pas.

## Constats

### 1. `tests/capture-display-latency.test.cjs:104-122` — hors périmètre (réserve maintenue)
- **Problème.** `deliveryMs: 65` et l'écart attendu `50` reposent toujours, sans le dire, sur `DEFAULT_DELAYS.deliveryMs = 15`. La correction n'a pas touché ce code.
- **Attendu :** écrire `DEFAULT_DELAYS.deliveryMs + addedDeliveryMs`, comme dans le test de réponse.

### 2. `app/main.cjs:147-154` et `runtime/headless-runtime.cjs:120-131` — hors périmètre (réserve maintenue)
- **Problème.** La règle « question occupée → `asking` » existe en deux exemplaires dans les hôtes, et en troisième dans le banc (`scripts/latency-model.cjs:93-103`).
- **Attendu :** l'extraire dans `runtime/` par un ticket dédié.

## Écarts et contestations

- **`ecarts.md`, section « Relecture 2 » :** aucun écart à un critère et aucune contestation à trancher. La note sur `DeepAsk` exécuté sans modification dans une VM avec minuteries maîtrisées reste un choix de composition, accepté depuis la relecture 1 : le code produit est inchangé.
- **Écart non déclaré découvert :** aucun. Le faux refus qui contredisait le critère 2 a disparu.

## Périmètre

Les fichiers sont ceux de la tentative précédente (`revue-3.fichiers`). Aucun fichier du produit ni du harnais n'est modifié. Ce qui a été ajouté est demandé par la relecture 2 et documenté dans le README et l'ADR 0028 :
- le réglage `refuse: "transport"` ;
- l'injection `{ createViews }` dans `createScenario` ;
- l'annulation des attentes.

## Ce que je n'ai pas vérifié moi-même

Je n'avais pas de shell : je n'ai lancé ni les tests, ni `node scripts/measure-latency.cjs`, ni `node scripts/check.mjs`, ni le `cmp` des deux JSON. Je me suis appuyé sur les journaux suivants :
- `revision-check-full.log` : contrôle vert, 1 535 tests JS et 22 tests Python ;
- `revision-related-tests.log` : 223 tests réussis, aucun échec ;
- `revision-check-changed.log` : vert ;
- les journaux rouges et de mutation cités plus haut ;
- `revision-report-one.json` pour le début des traces.

L'identité octet pour octet des deux JSON frais repose sur le journal du ticket, pas sur une comparaison que j'aurais faite.