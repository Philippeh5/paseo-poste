#!/usr/bin/env bash
# Installe (ou met à jour) le poste sur Oracle de façon idempotente : unités systemd utilisateur, modèle d'environnement,
# linger, timers (gh-sync, sauvegarde, chien de garde). Ne contient et n'écrase AUCUN secret (fichiers d'environnement existants gardés).
# Usage : deploy/oracle/install.sh [--dry-run]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; U="$HOME/.config/systemd/user"; DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ $DRY = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
run mkdir -p "$U" "$HOME/paseo-dash-data" "$HOME/backups/poste"
run chmod 700 "$HOME/backups/poste"
changed=0
while IFS= read -r -d '' f; do
  rel="${f#"$HERE/systemd/"}"; dst="$U/$rel"
  if ! cmp -s "$f" "$dst" 2>/dev/null; then echo "mise à jour : $rel"; run mkdir -p "$(dirname "$dst")"; run cp "$f" "$dst"; changed=1; fi
done < <(find "$HERE/systemd" -type f -print0)
[ -f "$HOME/paseo-dash-data/hermes-api.env" ] || { echo "créé (à remplir) : ~/paseo-dash-data/hermes-api.env"; run cp "$HERE/poste.env.example" "$HOME/paseo-dash-data/hermes-api.env"; run chmod 600 "$HOME/paseo-dash-data/hermes-api.env"; }
# postectl accessible à tous les agents (le cerveau l'ajoute aussi à son PATH depuis le dépôt)
run mkdir -p "$HOME/.local/bin"; run ln -sfn "$HERE/bin/postectl" "$HOME/.local/bin/postectl"
run loginctl enable-linger "$USER" || true
[ $changed = 1 ] && run systemctl --user daemon-reload
for t in gh-sync.timer poste-backup.timer poste-watchdog.timer; do run systemctl --user enable --now "$t"; done
for s in paseo.service paseo-dashboard.service hermes-gateway.service; do run systemctl --user enable "$s"; done
echo "OK. Vérifier : systemctl --user list-timers ; curl -s localhost:7070/api/healthz"
