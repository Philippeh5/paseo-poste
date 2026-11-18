#!/usr/bin/env bash
# Synchronisation automatique GitHub des projets (PC Windows et Oracle).
# Pour chaque dépôt : commit des changements locaux (sauf si un secret est détecté), récupération des nouveautés
# (rebase), puis publication. Jamais de force-push. En cas de conflit : on annule le rebase, on note le problème et on passe.
# Mode « branche » (repos listés dans GH_SYNC_BRANCH_REPOS, séparés par des espaces) : la publication va sur sync/<machine>,
# jamais directement sur la branche principale ; quand la CI GitHub est verte sur ce commit, fusion en avance rapide vers la
# branche principale (sans force-push sur celle-ci). Sans CI configurée, le repo reste en mode direct.
# Prévu pour tourner toutes les minutes (minuterie systemd sur Oracle, tâche « PosteSyncGitHub » sur le mini-PC) :
# journaux dédupliqués (un état inchangé n'écrit rien), verrou unique, timeouts réseau.
# Message de commit lisible : « sync <machine> : a.js, b.js, c.js (+N autres) · +A −D » + liste complète des fichiers en corps.
# Alertes Telegram (via le notificateur du poste, sans lire de secret ici) : un problème (CI rouge, conflit, secret, publication
# refusée…) qui dure ≥ 10 min déclenche UNE notification (puis une autre après 6 h seulement) ; « synchro rétablie » quand il disparaît.
# Usage : gh-sync.sh <dossier-projets> <dépôt> [<dépôt>…]      (ex. gh-sync.sh /d/Projets Bot_Stage BlastWin)
# Journal : <dossier-projets>/.gh-sync.log ; problèmes à lire : <dossier-projets>/SYNC-PROBLEMES.log ; alertes : <dossier-projets>/.gh-sync.alerts
# Variables : GH_SYNC_MACHINE (nom lisible), GH_SYNC_BRANCH_REPOS, GH_SYNC_HOST (nom d'hôte, tests), GH_SYNC_NOW (horloge, tests),
#             GH_SYNC_NOTIFY_MJS (chemin de dashboard/lib/notify.mjs), NOTIFY_DRY_FILE (messages écrits dans un fichier, tests).
set -u
ROOT="$1"; shift
LOG="$ROOT/.gh-sync.log"; PROB="$ROOT/SYNC-PROBLEMES.log"; ALERTS="$ROOT/.gh-sync.alerts"; STATE="$ROOT/.gh-sync.state"
HOST="${GH_SYNC_HOST:-$(hostname)}"
case "${GH_SYNC_MACHINE:-}" in
  '') case "$HOST" in <ORACLE_HOSTNAME>) MACHINE=oracle;; <WINDOWS_HOSTNAME>) MACHINE=mini-pc;; *) MACHINE="$HOST";; esac;;
  *) MACHINE="$GH_SYNC_MACHINE";;
esac
NOW="${GH_SYNC_NOW:-$(date +%s)}"
ALERT_DELAY=600        # un problème doit durer 10 min avant d'alerter
ALERT_REPEAT=21600     # puis on ne répète qu'après 6 h
mkdir -p "$STATE" 2>/dev/null
# Journal borné (une ligne par changement d'état seulement, mais on garde une marge)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2097152 ]; then tail -n 4000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"; fi
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$HOST" "$*" >> "$LOG"; }
# Journalise seulement si le message change pour cette clé (évite 1 440 lignes identiques par jour)
logchg() { local f; f="$STATE/log.$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' _)"; [ "$(cat "$f" 2>/dev/null)" = "$2" ] && return 0; printf '%s' "$2" > "$f"; log "$2"; }
# Problèmes : consignés une fois tant qu'ils durent (comparés au passage précédent)
PROBNOW=""
problem() {
  PROBNOW="$PROBNOW$*"$'\n'
  grep -qxF -- "$*" "$STATE/lastprob" 2>/dev/null && return 0
  log "PROBLEME $*"; printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$HOST" "$*" >> "$PROB"
}
# Problèmes actifs pour les alertes : lignes « dépôt<TAB>genre<TAB>détail » ; SEEN = dépôts dont le passage est allé au bout
ACTIVE=""; SEEN=""
flag() { ACTIVE="$ACTIVE$1"$'\t'"$2"$'\t'"$(printf '%s' "$3" | tr '\t\n' '  ' | cut -c1-120)"$'\n'; }
seen() { SEEN="$SEEN$1"$'\n'; }

