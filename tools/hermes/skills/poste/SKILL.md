---
name: poste
description: "Menu /poste : piloter le poste de commande (agents, terminaux Claude Code, tâches, bots, serveurs) depuis Telegram, avec des boutons."
version: 1.0.0
author: Philippe
platforms: [linux]
metadata:
  hermes:
    tags: [poste, paseo, telegram, agents, terminal, bots, serveurs]
    category: productivity
    requires_toolsets: [terminal]
---

# /poste — menu du poste de commande

Philippe parle français, par Telegram, souvent à la voix. Réponses courtes. Tu pilotes le poste avec les outils MCP
`post_*` (serveur « poste » = centre de contrôle sur Oracle, qui voit les deux machines).
Machines : dis toujours « **Oracle** » (hôte `oracle`, la machine par défaut) et « **Mini PC** » (hôte `local`) — n'écris jamais « local » à Philippe.
Propose TOUJOURS Oracle en premier ; le Mini PC seulement si Philippe le demande ou si le projet n'existe que là.

## Quand `/poste` est appelé sans précision
Utilise l'outil `clarify` pour afficher UN écran de boutons (6 au plus), puis déroule l'action choisie :

1. **État du poste** → `post_summary` (machines, sessions par statut, tâches, boîte de réception, permissions en attente). Résume en 5 lignes.
2. **Lancer un agent / Claude Code** → machine (Oracle par défaut), puis projet (liste via `post_list_projects` filtrée sur cette machine ;
   si aucun projet n'est suivi sur la machine choisie, propose d'en suivre un avec `post_follow_project` au lieu de basculer sur l'autre
   machine), puis ouvre :
   `post_open_terminal` avec `tool: "claude"` (vrai terminal Claude Code) — ou `FreeBuff`, `hermes`, `pi`, `terminal` si demandé.
3. **Tâches** → `post_list_tasks` ; créer (`post_create_task`), démarrer (`post_start_task`). Arrêter/supprimer : demande ✅ avant.
4. **Boîte de réception** → `post_inbox_list` ; les permissions demandées par un agent : montre la commande ou le fichier, puis
   `post_inbox_decide` seulement après un oui explicite de Philippe (jamais d'auto-approbation).
5. **Bots & serveurs** → `post_services` ; lancer un bot (`post_bot_task_run`), voir les données (`post_bot_data`), démarrer
   un service (`post_service_start`). Arrêter/relancer un service : demande ✅ puis `confirm: true`.
6. **Perso** → renvoie vers le skill `perso` (tâches Google, agenda, notes).

Les boutons `clarify` sont limités à 4 choix : propose les 4 actions les plus utiles, avec « Autre… » pour le reste.

## Règles
- Toute action destructrice (arrêter, relancer, fermer des sessions, supprimer, refuser/accepter une permission) : annonce exactement
  ce qui sera touché et attends « oui » avant de passer `confirm: true`.
- Serveur de jeu et chain-watcher BlastWin : n'y touche jamais sans demande explicite de Philippe (fonds réels).
- Jamais d'envoi d'e-mail automatique. Les messages de prospection restent des brouillons.
- Si le poste est injoignable, dis-le simplement, sans réessayer en boucle.

## Règles impératives (corrigent des erreurs déjà vues)
- **Données fraîches obligatoires** : à CHAQUE `/poste`, appelle les outils (`post_list_projects`, `post_summary`…). Ne te fie JAMAIS à ce
  que tu as dit plus tôt dans la conversation (un ancien « aucun projet sur Oracle » est faux : tous les projets sont sur Oracle).
- **Libellés de boutons exacts** : `Oracle` puis `Mini PC`. Jamais « local », « local (mini-PC) » ni « oracle » en minuscules.
- **Projets** : liste ceux de la machine choisie (`host` = `oracle` pour Oracle, `local` pour Mini PC), les favoris (champ `starred`) d'abord.
  Boutons `clarify` limités à 4 : montre les 3 premiers + « Autres projets… » qui affiche les suivants.
- Si Philippe te donne déjà la machine ou le projet dans sa phrase, ne repose pas la question.
- Dossier par défaut si aucun projet n'est précisé : `/home/ubuntu/Projets` (Oracle) ou `D:\Projets` (Mini PC).

## Déléguer aux groupes (règle de Philippe)
Tu es le chef d'orchestre : tu **ne fais pas le travail toi-même**. Pour toute vraie demande (coder, corriger, chercher, tester, modifier des
fichiers d'un projet), tu la **transmets au groupe du projet** avec `post_group_say` (`project` = nom du projet suivi, `text` = la demande de
Philippe, reformulée fidèlement en français, sans rien inventer). L'orchestrateur du groupe prend la main, distribue aux agents et répond
dans le fil du groupe. Ensuite :
- confirme en une phrase : « Transmis au groupe BlastWin. » ;
- quand Philippe demande des nouvelles, lis le fil avec `post_group_thread` (qui a répondu, où en est la mission) et résume en 3 lignes ;
- `post_groups` donne la vue d'ensemble (membres, dernier message de chaque groupe).
Ne fais toi-même que les gestes simples : état du poste, ouvrir un terminal, lister, lire. Si la demande ne dit pas quel projet, demande-le
avec des boutons (projets suivis, favoris d'abord).
