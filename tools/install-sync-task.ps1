# Installe (ou réinstalle, de façon idempotente) la synchronisation GitHub toutes les minutes sur le mini-PC Windows.
# Crée la tâche planifiée « PosteSyncGitHub » : à l'ouverture de session puis toutes les minutes, sans fin, qui lance
#   bash.exe (Git for Windows)  ->  tools\gh-sync.sh D:\Projets <dépôts>   avec GH_SYNC_MACHINE=mini-pc et GH_SYNC_BRANCH_REPOS=paseo-lab.
# Remplace toute tâche existante dont l'action mentionne gh-sync (l'ancienne synchro, probablement cassée).
#
# Aucune fenêtre qui clignote : la tâche lance wscript.exe (programme graphique, sans console) sur un petit lanceur .vbs qui démarre
# bash.exe avec le style de fenêtre 0 (SW_HIDE) et attend sa fin ; bash.exe n'ouvre donc jamais de fenêtre visible. (Une tâche qui lance
# directement bash.exe ou powershell.exe ferait apparaître une console chaque minute, même avec -WindowStyle Hidden.)
# De plus, le lanceur copie gh-sync.sh avant de l'exécuter : la synchro met le dépôt à jour (git pull) et ne doit pas réécrire
# le script pendant que bash le lit.
#
# Usage (PowerShell, sur le mini-PC) :  pwsh -File D:\Projets\paseo-lab\tools\install-sync-task.ps1  [-Projets D:\Projets] [-Bash <chemin\bash.exe>]
param(
  [string]$Projets = 'D:\Projets',
  [string[]]$Repos = @('Bot_Stage', 'Automatisation PME', 'TelegramAssistant', 'BlastWin', 'paseo-lab', 'TestAgentMode', 'VentureOS'),
  [string]$Bash = '',
  [string]$TaskName = 'PosteSyncGitHub'
)
$ErrorActionPreference = 'Stop'
$lab = Split-Path -Parent $PSScriptRoot
$work = Join-Path $lab '.foreman'
New-Item -ItemType Directory -Force -Path $work | Out-Null

# 1) bash.exe de Git for Windows (jamais celui de WSL dans System32)
function Find-Bash {
  $c = @()
  if ($Bash) { $c += $Bash }
  $c += "$env:ProgramFiles\Git\bin\bash.exe", "$env:ProgramFiles\Git\usr\bin\bash.exe", "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\usr\bin\bash.exe"
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) { $root = Split-Path -Parent (Split-Path -Parent $git.Source); $c += (Join-Path $root 'bin\bash.exe'), (Join-Path $root 'usr\bin\bash.exe') }
  foreach ($p in $c) { if ($p -and (Test-Path $p) -and $p -notmatch '\\System32\\') { return (Resolve-Path $p).Path } }
  return $null
}
$bashExe = Find-Bash
if (-not $bashExe) { throw "bash.exe de Git for Windows introuvable. Installez Git for Windows ou passez -Bash 'C:\...\bash.exe'." }
if (-not (Test-Path (Join-Path $lab 'tools\gh-sync.sh'))) { throw "tools\gh-sync.sh introuvable dans $lab (faites d'abord : git -C $lab pull)." }

