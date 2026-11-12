#!/usr/bin/env bash
# Restaure une sauvegarde dans un dossier (par défaut ~/restore-poste/<archive>), SANS rien écraser.
# Usage : restore.sh [archive.tar.gz]   (défaut : la plus récente). Ensuite, copier à la main ce qu'on veut remettre.
set -euo pipefail
A="${1:-$(ls -t "$HOME"/backups/poste/poste-*.tar.gz | head -1)}"; T="${RESTORE_DIR:-$HOME/restore-poste/$(basename "$A" .tar.gz)}"
mkdir -p "$T"; tar -xzf "$A" -C "$T"; echo "Restauré dans $T"; ls "$T"
