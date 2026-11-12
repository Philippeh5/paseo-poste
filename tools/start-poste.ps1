# Démarre ce qui doit tourner sur ce PC à l'ouverture de session Windows (tâche planifiée « PosteDeCommande »).
# - Toujours : le daemon Paseo (:6767, local) — il exécute les sessions de ce PC ; le tunnel inverse vers Oracle n'est pas géré ici (voir plus bas).
# - Poste de commande (PC principal) : le dashboard (:7070 + écouteur Tailscale).
# - Mini-PC « ouvrier » (COMPUTERNAME = WIN-3LLN0L8LRLM, ou POSTE_ROLE=ouvrier) : PAS de dashboard (le poste unique est sur Oracle) ;
#   à la place, tools\redirect-poste.mjs répond sur :7070 par une redirection vers Oracle. Voir deploy\mini-pc\README.md.
# Ne relance que ce qui ne tourne pas.
$ErrorActionPreference = 'Continue'
$lab = Split-Path -Parent $PSScriptRoot
$log = Join-Path $lab '.foreman\start-poste.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($m) { "$(Get-Date -Format 's') $m" | Add-Content -Path $log }
function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
# Processus dont la ligne de commande contient le motif (ex. 'dashboard\server.mjs') ; jamais d'arrêt aveugle de « node »
function ProcByCmd($pattern) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$pattern*" -and $_.ProcessId -ne $PID }
}
# L'ancien dashboard : le processus node qui ÉCOUTE sur 7070 et dont la ligne de commande est « node server.mjs » / « …dashboard\server.mjs »
# (start-dashboard.ps1 le lance depuis le dossier dashboard, donc souvent sans le chemin complet)
function OldDashboard {
  foreach ($c in @(Get-NetTCPConnection -LocalPort 7070 -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -like '*server.mjs*') { return $p }
  }
  return $null
}
$ouvrier = ($env:COMPUTERNAME -eq 'WIN-3LLN0L8LRLM') -or ($env:POSTE_ROLE -eq 'ouvrier')

Set-Location $lab
if (-not (Listening 6767)) {
  Log 'daemon Paseo : démarrage'
  & npx paseo daemon start --home (Join-Path $lab 'home') *>> $log
  for ($i = 0; $i -lt 30 -and -not (Listening 6767); $i++) { Start-Sleep 1 }
}
Log "daemon Paseo : $(if (Listening 6767) { 'ok' } else { 'ABSENT' })"

# Tunnel SSH inverse mini-PC -> Oracle (127.0.0.1:6768 côté Oracle = le daemon de ce PC). Il n'est pas lancé par ce script ni par
# le dépôt (tâche ou service créé à la main) : on ne le touche pas, on journalise seulement s'il est là, pour diagnostic.
$tun = @(ProcByCmd '6768') | Where-Object { $_.Name -match 'ssh' }
Log "tunnel inverse Oracle (ssh ... 6768) : $(if ($tun) { 'présent' } else { 'ABSENT (non géré ici, à relancer à la main)' })"

if ($ouvrier) {
  # Plus de dashboard ici : une seule fenêtre de commande, sur Oracle.
  if (OldDashboard) {
    Log 'poste : ANCIEN dashboard encore actif sur ce PC — l''arrêter (deploy\mini-pc\README.md), la redirection ne démarre pas'
  } elseif (ProcByCmd 'redirect-poste.mjs') {
    Log 'redirection vers Oracle : déjà active'
  } else {
    Log 'redirection vers Oracle : démarrage'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Log 'redirection : node introuvable dans le PATH' }
    else {
      Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList ('"{0}"' -f (Join-Path $lab 'tools\redirect-poste.mjs')) `
        -RedirectStandardOutput (Join-Path $lab '.foreman\redirect-poste.log') -RedirectStandardError (Join-Path $lab '.foreman\redirect-poste.err')
      for ($i = 0; $i -lt 15 -and -not (Listening 7070); $i++) { Start-Sleep 1 }
    }
  }
  Log "redirection :7070 : $(if (Listening 7070) { 'ok' } else { 'ABSENTE' })"
} else {
  if (-not (Listening 7070)) {
    Log 'dashboard : démarrage'
    Start-Process -WindowStyle Hidden -FilePath pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $lab 'dashboard\start-dashboard.ps1') `
      -RedirectStandardOutput (Join-Path $lab '.foreman\dashboard-7070.log') -RedirectStandardError (Join-Path $lab '.foreman\dashboard-7070.err')
    for ($i = 0; $i -lt 30 -and -not (Listening 7070); $i++) { Start-Sleep 1 }
  }
  Log "dashboard : $(if (Listening 7070) { 'ok' } else { 'ABSENT' })"
}
