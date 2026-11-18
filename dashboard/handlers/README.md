# Ajouter un handler serveur et une vue

**Handler** (serveur) : déposez `dashboard/handlers/mon-module.mjs` ; `server.mjs` charge tous les `*.mjs` de
ce dossier au démarrage (ceux qui commencent par `_` sont ignorés), sans toucher aux autres fichiers.
1. Exportez `register(ctx)`.
2. `ctx.onMessage("mon.type", (ws, message) => { ... })` écoute un message du navigateur (plusieurs handlers
   peuvent écouter le même type).
3. Répondez avec `ctx.send(ws, {...})`, à tous avec `ctx.broadcast({...})`, une erreur avec `ctx.sendError(ws, "...")`.
4. Outils : `ctx.hosts` (clients Paseo par hôte, sans mot de passe), `ctx.hostOf(message)`, `ctx.store`
   (`read`/`write` atomiques dans `dashboard/data/`), `ctx.dataDir`, `ctx.log`, `ctx.safeError`, `ctx.onDisconnect`,
   `ctx.onStateChange(fn)` (crochet appelé avec le state complet `{hosts, agents, workspaces, ...}` après chaque
   `broadcastState` ; ajouté pour `timeline.mjs`, sans coût pour les autres handlers).
5. `ctx.onHttp("/api/chemin", (req, res, url) => ...)` : route HTTP GET en lecture seule, protégée par la même
   authentification que le reste (ajoutée pour `windows.mjs` ; les autres méthodes reçoivent 405).
