# freebuff-run.mjs
Lance FreeBuff dans un vrai terminal PTY du daemon Paseo, tape l'invite, renvoie l'ecran (sans ANSI) + terminalId.
Usage (depuis `paseo-poste`, resout `@getpaseo/client` via `node_modules`):
`node tools/freebuff-run.mjs --cwd <dossier> --prompt "<texte>" [--url ws://127.0.0.1:6767/ws] [--password-file f] [--wait-seconds 90] [--keep] [--terminal-id <id>] [--json] [--command freebuff] [--debug]`
Code retour 0 = reponse terminee detectee, 1 = echec/timeout (l'ecran est quand meme imprime). `--json`: {terminalId, ready, completed, killed, reply, screen, error}.
Hote Oracle (verifie 2026-11-07): le daemon ecoute sur l'adresse Tailscale, pas sur 127.0.0.1 : `--url ws://100.64.0.1:6767/ws`, mot de passe via `PASEO_PASSWORD` (lu automatiquement, ou `FREEBUFF_DAEMON_PASSWORD` / `--password-file`).
`--terminal-id <id>` : suite dans un FreeBuff deja ouvert (1er tour avec `--keep`, tours suivants avec l'id ; le dernier sans `--keep` tue le terminal). Verifie : 'retiens 4721' puis question suivante -> `4721`.
Delai avant saisie : 10 s par defaut (`FREEBUFF_SETTLE_MS`) ; plus court, la saisie est parfois avalee.

## Observe (PTY du daemon)
- FreeBuff tourne normalement en PTY (pas besoin de console Windows). Inutile de lui passer des options: `freebuff` suffit.
- La pub est du TEXTE dans l'ecran: encart `╭...╰` (indente d'un espace) avec `Ad` en haut a droite, qui tourne (~toutes les quelques secondes).
- Elle ne bloque pas la saisie: l'invite est prete ~3 s apres le lancement, pub deja affichee; la reponse (PONG) arrive en ~8-10 s.
- Cout : sur Oracle (2026-11-07) l'ecran affiche des heures de session (`2/4 hours remaining`, puis `N m left`) au lieu de Freebucks ; modele choisi par FreeBuff (Solar Pro 4, DeepSeek V4.1 Flash Slow vus).
- UNE seule session payante : si une autre instance tourne (`ps | grep node.*bin/freebuff`), l'ecran affiche `Your paid session is in use elsewhere ... Enter: take over` -> l'outil ne valide JAMAIS (cela couperait l'autre) et finit en timeout.
- Seat foreman : `~/.claude/skills/claude-foreman/scripts/freebuff-dispatch.sh` + agent `foreman-freebuff-wrapper`.

## Limites / points fragiles
- Invite prete = ecran contient `Enter a coding task`/`▍` et `? for help`, sans `esc to interrupt`, vu 3 fois de suite; textes en anglais, a revoir si FreeBuff change son UI.
- Juste apres l'apparition de l'invite, FreeBuff peut avaler la saisie (observe 1 fois): l'outil attend 2 s et retente jusqu'a 3 fois.
- Fin de reponse = ecran hors pub stable 5 s + invite revenue + echo de l'invite visible. Les compteurs (`⎘ • 8s`) bougent pendant la generation.
- La pub est retiree par heuristique (boite indentee dont une ligne finit par `Ad │`); si le format change, "ecran stable" peut ne jamais etre vrai (timeout).
- Fenetres de confirmation (autorisation d'action, "End session", etc.): non gerees, jamais acceptees; l'ecran capture les montre.
- `reply` est une extraction au mieux (texte entre l'echo et la boite de saisie); se fier a `screen`.