# 2) chemins POSIX pour Git Bash : D:\Projets -> /d/Projets
function ToPosix([string]$p) {
  $p = $p -replace '\\', '/'
  if ($p -match '^([A-Za-z]):(.*)$') { return '/' + $Matches[1].ToLower() + $Matches[2] }
  return $p
}
$labPosix = ToPosix $lab; $projPosix = ToPosix $Projets
$q = ($Repos | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '

# 3) script de lancement (bash) : copie fraîche de gh-sync.sh puis exécution
$runSh = Join-Path $work 'gh-sync-run.sh'
$sh = @"
#!/usr/bin/env bash
# Généré par tools/install-sync-task.ps1 — ne pas éditer (régénéré à chaque installation).
export PATH="/usr/bin:/mingw64/bin:`$PATH"
export GH_SYNC_MACHINE=mini-pc
export GH_SYNC_BRANCH_REPOS=paseo-lab
cp -f '$labPosix/tools/gh-sync.sh' '$labPosix/.foreman/gh-sync.run.sh' || exit 0
exec bash '$labPosix/.foreman/gh-sync.run.sh' '$projPosix' $q
"@
[IO.File]::WriteAllText($runSh, ($sh -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))

# 4) lanceur caché (.vbs) : Run(commande, 0 = fenêtre masquée, True = attendre la fin)
$vbs = Join-Path $work 'gh-sync-launcher.vbs'
$cmd = '"' + $bashExe + '" "' + ($runSh -replace '\\', '/') + '"'
$vbsText = "Set sh = CreateObject(""WScript.Shell"")`r`nsh.CurrentDirectory = """ + $Projets + """`r`nWScript.Quit sh.Run(""" + ($cmd -replace '"', '""') + """, 0, True)`r`n"
[IO.File]::WriteAllText($vbs, $vbsText, [Text.Encoding]::ASCII)

# 5) retire les anciennes tâches de synchro (action ou script cité mentionnant gh-sync) et l'ancienne version de celle-ci
$removed = @()
foreach ($t in Get-ScheduledTask -ErrorAction SilentlyContinue) {
  if ($t.TaskPath -like '\Microsoft*') { continue }
  $hit = $false
  foreach ($a in $t.Actions) {
    $line = "$($a.Execute) $($a.Arguments)"
    if ($line -match 'gh-sync') { $hit = $true }
    else {
      # l'action pointe peut-être vers un .vbs/.cmd/.bat/.ps1 qui, lui, mentionne gh-sync
      foreach ($m in [regex]::Matches($line, '[A-Za-z]:\\[^"<>|]+?\.(vbs|cmd|bat|ps1|sh)')) {
        $f = $m.Value
        if ((Test-Path $f) -and (Get-Item $f).Length -lt 65536 -and ((Get-Content -Raw -ErrorAction SilentlyContinue $f) -match 'gh-sync')) { $hit = $true }
      }
    }
  }
  if ($hit -or $t.TaskName -eq $TaskName) {
    Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false
    $removed += "$($t.TaskPath)$($t.TaskName)"
  }
}

# 6) nouvelle tâche : à l'ouverture de session, puis répétée chaque minute sans fin
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//B //Nologo "{0}"' -f $vbs) -WorkingDirectory $Projets
# Deux déclencheurs : un à l'ouverture de session (premier passage immédiat) et un « une fois » répété chaque minute pendant 10 ans.
# -RepetitionDuration est obligatoire sur certaines builds de Windows PowerShell 5.1 (sans lui : « Duration… is required » / intervalle refusé) ;
# on n'affecte plus $trigger.Repetition (objet CIM désérialisé, non assignable depuis pwsh 7) : même code sous PowerShell 5.1 et pwsh 7.
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$trigger = @($logon, $repeat)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Synchronisation GitHub toutes les minutes (gh-sync.sh, mode branche pour paseo-lab)' | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Tâche « $TaskName » installée : toutes les minutes, sans fenêtre."
if ($removed.Count) { Write-Host "Anciennes tâches de synchro supprimées : $($removed -join ', ')" } else { Write-Host 'Aucune ancienne tâche de synchro trouvée.' }
Write-Host "  bash        : $bashExe"
Write-Host "  lanceur     : $vbs"
Write-Host "  dossiers    : $Projets  ($($Repos -join ', '))"
Write-Host 'Vérifier :'
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult, NextRunTime"
Write-Host "  Get-Content '$Projets\.gh-sync.log' -Tail 20        # journal de la synchro"
Write-Host "  Get-Content '$Projets\SYNC-PROBLEMES.log' -Tail 10  # problèmes éventuels"
