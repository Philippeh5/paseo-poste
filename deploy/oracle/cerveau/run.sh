#!/usr/bin/env bash
# Un réveil du cerveau : Claude Code non interactif sur un projet. La consigne arrive sur l'entrée standard (écrite par
# dashboard/handlers/autonomy.mjs) ou dans le fichier POSTE_PROMPT_FILE (réveil lancé en unité systemd, sans entrée standard).
# Usage : run.sh <dossier-projet> <claude|free>
#   claude → abonnement Claude (config ~/.claude)   free → modèles gratuits (config ~/.claude-openrouter, repli ~/.claude-nvidia)
# POSTE_AUTONOMOUS=1 (posé par l'appelant) active les garde-fous durs du hook ~/.claude*/settings.json → tools/guard-hook.mjs.
# Le code de sortie est aussi écrit dans <journaux>/<POSTE_RUN_ID>.exit : le poste le relit s'il a redémarré pendant le réveil.
set -uo pipefail
DIR="${1:?dossier du projet}"; ENGINE="${2:-free}"; HERE="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="${DASHBOARD_DATA_DIR:-$HOME/paseo-dash-data}/brain-logs"; mkdir -p "$LOGDIR"; LOG="$LOGDIR/$(date -u +%Y%m%d-%H%M%S)-${POSTE_RUN_ID:-manuel}.log"
EXITF="$LOGDIR/${POSTE_RUN_ID:-manuel}.exit"; code=1
trap 'echo "$code" > "$EXITF.tmp" && mv "$EXITF.tmp" "$EXITF"' EXIT
die() { code=$1; echo "== fin code=$code" >> "$LOG"; exit "$code"; }
if [ -n "${POSTE_PROMPT_FILE:-}" ] && [ -f "$POSTE_PROMPT_FILE" ]; then PROMPT="$(cat "$POSTE_PROMPT_FILE")"; rm -f "$POSTE_PROMPT_FILE"; else PROMPT="$(cat)"; fi
case "$ENGINE" in
  claude) export CLAUDE_CONFIG_DIR="$HOME/.claude"; MODEL="${BRAIN_MODEL_CLAUDE:-sonnet}";;
  *)      export CLAUDE_CONFIG_DIR="$HOME/.claude-openrouter"; MODEL="${BRAIN_MODEL_FREE:-sonnet}";;
esac
export POSTE_AUTONOMOUS=1 POSTECTL_URL="${POSTECTL_URL:-http://127.0.0.1:7070}" PATH="$HERE/../bin:$HOME/.local/bin:$HOME/Projets/bin:$PATH"
cd "$DIR" || die 2
{ echo "== $(date -u +%FT%TZ) cerveau ($ENGINE/$MODEL) sur $DIR"; } >> "$LOG"
# Sans postectl le cerveau ne peut ni déléguer ni lire les tâches : on s'arrête tout de suite, en le disant (alerte Telegram).
if ! command -v postectl >/dev/null 2>&1; then
  printf '%s\n' "Bloqué : outil manquant : postectl" >> "$LOG"; die 3
fi
if ! SUMMARY="$(postectl summary 2>&1)"; then
  { echo "postectl summary a échoué :"; echo "$SUMMARY" | head -5; echo "Bloqué : outil manquant : postectl ne répond pas"; } >> "$LOG"; die 3
fi
{ echo "== postectl summary"; echo "$SUMMARY" | head -60; echo "== fin du résumé"; } >> "$LOG"
timeout "${BRAIN_TIMEOUT_S:-1800}" claude -p --model "$MODEL" --dangerously-skip-permissions \
  --append-system-prompt "$(cat "$HERE/CONSIGNE.md")" "$PROMPT" >> "$LOG" 2>&1
code=$?
echo "== fin code=$code" >> "$LOG"
find "$LOGDIR" \( -name '*.log' -o -name '*.exit' -o -name '*.prompt' \) -mtime +14 -delete 2>/dev/null
exit $code
