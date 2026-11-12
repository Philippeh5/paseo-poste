# Géré par tools/tailscale-setup.mjs — peut être régénéré, ne contient aucun secret.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:DASHBOARD_TAILSCALE = '1'
$env:TELEGRAM_AUTOSTART = '0'   # Telegram est désormais géré par Hermes sur Oracle
$env:DASHBOARD_TAILSCALE_PASSWORD = (Get-Content -Raw (Join-Path $PSScriptRoot 'data\tailscale-password.txt')).Trim()
$env:DASHBOARD_TAILSCALE_USER = 'Philippe'
$env:DASHBOARD_TAILSCALE_MIN_PASSWORD = '6'
node server.mjs
