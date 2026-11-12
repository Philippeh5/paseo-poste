<#
.SYNOPSIS
  Planifie (Planificateur de tâches Windows) la relance automatique de l'autopilot.
  Crée deux tâches ponctuelles: une à l'heure demandée, une de secours 45 minutes plus tard
  (le script de relance ne fait rien si une session travaille déjà).

.PARAMETER At
  Date et heure locales de la première relance, par exemple '2026-10-14 06:03'.

.EXAMPLE
  powershell -File tools\schedule-resume.ps1 -At '2026-10-14 06:03'
#>
param([Parameter(Mandatory = $true)][string]$At)

$when = [datetime]::Parse($At, [System.Globalization.CultureInfo]::InvariantCulture)
$script = 'D:\Projets\AI-OS\paseo-lab\tools\resume-autopilot.ps1'
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""

foreach ($pair in @(@('ClaudeAutopilotResume-A', $when), @('ClaudeAutopilotResume-B', $when.AddMinutes(45)))) {
    $name = $pair[0]; $time = $pair[1]
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trigger = New-ScheduledTaskTrigger -Once -At $time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description 'Relance automatique de la session Claude (autopilot paseo-lab)' | Out-Null
    '{0}: {1:yyyy-MM-dd HH:mm}' -f $name, $time
}