# Un seul passage à la fois
LOCK="$ROOT/.gh-sync.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
export GIT_TERMINAL_PROMPT=0
# Timeout sur les opérations réseau (un git bloqué ne doit pas retenir le verrou) quand `timeout` existe (Linux, Git Bash)
tmo() { if command -v timeout >/dev/null 2>&1; then timeout 120 "$@"; else "$@"; fi; }

SECRETS='(sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|password|secret|token|mnemonic|private[_-]?key)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9_/+=-]{20,})'
GIT=(git -c user.name="Philippe (auto-sync)" -c user.email="<email>@example.com" -c core.autocrlf=false)
MAXBYTES=$((5 * 1024 * 1024))

# Noms les plus courts possibles mais uniques (stdin : un chemin par ligne ; $1 = nombre de noms à rendre, 3 par défaut) :
# a.js, ou dossier/a.js si deux a.js. Seuls les $1 premiers fichiers sont nommés (le sujet n'en montre que 3) : coût linéaire
# (au plus $1 × profondeur × N comparaisons), même avec 10 000 fichiers modifiés, pour ne pas retenir le verrou.
short_names() {
  awk -v max="${1:-3}" 'function suf(p,k,  b,n,j,s){ n=split(p,b,"/"); s=b[n]; for(j=n-1;j>n-k&&j>=1;j--) s=b[j] "/" s; return s }
       { P[NR]=$0 }
       END { lim=(NR<max?NR:max);
             for(i=1;i<=lim;i++){ n=split(P[i],a,"/"); r=P[i];
               for(k=1;k<=n;k++){ s=suf(P[i],k); u=1; for(m=1;m<=NR;m++){ if(m!=i && suf(P[m],k)==s){u=0;break} } if(u){r=s;break} }
               print r } }'
}
# Message de commit : sujet « sync <machine> : a, b, c (+N autres) · +A −D », corps = liste complète (30 lignes max)
commit_message() {
  local all names total listed extra add del subj body
  all="$(git -c core.quotepath=false diff --cached --name-only)"
  total="$(printf '%s\n' "$all" | grep -c .)"
  names="$(printf '%s\n' "$all" | short_names 3)"
  listed="$(printf '%s\n' "$names" | paste -sd, - | sed 's/,/, /g')"
  extra=""; [ "$total" -gt 3 ] && extra=" (+$((total - 3)) autres)"
  read -r add del <<EOT
$(git diff --cached --numstat | awk '{ if ($1 ~ /^[0-9]+$/) a+=$1; if ($2 ~ /^[0-9]+$/) d+=$2 } END { print a+0, d+0 }')
EOT
  subj="sync $MACHINE : $listed$extra · +${add:-0} −${del:-0}"
  body="$(git -c core.quotepath=false diff --cached --name-status | head -n 30)"
  [ "$total" -gt 30 ] && body="$body"$'\n'"… ($((total - 30)) fichier(s) de plus)"
  printf '%s\n\n%s\n' "$subj" "$body"
}

# Notification Telegram par le notificateur du poste (dashboard/lib/notify.mjs : il lit lui-même le jeton, jamais ce script).
# Sans configuration de notification (Windows, pas de ~/.hermes/.env) ou sans node : rien n'est envoyé, code de retour 1.
notify() {
  local mjs="${GH_SYNC_NOTIFY_MJS:-$ROOT/paseo-poste/dashboard/lib/notify.mjs}"
  [ -f "$mjs" ] || return 1
  [ -n "${NOTIFY_DRY_FILE:-}" ] || [ -f "${HERMES_ENV_FILE:-$HOME/.hermes/.env}" ] || return 1
  command -v node >/dev/null 2>&1 || PATH="$HOME/.local/node/bin:$PATH"
  command -v node >/dev/null 2>&1 || return 1
  # Seul le poste réel (~/paseo-dash-data) a le droit d'envoyer pour de vrai (garde de notify.mjs)
  [ -d "$HOME/paseo-dash-data" ] && export DASHBOARD_DATA_DIR="${DASHBOARD_DATA_DIR:-$HOME/paseo-dash-data}"
  tmo node --input-type=module -e "import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(process.argv[1]).href); process.exit((await m.telegramSend(process.argv[2])) ? 0 : 3);" "$mjs" "$1" >/dev/null 2>&1
}
label() { case "$1" in ci-rouge) echo "CI rouge";; conflit) echo "conflit";; secret) echo "secret détecté";; publication) echo "publication refusée";; ci-illisible) echo "CI illisible";; gros-fichier) echo "gros fichier non publié";; controle-taille) echo "contrôle de taille impossible";; git-en-cours) echo "opération git bloquée";; reseau) echo "réseau / récupération impossible";; *) echo "$1";; esac; }

