$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tunnelExe = Join-Path $projectRoot 'data\tools\cloudflared.exe'
$statePath = Join-Path $projectRoot 'data\quick-tunnel.json'
if (!(Test-Path -LiteralPath $statePath)) { Write-Output 'No saved Quick Tunnel.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$tunnelProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
if ($tunnelProcess) {
    if ($tunnelProcess.Path -ne $tunnelExe) { throw 'The saved PID belongs to another program; it was not stopped.' }
    Stop-Process -Id $tunnelProcess.Id
}
Remove-Item -LiteralPath $statePath
Write-Output 'Quick Tunnel stopped. The local world service is still running.'
