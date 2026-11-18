#!/usr/bin/env bash
# Prépare une machine (Linux/macOS) pour être pilotée depuis le poste de commande Paseo :
#   1. installe le démon Paseo (@getpaseo/cli) s'il manque ;
#   2. le fait écouter sur l'adresse Tailscale de la machine (jamais 0.0.0.0) ;
#   3. définit son mot de passe (invite dans le terminal, ou PASEO_PASSWORD, ou --password-file) ;
#   4. démarre le démon et imprime la ligne à ajouter dans le poste (vue « Machines » ou hosts.json).
# Prérequis : Node 20+ et Tailscale connecté (sudo tailscale up). Aucune donnée n'est envoyée ailleurs.
#
# Usage : join-machine.sh [--label NOM] [--port 6767] [--ip ADRESSE] [--home DOSSIER] [--password-file FICHIER] [--dry-run]
set -euo pipefail

LABEL="$(hostname -s 2>/dev/null || echo machine)"; PORT=6767; IP=""; HOME_ARG=(); PWFILE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --home) HOME_ARG=(--home "$2"); shift 2 ;;
    --password-file) PWFILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERREUR : $*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "port invalide"
[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$ ]] || die "nom invalide (lettres, chiffres, - et _)"

command -v node >/dev/null || die "Node.js absent (installez Node 20 ou plus)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node 20 ou plus requis."

if [ -z "$IP" ]; then
  command -v tailscale >/dev/null || die "Tailscale absent : curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
  IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$IP" ] || die "Tailscale n'a pas d'adresse : lancez « sudo tailscale up »."
fi
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "adresse invalide : $IP"
[ "$IP" != "0.0.0.0" ] || die "0.0.0.0 refusé : le démon doit écouter sur l'adresse Tailscale seulement."

if ! command -v paseo >/dev/null; then
  echo "→ Installation de @getpaseo/cli"
  run npm install -g @getpaseo/cli
fi

echo "→ Écoute sur $IP:$PORT"
run paseo daemon config set daemon.listen "$IP:$PORT" --string ${HOME_ARG[@]+"${HOME_ARG[@]}"}
run paseo daemon config set daemon.hostnames "[\"$IP\"]" ${HOME_ARG[@]+"${HOME_ARG[@]}"}

PASS=""
if [ -n "$PWFILE" ]; then PASS="$(head -n1 "$PWFILE")"; [ -n "$PASS" ] || die "fichier de mot de passe vide"
elif [ -n "${PASEO_PASSWORD:-}" ]; then PASS="$PASEO_PASSWORD"; fi

if [ "$DRY" = 1 ]; then
  echo "[dry-run] paseo daemon set-password / start / status"
elif [ -n "$PASS" ]; then
  # Mot de passe fourni : transmis par l'environnement du démon (jamais en argument, donc absent de la liste des processus).
  PASEO_PASSWORD="$PASS" paseo daemon start ${HOME_ARG[@]+"${HOME_ARG[@]}"}
else
  [ -t 0 ] || die "mot de passe requis : terminal interactif, PASEO_PASSWORD ou --password-file."
  paseo daemon set-password ${HOME_ARG[@]+"${HOME_ARG[@]}"}
  paseo daemon start ${HOME_ARG[@]+"${HOME_ARG[@]}"}
fi
run paseo daemon status ${HOME_ARG[@]+"${HOME_ARG[@]}"}

cat <<EOF

✔ Machine prête. Dans le poste (vue « Machines » → Ajouter) saisissez :
   nom          : $LABEL
   adresse      : ws://$IP:$PORT/ws
   mot de passe : celui que vous venez de définir
(ou, dans hosts.json : { "label": "$LABEL", "url": "ws://$IP:$PORT/ws", "password": "…" })
EOF