# Alertes : clé = dépôt + genre ; état dans $ALERTS (dépôt TAB genre TAB depuis TAB dernière-alerte TAB détail)
evaluate_alerts() {
  local newstate="" repo kind since last detail line
  # 1) problèmes actifs
  while IFS=$'\t' read -r repo kind detail; do
    [ -n "$repo" ] || continue
    since=""; last=0
    line="$(awk -F'\t' -v r="$repo" -v k="$kind" '$1==r && $2==k {print; exit}' "$ALERTS" 2>/dev/null)"
    if [ -n "$line" ]; then since="$(printf '%s' "$line" | cut -f3)"; last="$(printf '%s' "$line" | cut -f4)"; fi
    [ -n "$since" ] || since="$NOW"; last="${last:-0}"
    if [ $((NOW - since)) -ge "$ALERT_DELAY" ] && { [ "$last" = 0 ] || [ $((NOW - last)) -ge "$ALERT_REPEAT" ]; }; then
      if notify "🔄 Synchro · $repo ($MACHINE) : $(label "$kind") — $detail"; then last="$NOW"; log "$repo : alerte envoyée ($kind)"; fi
    fi
    newstate="$newstate$repo"$'\t'"$kind"$'\t'"$since"$'\t'"$last"$'\t'"$detail"$'\n'
  done <<EOA
$ACTIVE
EOA
  # 2) anciens problèmes : disparus si le dépôt a fait un passage complet, sinon on les garde tels quels
  while IFS=$'\t' read -r repo kind since last detail; do
    [ -n "$repo" ] || continue
    printf '%s' "$ACTIVE" | awk -F'\t' -v r="$repo" -v k="$kind" '$1==r && $2==k {f=1} END {exit !f}' && continue
    if printf '%s' "$SEEN" | grep -qxF -- "$repo"; then
      if [ "${last:-0}" != 0 ]; then notify "✅ Synchro rétablie · $repo ($MACHINE) : $(label "$kind") résolu" && log "$repo : synchro rétablie ($kind)"; fi
    else
      newstate="$newstate$repo"$'\t'"$kind"$'\t'"$since"$'\t'"$last"$'\t'"$detail"$'\n'
    fi
  done < <(cat "$ALERTS" 2>/dev/null)
  printf '%s' "$newstate" > "$ALERTS"
}

# Contrôle des gros fichiers sur l'index ($1 = nom du dépôt ; s'exécute dans le shell principal pour que problem()/flag()
# enregistrent l'état persistant). Rend 0 si tout est contrôlé (les fichiers > MAXBYTES sont retirés de l'index), 1 si le
# contrôle est impossible : l'index est alors entièrement vidé (rien ne sera commité), le problème est consigné + alerté.
gate_gros_fichiers() {
  local n="$1" raw="$STATE/staged.raw" err="$STATE/catfile.err" meta f st nb=0 bigs="" i out typ size disp
  local -a paths=() oids=() bigidx=()
  controle_impossible() {
    git reset -q >/dev/null 2>&1
    problem "$n : contrôle de taille impossible ($1), rien n'est commité à ce passage"
    flag "$n" controle-taille "contrôle de taille impossible ($1), rien n'est commité"
    return 1
  }
  git diff --cached --no-renames --raw --no-abbrev -z > "$raw" 2>"$err" || { controle_impossible "git diff : $(tail -n 1 "$err" 2>/dev/null | cut -c1-80)"; return 1; }
  # Flux NUL : « :ancien-mode nouveau-mode ancien-oid nouvel-oid statut » puis le chemin exact. Suppressions et sous-modules ignorés.
  while IFS= read -r -d '' meta; do
    IFS= read -r -d '' f || { controle_impossible "liste d'index tronquée"; return 1; }
    set -- $meta
    st="${5:-}"
    case "$st" in D*) continue;; esac
    case "${2:-}" in 160000) continue;; esac
    case "${4:-}" in ''|*[!0-9a-f]*) controle_impossible "ligne d'index illisible"; return 1;; esac
    [ "${4#"${4%%[!0]*}"}" = "" ] && continue
    paths+=("$f"); oids+=("$4")
  done < "$raw"
  [ "${#oids[@]}" -gt 0 ] || return 0
  out="$(printf '%s\n' "${oids[@]}" | git cat-file --batch-check='%(objecttype) %(objectsize)' 2>"$err")" \
    || { controle_impossible "git cat-file : $(tail -n 1 "$err" 2>/dev/null | cut -c1-80)"; return 1; }
  i=0
  while read -r typ size; do
    [ "$i" -lt "${#oids[@]}" ] || { controle_impossible "réponse de cat-file trop longue"; return 1; }
    case "$typ:$size" in blob:''|blob:*[!0-9]*) controle_impossible "taille illisible"; return 1;; blob:*) ;; *) controle_impossible "objet $typ illisible"; return 1;; esac
    [ "$size" -gt "$MAXBYTES" ] && bigidx+=("$i")
    i=$((i + 1))
  done <<EOS
