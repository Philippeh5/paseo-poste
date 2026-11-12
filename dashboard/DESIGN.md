# Poste de commande — cahier de design (v3)

Objet: un « bureau à distance » pour une flotte de terminaux et d'agents IA répartis sur deux machines
(mini-PC Windows, serveur Oracle Ubuntu). Usage: surveiller, lancer, déplacer, reprendre.
Public: une seule personne, qui veut voir d'un coup d'œil ce qui travaille et où, puis agir.

## Direction visuelle
Salle de contrôle sobre, pas un thème « hacker ». Fond graphite légèrement bleuté, texte clair, une seule
couleur d'accent (bleu glacier). L'état se lit par la forme: voyant (LED) rond, pastille, liseré à gauche de la
fenêtre; jamais seulement par la couleur du texte. Les couleurs sémantiques (vert/ambre/rouge) sont distinctes
de l'accent.

À éviter (ressemble à du design généré): crème + serif + terracotta, dégradé violet-bleu, Inter/Space Grotesk,
emojis comme marqueurs, coins arrondis identiques partout, rail coloré sur chaque carte.

### Jetons (à déclarer sur `:root`, thème sombre par défaut, thème clair redéfini)
Couleurs (noms stables, valeurs sombres / claires):
- `--sol` fond de page: `#0e1218` / `#eef1f5`
- `--panneau` surfaces (barre, rail, fenêtres): `#151b24` / `#ffffff`
- `--panneau-2` surfaces imbriquées: `#1b232f` / `#f4f6f9`
- `--trait` bordures: `#2a3442` / `#d5dbe4`
- `--texte` `#e6ebf2` / `#18202b`; `--texte-doux` `#98a4b5` / `#566274`
- `--accent` `#6cb6ff` / `#1f6fd1`; `--accent-doux` accent à 16 % d'opacité
- sémantique: `--ok` `#4cc38a` / `#17803d`; `--attention` `#e5a93b` / `#a15c00`; `--danger` `#f0686a` / `#c0262d`; `--inactif` `#6b778a` / `#8893a3`
Le thème suit `prefers-color-scheme`; un bouton le force (attribut `data-theme` sur `<html>`, mémorisé).
Zone terminal xterm: toujours fond `--sol` du thème courant avec les mêmes jetons (pas de noir fixe).

### Typographie
- Titres et noms de vue: **Bricolage Grotesque** (600). Texte d'interface: **IBM Plex Sans** (400/500/600).
- Données, chemins, identifiants, terminaux: **JetBrains Mono**.
- Chargement: Google Fonts avec `display=swap` et piles de repli système (l'interface doit rester lisible hors ligne).
- Échelle: 12 / 13 / 14 / 16 / 20 / 28 px. Libellés en capitales: 11 px, interlettrage 0.06em.
- Chiffres alignés en colonnes: `font-variant-numeric: tabular-nums`.

### Formes et espacements
Grille de 4 px. Rayons: 6 px (contrôles), 10 px (fenêtres). Pas de ombre sauf pour les fenêtres flottantes du
bureau. Focus clavier visible (anneau `--accent`). `prefers-reduced-motion` respecté.

## Structure de l'écran
```
┌ barre du haut ───────────────────────────────────────────────────────────────┐
│ nom · [Bureau|Tâches|Sessions|Chronologie|Machines|Boîte de réception] · ⌘K · Lancer · → Oracle · thème │
├ rail gauche ──┬ vue principale ────────────────────────────┬ tiroir droit ────┤
│ machines (LED)│                                            │ détail d'un agent │
│ projets       │                                            │ ou d'une tâche    │
└───────────────┴────────────────────────────────────────────┴───────────────────┘
```
- Le sélecteur de vue en haut est un contrôle segmenté, clavier (flèches) et lien d'ancre (`#bureau`, `#taches`…).
- Le rail liste les machines (LED: connecté vert, reconnexion ambre qui pulse, erreur rouge) puis les projets
  choisis. On y glisse un projet ou une machine vers le bureau pour ouvrir un terminal dedans.
- Le tiroir droit s'ouvre sur sélection d'un agent/une tâche et se ferme à `Échap`.
- Téléphone (≤ 720 px): rail replié en tiroir gauche, sélecteur de vue en barre basse, pas de défilement horizontal.

## Les six vues (A–F)
A. **Bureau** (priorité 1). Surface libre où l'on pose des fenêtres: terminal d'une machine/dossier, session d'agent
   (fil en direct), note. Glisser pour déplacer, poignée pour redimensionner, double-clic sur la barre de titre
   pour agrandir, bouton pour réduire dans un dock en bas. Aimantation à une grille de 8 px. Mises en page
   nommées (« Mon bureau », « Production ») enregistrées côté serveur et rechargeables; boutons « Ranger en
   grille » et « Grouper par machine ». Chaque fenêtre porte un liseré de la couleur d'état et le nom
   machine · dossier.
B. **Tâches** (priorité 2). Tableau à colonnes: À faire · En cours · À valider · Terminé. Carte: titre, projet,
   machine, moteur, dépendances. Glisser entre colonnes. Bouton « Démarrer » crée la session sur la machine et le
   moteur choisis; l'état de la session met la carte à jour (en cours → à valider).
C. **Sessions**. Arbre machine → projet → agent → sous-agents, avec statut, durée, fil en direct dans le tiroir.
D. **Chronologie**. Frise horizontale par machine: barres = périodes de travail d'un agent, marqueurs = demandes
   de permission, erreurs, reprises.
E. **Machines**. Une carte par machine: état, version, agents par statut, terminaux, quotas par fournisseur
   (barres), bouton « Transférer vers Oracle » sur la carte du mini-PC.
F. **Boîte de réception**. Messages Telegram/commandes entrants, approbations en attente, résumé des fins de tâche.
Les vues non encore construites affichent un état vide qui dit ce qui y apparaîtra.

## Contrôles transversaux
- **Lancer**: fenêtre modale existante (hôte, projet, type, moteur, modèle, mode, isolation) reprise dans les jetons.
- **Palette de commandes** (`Ctrl+K`): chercher une machine, un projet, un agent, une action.
- **Sélecteur de dossier**: navigateur de dossiers côté serveur pour la machine choisie (pas de boîte système).
- **Confirmations** intégrées à la page (jamais `confirm()`); les actions irréversibles (éteindre le mini-PC) exigent
  une confirmation à deux temps avec un texte qui dit ce qui va se passer.

## Critères de réussite visuels
- À 1280×720 et 390 px: aucun défilement horizontal de la page, texte lisible, contrastes WCAG AA dans les deux thèmes.
- Un agent en attente de permission se repère en moins d'une seconde (liseré ambre + pastille + compteur dans la barre).
- Les deux thèmes ont les mêmes rôles de couleur; aucun texte clair sur fond clair ni l'inverse.
