---
name: ticket-codex
description: Traite un ticket avec Codex, tests d'abord, puis rend la main à la boucle pour la relecture Claude et l'intégration.
---

# Traiter un ticket avec Codex

Tu explores et implémentes toi-même. La boucle orchestre la relecture dans un processus Claude séparé.
Tu ne lances ni sous-agent ni relecteur, tu ne committes pas et tu ne pousses pas.

Dossier d'état : `.harness-state/tickets/<ID>/`, hors Git.

La boucle Codex tourne dans le dépôt approuvé par le propriétaire avec `codex`, puis `/hooks`.
L'approbation de `.codex/hooks.json` vit dans la config utilisateur et dépend du chemin absolu du
dépôt ; un worktree ou une copie demande sa propre approbation. La boucle conserve cette config,
neutralise ses extensions et ses serveurs MCP, puis exige le témoin de démarrage à chaque session.
Sans témoin, le refus « hooks Codex non chargés » indique les causes probables et le remède `/hooks`.
`hooks.json` reste figé : changer un script appelé conserve l'approbation ; changer la définition
d'un hook impose une nouvelle approbation du propriétaire. Ne contourne pas ce refus.

## 1. Cadrer et explorer

Lis `AGENTS.md` (lien vers `CLAUDE.md`), `docs/standards.md` et le ticket en entier.
Lis en entier le code cité, ses appelants, ses tests et les ADR concernant la zone.
Lis le journal, `git status`, `git diff` et les éventuels rapports d'échec avant une reprise.
Écris ton exploration dans le dossier d'état ; laisse un jalon dans le journal du ticket.

Si le code contredit le périmètre du ticket ou exige une décision du propriétaire, rends BLOQUÉ.
Avant toute implémentation, écris chaque écart prévu et sa raison dans `ecarts.md` du dossier d'état.
N'affaiblis jamais un critère ; un écart qui élargit le périmètre ou retire une preuve bloque le travail.

## 2. Implémenter, tests d'abord

Suis `.claude/skills/tests/SKILL.md` : un comportement à la fois, test rouge observé sur son assertion,
implémentation minimale, puis vert observé. Conserve les commandes et leurs sorties dans le dossier
d'état. Teste aux frontières publiques ; maîtrise disque, temps, réseau et fournisseurs.
Ne supprime ni n'assouplis un test pour passer. Respecte les autorisations du ticket (`harnais`,
`installe`, `supprime_tests`) et les restrictions explicites du propriétaire.

Un jalon par étape dans le journal : commande exacte et résultat réel. Rien au-dessus de `## Journal`
ne change. Si `adr: oui`, écris l'ADR au numéro suivant, avec `docs/adr/0000-gabarit.md`.

## 3. Reprendre après une relecture

Après une relecture « à corriger » ou « illisible », la boucle reprend la session de la tentative par
`codex exec resume <thread_id>`, avec les réglages du palier et un nouveau témoin de hooks vérifié.
La reprise conserve le contexte de développement. Si les options requises sont incompatibles,
si le témoin manque ou si la reprise échoue avant tout tour, la boucle lance une session neuve pour
la même correction et enregistre `reprise-impossible` avec sa raison. Cette session vérifie aussi son
témoin. Une tentative sur le palier suivant démarre toujours dans une session neuve.
La consigne nomme le ticket et le chemin du rapport `relecture-<n>.md` à corriger, et transmet son
contenu complet. Lis ce rapport, le ticket et son journal, les écarts, puis `git status` et `git diff`.
En repli sur une session neuve, relis aussi les consignes : le travail précédent est présent dans l'arbre.
Reprends ce travail et corrige chaque constat bloquant et mineur, tests d'abord. Une contestation se déclare
avec sa raison dans `ecarts.md` ; le relecteur suivant tranche. Garde dans `reste` uniquement tes propres
réserves. La boucle extrait les constats hors périmètre du rapport accepté du relecteur : ne les recopie
pas dans `reste` et ne modifie pas ses rapports. Mets le journal à jour et rends un nouveau verdict.
N'enregistre pas toi-même l'état relu et ne lance pas de relecteur : la boucle s'en charge après toi.

La première relecture d'une tentative reste complète. Les suivantes sont des relectures de
correction par un relecteur neuf, avec le rapport précédent et l'interdiff des deux états relus.
Il vérifie chaque ancien constat et les régressions dans le code changé. Un nouveau mineur sur du
code inchangé devient une réserve hors périmètre ; un bloquant reste possible partout.
La boucle autorise deux corrections au plus par tentative. Dès qu'une relecture de correction
compte un constat non corrigé dans `NON CORRIGÉS : <n>`, elle refuse la tentative et passe au palier
suivant sans nouvelle correction au même palier. Une ligne absente ou illisible vaut un constat
non corrigé. Même avec `NON CORRIGÉS : 0`, deux corrections refusées épuisent la tentative.

## 4. Conclure

Avant de rendre la main, lance `node scripts/check.mjs` en entier, puis écris ton verdict.
Un contrôle rouge se corrige avec son test avant de conclure ; ne déclare jamais un résultat non observé.

Écris toi-même `.harness-state/tickets/<ID>/verdict.json` :

```json
{
  "statut": "TERMINÉ",
  "resume": "ce qui est livré",
  "preuves": ["commande et résultat observé"],
  "reste": []
}
```

`TERMINÉ` signifie que les critères sont couverts par les preuves disponibles ; la relecture reste
la responsabilité de la boucle. `PARTIEL` indique le travail utile livré et ce qui manque.
`BLOQUÉ` nomme la décision sans laquelle avancer est impossible. Un fichier refusé par le bac à sable
reste manquant : ne contourne pas la protection et ne le déclare pas livré.
Tes réserves dans `reste` nomment tes propres constats hors périmètre, les écarts à trancher et les
vérifications manquantes. Les constats du relecteur sont transmis par la boucle depuis son rapport accepté.
La boucle conserve ton verdict, enregistre le changement, fait relire, puis décide de l'intégration.
