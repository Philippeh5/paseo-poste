#!/usr/bin/env bash
# Publie vers le dépôt PUBLIC Philippeh5/paseo-poste une copie assainie du dépôt de travail PRIVÉ paseo-poste.
#
# Usage (depuis paseo-poste) :
#   tools/publish-showcase.sh --dry-run          # voir ce qui serait publié, sans rien écrire
#   tools/publish-showcase.sh                    # copier, vérifier, committer et pousser
#   tools/publish-showcase.sh --message="feat: ..."
#   SHOWCASE_DIR=/chemin/vers/paseo-poste tools/publish-showcase.sh
#
# Règles :
#  - seuls les fichiers git suivis (ou nouveaux non ignorés) de la liste blanche ci-dessous sont copiés ;
#    aucun fichier ignoré (\.env, hosts.json, données, sessions…) ne peut passer ;
#  - les identifiants machine (IP Tailscale, noms d'hôte, chemins locaux) sont remplacés par des placeholders ;
#  - un scan de secrets bloque la publication si un jeton réel apparaît ;
#  - les faux secrets des suites de test verify-* sont explicitement autorisés ;
#  - README.md, ONBOARDING.md, LICENSE et .github/ sont maintenus DIRECTEMENT dans le dépôt public.
#  - jamais de force-push ; si rien n'a changé, aucun commit n'est créé.
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${SHOWCASE_DIR:-$HOME/Projets/paseo-poste}"
DRY=0
MESSAGE=""

usage() {
  printf '%s\n' \
    "Usage : tools/publish-showcase.sh [--dry-run] [--message=\"texte\"]" \
    "" \
    "  --dry-run          affiche les fichiers concernés sans rien modifier" \
    "  --message=TEXTE    message de commit personnalisé" \
    "  SHOWCASE_DIR      chemin du clone public (défaut : ~/Projets/paseo-poste)"
}

die() { printf 'ERREUR : %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --message=*) MESSAGE="${arg#--message=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "option inconnue : $arg" ;;
  esac
done

[ -d "$SOURCE/.git" ] || die "$SOURCE n'est pas un dépôt git"
[ -d "$TARGET/.git" ] || die "clone public absent. Faire : git clone https://github.com/Philippeh5/paseo-poste.git \"$TARGET\""
[ "$SOURCE" != "$TARGET" ] || die "la source et la cible sont le même dépôt : rien à publier"
origin="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
case "$origin" in
  *Philippeh5/paseo-poste*) ;;
  *) die "le remote origin de $TARGET ne pointe pas sur paseo-poste : $origin" ;;
esac
branch="$(git -C "$TARGET" symbolic-ref --short HEAD 2>/dev/null || true)"
[ "$branch" = "main" ] || die "branche attendue dans le clone public : main (actuelle : ${branch:-inconnue})"

# Liste blanche : code + scripts de déploiement. Les docs de vitrine vivent dans le dépôt public.
PATHS=(
  "dashboard/.gitignore" "dashboard/DESIGN.md" "dashboard/README.md" 
  "dashboard/handlers" "dashboard/lib" "dashboard/public" "dashboard/scripts"
  "dashboard/server.mjs" "dashboard/start-dashboard.ps1"
  "deploy/mini-pc" "deploy/oracle" "deploy/join-machine.sh"
  "tools" "package.json"
)

is_text() {
  case "$1" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.pdf|*.sqlite|*.db|*.woff|*.woff2|*.ttf|*.pyc) return 1 ;;
    *) return 0 ;;
  esac
}

