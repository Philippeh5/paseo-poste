# Rapport — Dashboard Paseo v2

## Fichiers modifiés/créés

- `server.mjs` : collecte flotte, messages de lancement/agent/terminal, abonnements libérés à la fermeture, Basic Auth HTTP/WebSocket, validation Origin et liaison configurable.
- `public/index.html`, `public/style.css`, `public/app.js`, `public/package.json`.
- `public/js/state.js`, `fleet.js`, `sessions.js`, `launcher.js`, `terminals.js` : modules ES natifs.
- `scripts/verify-v2.mjs` : test WebSocket de bout en bout et essais d'authentification.
- `README.md` : écrans, variables, protocole et hébergement.

`package.json`, `hosts.json` et les daemons n'ont pas été modifiés. Aucune dépendance n'a été ajoutée.

## Lancement et syntaxe

Depuis la racine du dépôt :

```sh
node dashboard/server.mjs
```

Le serveur a été relancé sur `127.0.0.1:7070` et laissé actif. Chaque fichier `.js`/`.mjs` sous `dashboard` a été vérifié avant lancement :

```text
SYNTAX_OK_ALL_FILES
```

## Vérification de bout en bout

Commande : `node dashboard/scripts/verify-v2.mjs`. Sortie brute de la dernière exécution réussie :

```text
OPTIONS_OK [{"id":"claude-openrouter","status":"ready","available":true,"sonnetModels":["claude-sonnet-5-5","claude-sonnet-5","claude-sonnet-5[1m]","claude-sonnet-4-6[1m]","claude-sonnet-4-6"]},{"id":"claude-api","status":"ready","available":true,"sonnetModels":["claude-sonnet-5-5","claude-sonnet-5","claude-sonnet-5[1m]","claude-sonnet-4-6[1m]","claude-sonnet-4-6"]}]
TERMINAL_OK {"host":"local","cwd":"D:\\Projets\\AI-OS\\paseo-poste\\sandbox-repo","terminalId":"c68320f4-656d-4502-8d6f-4b79a06060c6","echoed":"PASEO_cd52a0efde"}
AGENT_LIVE_PONG {"agentId":"f52368f2-ccad-40e6-a2e7-80fb0e767f8e","timelineText":"PONG"}
AGENT_STATE_OK {"agentId":"f52368f2-ccad-40e6-a2e7-80fb0e767f8e","provider":"claude-openrouter","model":"sonnet","status":"running","cwd":"D:\\Projets\\AI-OS\\paseo-poste\\sandbox-repo","parentAgentId":null}
AGENT_SECOND_REPLY_OK {"agentId":"f52368f2-ccad-40e6-a2e7-80fb0e767f8e","reply":"PONG"}
AGENT_TIMELINE_OK ["agent.history","thread_started","assistant_message","assistant_message","turn_completed","turn_started","user_message","assistant_message","assistant_message","turn_completed"]
CLEANUP_AGENT_ARCHIVED f52368f2-ccad-40e6-a2e7-80fb0e767f8e
CLEANUP_TERMINAL_KILLED c68320f4-656d-4502-8d6f-4b79a06060c6
SECURITY_NO_PASSWORD {"exitCode":1,"output":"DASHBOARD_PASSWORD est obligatoire pour écouter sur une adresse non locale."}
SECURITY_HTTP {"withoutCredentials":401,"withCredentials":200}
SECURITY_WEBSOCKET {"withoutCredentials":"401","withCredentials":"open","wrongOrigin":"401"}
SECURITY_INSTANCE_STOPPED {"stopped":true,"signal":"SIGTERM"}
```

L'agent de test était un agent racine : le champ `parentAgentId` était présent et valait `null`. Le terminal et l'agent ont été nettoyés. Le serveur de sécurité de test a été arrêté.

## Non vérifié

- Le rendu dans un navigateur graphique aux dimensions 1280×720 et 390 px : `playwright-cli` n'est pas disponible dans cet environnement.
- Un vrai sous-agent et donc un arbre avec `parentAgentId` non nul.
- Le renommage effectif d'un terminal, les réponses de permissions et le mode worktree. L'interruption d'un agent est raccordée à `cancelAgent`, mais n'a pas fait l'objet d'un test séparé.
