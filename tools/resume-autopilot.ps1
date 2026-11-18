<#
.SYNOPSIS
  Rouvre une session Claude Code qui reprend le travail autopilot du projet paseo-poste.
  Appelé par le Planificateur de tâches à l'heure où la fenêtre de quota Claude se remet à zéro.

  Garde-fou anti-doublon: si le carnet .foreman/ledger.md a été modifié il y a moins de $MinIdleMinutes
  minutes, une session travaille déjà: on ne fait rien.
#>
param(
    [int]$MinIdleMinutes = 10,
    [string]$Project = 'D:\Projets\AI-OS\paseo-poste'
)

$ledger = Join-Path $Project '.foreman\ledger.md'
$log = Join-Path $Project '.foreman\resume-autopilot.log'
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -ErrorAction SilentlyContinue }

if (Test-Path $ledger) {
    $idle = (New-TimeSpan -Start (Get-Item $ledger).LastWriteTime -End (Get-Date)).TotalMinutes
    if ($idle -lt $MinIdleMinutes) {
        Log ("Session déjà active (carnet modifié il y a {0:N1} min): rien à faire." -f $idle)
        exit 0
    }
}

$prompt = @"
Reprends le travail autopilot sur D:\Projets\AI-OS\paseo-poste (la limite de session Claude vient de se remettre à zéro, Philippe n'est pas là).
1) Lis D:\Projets\AI-OS\paseo-poste\RESUME.md PUIS .foreman\ledger.md en entier. 2) Réconcilie avec l'état réel avant tout: syntaxe des fichiers, serveur du dashboard sur 7070 (relance-le s'il est arrêté, seulement le PID qui écoute), suites dashboard\scripts\verify-*.mjs, état git des agents encore actifs. 3) Continue le backlog de RESUME.md dans l'ordre, sans demander de confirmation entre les tâches (mode autopilot, mêmes règles et mêmes garde-fous qu'avant). 4) Utilise agy (gemini-3.8-flash-high) en priorité, Sonnet avec parcimonie, jamais Codex; vérifie toi-même chaque livraison. 5) Avant que ta session atteigne sa limite, relance tools\schedule-resume.ps1 avec l'heure de la prochaine remise à zéro (lue dans l'usage Claude de Paseo) pour que le travail reparte seul.
"@

Log "Relance autopilot: ouverture d'une session Claude."
& 'C:\Scripts\open-claude-window.ps1' -Path $Project -Prompt $prompt
