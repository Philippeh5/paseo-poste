#!/usr/bin/env bash
# Chien de garde (timer toutes les 2 min) : interroge /api/healthz ; après 3 échecs d'affilée, relance paseo-dashboard.service ;
# alerte Telegram à la panne, à la reprise, et si le disque dépasse 85 %. Anti-spam : une alerte par changement d'état.
set -u
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/poste-watchdog"; mkdir -p "$STATE"
PORT="${DASHBOARD_PORT:-7070}"
notify() { # Jeton lu dans l'environnement de Hermes, jamais écrit ailleurs.
  [ -f "$HOME/.hermes/.env" ] || return 0
  local tok chat; tok="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$HOME/.hermes/.env" | tail -1 | cut -d= -f2- | tr -d "\"' ")"
  chat="$(grep -E '^TELEGRAM_HOME_CHANNEL=' "$HOME/.hermes/.env" | tail -1 | cut -d= -f2- | tr -d "\"' ")"
  [ -n "$tok" ] && [ -n "$chat" ] && curl -fsS -m 10 "https://api.telegram.org/bot$tok/sendMessage" -d "chat_id=$chat" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}
body="$(curl -sS -m 8 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null)"; code=$?
ok=0; [ $code -eq 0 ] && echo "$body" | grep -q '"ok":true' && ok=1
fails=$(cat "$STATE/fails" 2>/dev/null || echo 0); down=$(cat "$STATE/down" 2>/dev/null || echo 0)
if [ $ok -eq 1 ]; then
  echo 0 > "$STATE/fails"
  if [ "$down" = 1 ]; then echo 0 > "$STATE/down"; notify "✅ Le poste est de nouveau en ligne."; fi
  # Battement vers GitHub (surveillance externe : .github/workflows/oracle-heartbeat.yml), au plus toutes les 5 min.
  last=$(cat "$STATE/beat" 2>/dev/null || echo 0); nowt=$(date +%s)
  if [ $((nowt - last)) -ge 300 ] && command -v gh >/dev/null; then
    REPO="${HEARTBEAT_REPO:-Philippeh5/paseo-poste}"
    if timeout 20 gh api -X PATCH "repos/$REPO/actions/variables/ORACLE_HEARTBEAT" -f name=ORACLE_HEARTBEAT -f value="$nowt" >/dev/null 2>&1; then echo "$nowt" > "$STATE/beat"; fi
  fi
  disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
  if [ "${disk:-0}" -ge 85 ]; then [ -f "$STATE/disk" ] || { touch "$STATE/disk"; notify "⚠️ Disque Oracle à ${disk} %."; }; else rm -f "$STATE/disk"; fi
  exit 0
fi
fails=$((fails + 1)); echo "$fails" > "$STATE/fails"
if [ "$fails" -ge 3 ]; then
  systemctl --user restart paseo-dashboard.service 2>/dev/null
  if [ "$down" != 1 ]; then echo 1 > "$STATE/down"; notify "🔴 Le poste ne répond plus ($fails échecs) : relance automatique lancée."; fi
  echo 0 > "$STATE/fails"
fi
