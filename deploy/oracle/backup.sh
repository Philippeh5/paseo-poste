#!/usr/bin/env bash
# Sauvegarde quotidienne HORS GIT du poste : données du poste (SQLite copiés proprement, JSON), fichiers non suivis des projets,
# configs de l'agent. Destination locale ~/backups/poste/<date>.tar.gz (dossier 700, 14 jours conservés).
# Hors machine, seulement si BACKUP_RCLONE_REMOTE ET BACKUP_AGE_RECIPIENT sont définis (archive chiffrée avec age).
# Restauration : voir restore.sh. Journal : ~/backups/poste/backup.log. Lecture seule sur les projets (BlastWin compris).
set -euo pipefail
DEST="${BACKUP_DIR:-$HOME/backups/poste}"; DATA="${DASHBOARD_DATA_DIR:-$HOME/paseo-dash-data}"; KEEP_DAYS=14
mkdir -p "$DEST"; chmod 700 "$DEST"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$DEST/backup.log"; }
trap 'log "ECHEC ligne $LINENO"' ERR
STAMP="$(date -u +%Y%m%d-%H%M%S)"; WORK="$(mktemp -d "$DEST/.work.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT

# 1. Données du poste : copie à plat, SQLite via VACUUM INTO (cohérent même serveur allumé).
mkdir -p "$WORK/data"
(cd "$DATA" && find . -type f ! -name '*.sqlite' ! -name '*.sqlite-*' ! -path './services-logs/*' -print0 | cpio -0pdm --quiet "$WORK/data")
for db in "$DATA"/*.sqlite; do
  [ -f "$db" ] || continue
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec("VACUUM INTO \x27"+process.argv[2].replace(/\x27/g,"")+"\x27")' "$db" "$WORK/data/$(basename "$db")"
done

# 2. Fichiers non suivis (hors .gitignore) de chaque projet git : travail pas encore commité ni synchronisé.
mkdir -p "$WORK/untracked"
for d in "$HOME"/Projets/*/; do
  [ -d "$d/.git" ] || continue
  n="$(basename "$d")"; list="$(cd "$d" && git ls-files --others --exclude-standard -z | tr '\0' '\n' | head -5000)"
  [ -n "$list" ] || continue
  (cd "$d" && printf '%s\n' "$list" | tar -cf - -T - --ignore-failed-read 2>/dev/null) | tar -xf - -C "$(mkdir -p "$WORK/untracked/$n" && echo "$WORK/untracked/$n")"
done

# 3. Configs de l'agent et de l'ordonnancement (sans identifiants OAuth ni .env).
mkdir -p "$WORK/config"
cp -r "$HOME/.config/systemd/user" "$WORK/config/systemd-user" 2>/dev/null || true
for f in "$HOME"/.claude/CLAUDE.md "$HOME"/.claude/settings.json; do [ -f "$f" ] && cp "$f" "$WORK/config/" || true; done
cp -r "$HOME/.claude/projects" "$WORK/config/claude-projects-memory" 2>/dev/null && find "$WORK/config/claude-projects-memory" -type f ! -path '*/memory/*' -delete || true

OUT="$DEST/poste-$STAMP.tar.gz"
tar -czf "$OUT" -C "$WORK" .; chmod 600 "$OUT"
log "OK $OUT ($(du -h "$OUT" | cut -f1))"
find "$DEST" -maxdepth 1 -name 'poste-*.tar.gz*' -mtime +"$KEEP_DAYS" -delete

# 4. Hors machine, chiffré, si configuré.
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && command -v age >/dev/null && command -v rclone >/dev/null; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT.age" "$OUT" && rclone copy "$OUT.age" "$BACKUP_RCLONE_REMOTE" && log "OK copie hors machine"
  rm -f "$OUT.age"
fi
