# Standards de code

Règles courtes, chacune avec la façon dont elle est vérifiée. Une règle sans vérification automatique
est relue par le rôle `relecteur`. Le contrôle unique est `node scripts/check.mjs` ; ce qui est propre
au projet (dossiers, suites de tests, mesures) se règle dans `harness.config.mjs`.

<!-- Gabarit installé par evolutive-harness, puis propre au projet : --update n'y touche plus. Les
     sections Lisibilité, Erreurs, Tests et Le cliquet décrivent ce que le noyau vérifie ; complète
     Architecture et ajoute les règles du projet. -->

## Lisibilité

| Règle | Vérification |
| --- | --- |
| Une instruction par ligne ; aucune ligne de plus de 160 caractères (`maxLineLength`) | `check` : refus sur les lignes ajoutées, cliquet sur le total |
| Un fichier, une responsabilité ; au-delà de 400 lignes utiles, se demander ce qu'on peut extraire | relecture |
| Une fonction fait une chose ; au-delà de 80 lignes ou d'une complexité de 15, la découper | relecture |
| Pas de ternaires imbriqués | relecture |
| Un nom dit ce que la chose fait ; aucune référence à un ticket ou à un chantier dans le code | relecture ; `check` pour les noms de fichiers de test |
| Les constantes (délais, tailles, seuils) portent un nom et vivent à un seul endroit | relecture |
| Les commentaires disent pourquoi, pas quoi | relecture |

## Architecture

| Règle | Vérification |
| --- | --- |
| <Exemple : le domaine n'importe rien hors de lui-même et n'accède ni au disque ni au réseau> | <un test d'architecture, ou relecture> |
| Les dépendances externes (horloge, minuteries, disque, réseau, fournisseurs) sont injectées | relecture |
| <Exemple : les variables d'environnement se lisent dans un seul module de configuration> | <cliquet `process_env_hors_config`, déclaré dans `harness.config.mjs`> |

## Erreurs

| Règle | Vérification |
| --- | --- |
| Pas de `catch` vide : traiter l'erreur, ou la laisser passer avec un commentaire qui dit pourquoi | `check` : refus sur les ajouts dans le code de production, cliquet sur le total |
| Une erreur s'identifie par un code stable, pas par le texte de son message | relecture |
| Un message interne (chemin, sortie d'un outil) ne part pas vers un client | relecture |

## Tests

| Règle | Vérification |
| --- | --- |
| Un test vérifie un comportement par une frontière publique | relecture |
| Aucun test ne compare le texte du code source (les gardes d'architecture mises à part) | relecture |
| Un fichier de test porte le nom d'un module ou d'un comportement | `check` : refus à la création, cliquet `tests_nommes_par_chantier` |
| Temps, réseau, disque et fournisseurs sont maîtrisés, pas attendus | relecture ; méthode dans la skill `tests` |
| Le nombre de cas de test ne baisse pas | cliquet `cas_de_test` |
| On ne relance pas un test instable jusqu'à ce qu'il passe | règle de travail |

## Le cliquet

`scripts/quality/baseline.json` contient le plancher de chaque mesure. Une mesure ne peut pas se
dégrader ; quand un ticket l'améliore, la boucle resserre le plancher dans le même commit. Le plancher
ne se relâche jamais à la main pour faire passer un contrôle.

Mesures du noyau : `lignes_longues_prod`, `lignes_longues_tests`, `catch_vides_prod`,
`tests_nommes_par_chantier`, `cas_de_test`. Une mesure propre au projet se déclare dans
`harness.config.mjs` (`measures`), puis entre au plancher par `node scripts/quality/ratchet.mjs --tighten`.
Une règle relue qui revient souvent en relecture gagne à devenir une mesure : c'est ainsi que le
harnais se resserre avec le projet.