sanitize() {
  local rel="$1" dst="$2"
  is_text "$rel" || return 0
  # Placeholders VALIDES : des chevrons (<IP>) casseraient la syntaxe shell/JS des fichiers copiés
  # et les tests qui vérifient le format d'une IP ou d'un nom d'hôte.
  sed -i \
    -e 's|100\.78\.38\.61|100.64.0.1|g' \
    -e 's|100\.103\.172\.69|100.64.0.1|g' \
    -e 's|example-windows-host|example-windows-host|g' \
    -e 's|example-oracle-host|example-oracle-host|g' \
    -e 's|philippep\.business@gmail\.com|user@example.com|g' \
    -e 's|paseo-poste|paseo-poste|g' \
    -e 's|DASHBOARD_TAILSCALE_USER=YOUR_USERNAME|DASHBOARD_TAILSCALE_USER=YOUR_USERNAME|g' \
    -e 's|DASHBOARD_SELF_HOST=YOUR_HOST_NAME|DASHBOARD_SELF_HOST=YOUR_HOST_NAME|g' \
    -e 's|DASHBOARD_TAILSCALE_MIN_PASSWORD=16|DASHBOARD_TAILSCALE_MIN_PASSWORD=16|g' \
    -e 's|Description=Poste de commande Paseo|Description=Poste de commande Paseo|g' \
    "$dst"
  # %h est la syntaxe systemd ; ailleurs on utilise un chemin générique.
  case "$rel" in
    *.service) sed -i -e 's|/home/USERNAME|%h|g' "$dst" ;;
    *) sed -i -e 's|/home/USERNAME|/home/USERNAME|g' "$dst" ;;
  esac
}

mapfile -d '' FILES < <(git -C "$SOURCE" ls-files -z --cached --others --exclude-standard -- "${PATHS[@]}")
printf '%s : %s fichier(s) de code à synchroniser%s\n' \
  "$SOURCE" "${#FILES[@]}" "$([ "$DRY" -eq 1 ] && printf ' (simulation)')"

copied=0
for rel in "${FILES[@]}"; do
  src="$SOURCE/$rel"
  [ -f "$src" ] || continue
  case "$rel" in
    *.bak|*.tmp|*~) continue ;;   # fichiers de travail ignorés par le .gitignore public
  esac
  if [ "$DRY" -eq 1 ]; then
    printf '  %s\n' "$rel"
    copied=$((copied + 1))
    continue
  fi
  mkdir -p "$TARGET/$(dirname "$rel")"
  cp -p "$src" "$TARGET/$rel"
  sanitize "$rel" "$TARGET/$rel"
  copied=$((copied + 1))
done
printf '%d fichier(s) copié(s).\n' "$copied"

if [ "$DRY" -eq 1 ]; then
  printf '\nDéjà en attente dans le clone public (docs, CI…) :\n'
  git -C "$TARGET" status --short
  exit 0
fi

# Contrôle de secrets sur les seuls fichiers modifiés du clone public.
SECRETS_RE='(sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|password|secret|token|mnemonic|private[_-]?key)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9_/+=-]{20,})'
bad=0
while IFS= read -r -d '' entry; do
  f="${entry:3}"
  [ -f "$TARGET/$f" ] || continue
  is_text "$f" || continue
  case "$f" in
    # Faux jetons volontaires : ces suites vérifient justement le masquage des secrets.
    dashboard/scripts/verify-*.mjs|tools/test-fixture.mjs|tools/tests-skip.json) continue ;;
  esac
  if grep -qnE "$SECRETS_RE" "$TARGET/$f"; then
    printf 'SECRET détecté dans %s — publication annulée (contenu non affiché).\n' "$f" >&2
    bad=1
  fi
done < <(git -C "$TARGET" status --porcelain -z)
[ "$bad" -eq 0 ] || exit 1

git -C "$TARGET" add -A
if git -C "$TARGET" diff --cached --quiet; then
  printf 'Rien à publier : le dépôt public est déjà à jour.\n'
  exit 0
fi

mapfile -t STAGED < <(git -C "$TARGET" diff --cached --name-only)
short="$(printf '%s\n' "${STAGED[@]:0:3}" | paste -sd, -)"
[ "${#STAGED[@]}" -gt 3 ] && short="$short (+$((${#STAGED[@]} - 3)))"
read -r add del < <(git -C "$TARGET" diff --cached --numstat | awk '{ if ($1 ~ /^[0-9]+$/) a+=$1; if ($2 ~ /^[0-9]+$/) d+=$2 } END { print a+0, d+0 }')
msg="${MESSAGE:-sync showcase : $short · +${add:-0} −${del:-0}}"

git -C "$TARGET" commit -q -m "$msg" -m "$(printf '%s\n' "${STAGED[@]}" | head -n 40)"
git -C "$TARGET" -c credential.helper='!gh auth git-credential' push -q origin main
printf 'Publié sur GitHub : %s (%d fichiers)\n' "$msg" "${#STAGED[@]}"