$out
EOS
  [ "$i" -eq "${#oids[@]}" ] || { controle_impossible "réponse de cat-file incomplète ($i/${#oids[@]})"; return 1; }
  for i in "${bigidx[@]+"${bigidx[@]}"}"; do
    f="${paths[$i]}"
    git --literal-pathspecs reset -q -- "$f" || { controle_impossible "retrait de l'index impossible"; return 1; }
    disp="${f//$'\n'/\\n}"
    problem "$n : $disp dépasse 5 Mo, non publié"; nb=$((nb + 1)); [ "$nb" -le 3 ] && bigs="$bigs${bigs:+, }$disp"
  done
  [ "$nb" -gt 0 ] && flag "$n" gros-fichier "$nb fichier(s) > 5 Mo non publié(s) : $bigs"
  return 0
}

for name in "$@"; do
  d="$ROOT/$name"
  [ -d "$d/.git" ] || continue
  cd "$d" || continue
  git remote get-url origin >/dev/null 2>&1 || { logchg "$name:remote" "$name : pas de remote, ignoré"; continue; }
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then problem "$name : opération git en cours, ignoré"; flag "$name" git-en-cours "rebase / fusion / opération git inachevée, dépôt ignoré"; continue; fi
  # Branche sans équivalent distant suivi (branche de travail locale) : on ne commite ni ne publie rien, sans bruit.
  if ! git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    key="$d:nosuivi"; [ "$(cat "$ROOT/.gh-sync.nosuivi" 2>/dev/null | grep -cxF "$key")" -gt 0 ] || { log "$name : branche $(git branch --show-current) sans suivi distant, ignoré"; echo "$key" >> "$ROOT/.gh-sync.nosuivi"; }
    continue
  fi
  # Ne jamais committer ces dossiers de travail
  mkdir -p .git/info; for p in .playwright-cli/ .foreman/ .unlazy/ .freebuff/ node_modules/ .venv/ venv/ __pycache__/ "*.pyc" .next/ .env ".env.*" ; do grep -qxF "$p" .git/info/exclude 2>/dev/null || echo "$p" >> .git/info/exclude; done

  if [ -n "$(git status --porcelain)" ]; then
    git add -A 2>/dev/null
    # gros fichiers : retirés de l'index (restent sur disque). Chemins gardés EXACTS de bout en bout (délimiteur NUL, aucun
    # `tr`/`read` ligne : espaces de tête ou de queue et retours à la ligne dans un nom restent intacts) ; tailles lues d'un
    # seul coup par `git cat-file --batch-check` (pas un `wc` par fichier : 5 000 fichiers = ~10 s sous verrou).
    # FERMÉ PAR DÉFAUT : si la taille d'un fichier ne peut pas être contrôlée, rien n'est commité à ce passage.
    gros_ok=1; gate_gros_fichiers "$name" || gros_ok=0
    # secrets dans les lignes ajoutées (les fichiers de test verify-* contiennent de faux jetons)
    hits="$(git diff --cached -U0 -- . ':!dashboard/scripts/verify-*' ':!*.lock' ':!package-lock.json' | grep -E '^\+[^+]' | grep -I -E "$SECRETS" | head -3 | sed -E 's/(.{40}).*/\1…/')"
    if [ -n "$hits" ]; then
      git reset -q; problem "$name : secret probable détecté, commit annulé : $hits"; flag "$name" secret "commit annulé, secret probable dans les changements locaux"
    elif [ "$gros_ok" = 1 ] && [ -n "$(git diff --cached --name-only | head -1)" ]; then
      n="$(git diff --cached --name-only | wc -l)"
      msg="$(commit_message)"
      "${GIT[@]}" commit -q -m "$msg" && log "$name : commit ($n fichier(s)) : $(printf '%s' "$msg" | head -n 1)"
    fi
  fi

  if ! out="$(tmo git pull --rebase --autostash -q 2>&1)"; then
    git rebase --abort >/dev/null 2>&1
    problem "$name : récupération impossible (conflit ou réseau) : $(echo "$out" | tail -1 | cut -c1-150)"
    if printf '%s' "$out" | grep -qiE 'conflict|conflit'; then flag "$name" conflit "$(echo "$out" | tail -1)"; else flag "$name" reseau "$(echo "$out" | tail -1)"; fi
    continue
  fi
  seen "$name"

  branchmode=0
  case " ${GH_SYNC_BRANCH_REPOS:-} " in *" $name "*) [ -d .github/workflows ] && branchmode=1;; esac
  if [ "$branchmode" = 1 ]; then
    main="$(git rev-parse --abbrev-ref '@{u}' | sed 's|^origin/||')"; sb="sync/$(echo "$HOST" | tr -c 'A-Za-z0-9\n' '-' | sed 's/-*$//')"
    if [ "$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)" -gt 0 ]; then
      if out="$(tmo git push --porcelain --force-with-lease origin "HEAD:refs/heads/$sb" 2>&1)"; then
        printf '%s\n' "$out" | grep -q $'^=\t' || log "$name : publié sur $sb"
      else problem "$name : publication sur $sb refusée : $(echo "$out" | tail -1 | cut -c1-150)"; flag "$name" publication "publication sur $sb refusée"; continue; fi
      sha="$(git rev-parse HEAD)"
      # stdout seul : un avertissement de gh sur stderr (mise à jour disponible…) ne doit pas masquer « completed/success »
      if st="$(tmo gh run list --branch "$sb" --commit "$sha" --limit 1 --json status,conclusion --jq '.[0] | "\(.status)/\(.conclusion)"' 2>"$STATE/gh.err")"; then
        st="$(printf '%s\n' "$st" | tr -d '\r' | grep -E '^[a-z_]+/[A-Za-z_]+$' | tail -n 1)"
        case "$st" in
          completed/success) if out="$(tmo git push -q origin "HEAD:refs/heads/$main" 2>&1)"; then log "$name : CI verte, fusionné dans $main"; else problem "$name : fusion dans $main impossible (pas en avance rapide ?) : $(echo "$out" | tail -1 | cut -c1-150)"; flag "$name" publication "fusion dans $main impossible"; fi;;
          # Une exécution annulée (remplacée par un push plus récent sur la même branche) n'est pas un échec : on attend.
          completed/cancelled) logchg "$name:ci" "$name : CI annulée sur $sb (remplacée par un commit plus récent), en attente";;
          completed/*) problem "$name : CI rouge sur $sb ($st), pas de fusion"; flag "$name" ci-rouge "CI rouge sur $sb ($st)";;
          *) logchg "$name:ci" "$name : CI en attente sur $sb ($st)";;
        esac
      else
        # gh absent ou non connecté : sans lui, rien ne serait jamais fusionné dans $main
        ghmsg="$(tail -n 1 "$STATE/gh.err" 2>/dev/null | tr -d '\r')"; [ -n "$ghmsg" ] || ghmsg="$(printf '%s' "$st" | tail -n 1)"
        problem "$name : lecture de la CI impossible (gh absent ou non connecté ?) : $(echo "$ghmsg" | cut -c1-150)"; flag "$name" ci-illisible "$ghmsg"
      fi
    fi
    continue
  fi
  ahead="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  if [ "${ahead:-0}" -gt 0 ]; then
    if out="$(tmo git push -q 2>&1)"; then log "$name : $ahead commit(s) publié(s)"; else problem "$name : publication refusée : $(echo "$out" | tail -1 | cut -c1-150)"; flag "$name" publication "$(echo "$out" | tail -1)"; fi
  fi
done
printf '%s' "$PROBNOW" > "$STATE/lastprob"
evaluate_alerts
exit 0
