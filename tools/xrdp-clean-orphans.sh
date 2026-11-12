#!/bin/sh
# Termine les sessions XFCE orphelines de l'utilisateur courant (sur un autre écran que $DISPLAY).
#
# Pourquoi: quand xrdp-sesman est relancé (mise à jour automatique), il oublie les sessions déjà ouvertes.
# L'ancienne session XFCE continue de tourner, et XFCE refuse de démarrer une seconde session pour le même
# utilisateur: le gestionnaire de fenêtres quitte en 0 seconde et la connexion à distance se ferme.
#
# Appelé par /etc/xrdp/startwm.sh avant de lancer XFCE. Code de sortie: 10 si des sessions ont été supprimées.
# Usage: xrdp-clean-orphans.sh [--dry-run]

me=$(id -u)
cur="${DISPLAY%%.*}"
dry=0
[ "$1" = "--dry-run" ] && dry=1
killed=0

display_of() {
  cat "/proc/$1/environ" 2>/dev/null | tr '\0' '\n' | sed -n 's/^DISPLAY=//p' | head -n 1 | sed 's/\..*//'
}

for p in $(pgrep -u "$me" -x xfce4-session); do
  d=$(display_of "$p")
  [ -z "$d" ] && continue
  [ "$d" = "$cur" ] && continue
  echo "orpheline: xfce4-session pid $p sur l'écran $d (session courante: ${cur:-inconnue})"
  [ "$dry" = 1 ] && continue
  for q in $(pgrep -u "$me"); do
    [ "$q" = "$$" ] && continue
    [ "$(display_of "$q")" = "$d" ] && kill -TERM "$q" 2>/dev/null
  done
  pkill -TERM -u "$me" -f "^/usr/lib/xorg/Xorg $d " 2>/dev/null
  killed=1
done

if [ "$killed" = 1 ]; then
  sleep 3
  exit 10
fi
exit 0