6. Modèle à copier : `layouts.mjs`. Test : `node dashboard/scripts/verify-v3.mjs`.
7. `ctx.invoke(type, payload, {timeoutMs})` (ajoutée pour `agentapi.mjs`) : exécute les handlers déjà enregistrés pour
   ce `type` comme si un navigateur avait envoyé `{type, ...payload}`, avec un faux client (shim) qui **collecte** ce que
   les handlers lui envoient par `ctx.send(ws, ...)`. Renvoie `{ replies, error }` : `replies` = messages adressés à ce
   client, `error` = texte du premier message `error` (ou de l'exception, ou « délai dépassé »), sinon `null`. Les
   diffusions (`ctx.broadcast`) atteignent toujours les vrais navigateurs ; les abonnements ouverts par le handler
   (`agent.watch`…) sont relâchés à la fin de l'appel (via `onDisconnect`). Lance si le `type` n'a aucun handler. Un
   handler qui ne répond que par diffusion (`task.create`, `task.move`…) renvoie `replies: []` : relire l'état ensuite
   (`task.list`). C'est ce qui permet à l'API, à `postectl` et au serveur MCP de réutiliser les mêmes validations et
   garde-fous que l'interface (`confirm: true`, etc.) sans les recopier.
8. `ctx.onHttpPrefix("/api/v1/", (req, res, url) => ...)` (ajoutée pour `agentapi.mjs`) : comme `onHttp` mais pour tout
   chemin commençant par le préfixe et **tous les verbes** ; même authentification, même restriction à l'adresse locale
   sans mot de passe ; le handler gère méthode, corps, `Origin` et réponse.
9. `handlers/agentapi.mjs` : API de contrôle pour agents (`/api/v1/`, SSE, journal d'audit). Voir `../README.md`,
   « Piloter le poste par un agent ». Test : `node dashboard/scripts/verify-agentapi.mjs`.

10. `handlers/agentactivity.mjs` (T29) pose `ctx.agentActivity.record({method, route, ok, status, summary, mandateActive})`
   (appelé par `agentapi.mjs` pour chaque appel mutant ; journal `data/agent-activity.json`, 500 entrées) ; messages
   `agentactivity.list` et diffusion `agentactivity.added`. `handlers/decide.mjs` pose `ctx.decide.run({state, questions})`
   (relais vers Laya, route `POST /api/v1/decide`). Tests : `verify-agentactivity.mjs`, `verify-decide.mjs`.

11. `handlers/telegram.mjs` (T32) : état du bot Telegram en lecture seule (`telegram.status`, diffusion au changement) à partir de
   `.heartbeat.json` et `poste_activity.jsonl` du dossier `TELEGRAM_BOT_DIR`. Composant `components/telegram.js`. Test : `verify-telegram.mjs`.

12. `lib/permpolicy.mjs` + `handlers/permpolicy.mjs` (T34) : politique de permissions du mandat. `evaluatePermission(item, mandate)` (fonction
   pure) répond `{decision: "allow"|"deny"|"ask", reason, what}` pour une demande de la boîte de réception (`action.tool`, `action.target` brut,
   `action.cwd`, `action.kind`, ajoutés par `inbox.mjs`). Seul « allow » ouvre une porte ; ce qui n'est pas compris donne « ask ». Le handler
   l'applique aux sessions du mandat (tâche `origin:"agent"` + `agentRun` du mandat, ou session dans le dossier du projet) : allow → `perm.respond`
   allow, deny → deny avec message, ask → rien ; chaque décision est journalisée (« Autorisé automatiquement : … », « Refusé par le mandat : … »).
   Mandat : `autoPermissions` (défaut vrai), `allowGit` (défaut faux), `writeScope` (chemins relatifs où l'agent peut écrire ; vide = tout le projet).
   Anti auto-approbation : sous mandat actif, `POST /api/v1/inbox/:id/approve` et `POST /sessions/:host/:id/permission` (allow:true) ne passent que si la
   politique répond « allow » (sinon 403 « Seul Philippe peut accepter cette demande : ouvrez la vue Agent ») ; `refuse` reste permis. Sauvegardes :
   avant toute autorisation de modification (auto ou manuelle : crochet `ctx.permGuard.beforeAllow` appelé par `perm.respond`), le fichier existant est
   copié dans `data/agent-backups/<runId>/<chemin>.<horodatage>.bak` (20 Mo et 500 sauvegardes au plus par exécution) ; messages `agentbackup.list`,
   `agentbackup.restore {id, confirm:true}` (sauvegarde d'abord l'état actuel). Alertes (diffusion `permpolicy.alerts`) : demande en attente > 2 min,
   session muette > 30 min, session orpheline (tâche terminée/à valider, attente > 10 min) avec `permpolicy.closeOrphan {host, agentId}`
   (« Refuser et fermer », jamais automatique). Test : `node dashboard/scripts/verify-permpolicy.mjs` (faux hôte Paseo, aucun appel LLM ; `VERIFY_PART=g1|g23|g4`). Politique Bash = liste blanche de formes simples (voir `README.md`, « Permissions du mandat »). Limite : `perm.respond` par WebSocket n'est pas filtré (journalisé « Autorisé depuis l'interface »).

**Vue** (navigateur) : déposez `dashboard/public/js/views/ma-vue.js` ; elle est chargée automatiquement.
1. Importez `registerView` depuis `./registry.js` et appelez
   `registerView({ id, title, short, icon, order, mount(container, ctx), unmount() })`.
2. `id` devient l'ancre `#id` ; `order` place l'onglet (les vues d'origine utilisent 10, 20… 60).
3. `ctx` donne `state`, `send`, `on`, `onState`, `toast`, `confirm`, `drawer`, `launcher`, `desk`, `topbar`, `rail`.
4. Sans vue : `public/js/ext/mon-script.js` avec `export default (ctx) => { ... }`.

**Boîte de réception (`ctx.inbox`)** :
Les autres modules serveur (ex. un futur pont Telegram ou bot de notification) peuvent ajouter des éléments
directement dans le fil d'attention sans passer par WebSocket :
```js
ctx.inbox.add({
  kind: "système",              // "permission" | "fin" | "erreur" | "machine" | "système"
  title: "Notification",        // Titre court de l'élément
  body: "Texte explicatif",     // Contenu détaillé
  host: "local",                // Machine concernée (défaut "local")
  agentId: "...",               // Identifiant optionnel de l'agent
  taskId: "...",                // Identifiant optionnel d'une tâche
  status: "nouveau",            // "nouveau" (défaut) | "lu" | "traité"
  source: "telegram",           // "agent" (défaut) | "telegram" | "system" | "host"…
  action: { type: "...", ... }, // Action déclenchable au clic
  key: "idempotence_key",       // Clé facultative pour éviter les doublons
});
```
`ctx.inbox` est posé par `inbox.mjs` : un module chargé avant lui (ordre alphabétique) l'appelle depuis un callback
(message, minuterie), pas pendant `register`. `add` renvoie l'élément créé, ou `null` si la clé a déjà été vue ou
si l'entrée est invalide ; aucun code ne demande de jeton Telegram (le pont reste à écrire).
Méthodes complémentaires sur `ctx.inbox` : `list(filter)`, `mark(ids, status)`, `markAll(status)`,
`clear(olderThan)`, `getUnreadCount()`.

**Mode Agent : démarrage automatique et vue « Agent » (`handlers/agentmode.mjs`, `public/js/views/agent.js`, T31)** :
- `agentmode.enable {project, brief, forbidden, launch?, engine?}` : avec `launch: true`, le serveur retrouve le dossier du projet suivi
  (sinon refus clair), crée UNE tâche « Agent aux commandes — <projet> » (consigne `buildBrief`, chemin réel de `tools/postectl.mjs`,
  `--url` ajouté si le poste n'est pas sur :7070) et la démarre via `task.create` / `task.start` (`ctx.invoke`). Un seul mandat actif à la fois ;
  l'état (`runId`, `engine`, `orchestratorTaskId`, `launch {status: starting|started|failed}`) est diffusé dans `agentmode.state`.
- `agentmode.disable {stopTasks?}` : arrête l'orchestrateur (`task.stop`) ; les tâches filles ne sont arrêtées qu'avec `stopTasks: true`, jamais supprimées.
- Origine : colonnes `origin` / `agent_run` de la table `tasks` (migration `ALTER TABLE ADD COLUMN`). `task.create` ne les accepte que d'un appel
  interne (`ctx.invoke`) ; `POST /api/v1/tasks` les pose sous mandat actif ; `task.created {id}` répond à l'appelant. Les sessions de l'API portent `origin`.
- Test : `node dashboard/scripts/verify-agentlaunch.mjs` (instance isolée :7095 ; deux petits appels réels au moteur, arrêtés aussitôt).

**Coordination entre sessions (`handlers/coord.mjs` + `lib/coord.mjs`, T36)** : registre des sessions, réservations de fichiers, rôles, messages, tableau commun `PASEO-BOARD.md`. Chargé AVANT `core-agents.mjs`, `inbox.mjs` et `permpolicy.mjs` (qui appellent `ctx.coord.apply(item)`, `ctx.coordGuard`, `ctx.coord.prepareLaunch/createAgent`). Routes REST `/api/v1/coord/*` par `ctx.apiRoute`, messages WebSocket `coord.*` (humain seulement pour les actions). Documentation complète, limites et preuves : `dashboard/README.md`, section « Coordination entre sessions (T36) ». Test : `node dashboard/scripts/verify-coord.mjs` (`VERIFY_PART=g1|…|g6`).
