$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tunnelExe = Join-Path $projectRoot 'data\tools\cloudflared.exe'
$statePath = Join-Path $projectRoot 'data\quick-tunnel.json'
$errorLog = Join-Path $projectRoot 'data\quick-tunnel.stderr.log'
$outputLog = Join-Path $projectRoot 'data\quick-tunnel.stdout.log'
if (!(Test-Path -LiteralPath $tunnelExe)) { throw 'cloudflared.exe is missing from data\tools.' }
if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $previous.processId -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $tunnelExe) {
        Write-Output "Quick Tunnel is already running: $($previous.url) (PID $($existing.Id))"
        exit 0
    }
}
$health = Invoke-RestMethod 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
if (!$health.ok) { throw 'The digital world service is not healthy on port 3000.' }
$tunnelProcess = Start-Process -FilePath $tunnelExe -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:3000') -WindowStyle Hidden -PassThru -RedirectStandardError $errorLog -RedirectStandardOutput $outputLog
$state = @{ processId = $tunnelProcess.Id; url = $null; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
$deadline = (Get-Date).AddSeconds(45)
do {
    Start-Sleep -Milliseconds 500
    $tunnelProcess.Refresh()
    $logText = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { '' }
    $urlMatch = [regex]::Match($logText, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($urlMatch.Success) {
        $state.url = $urlMatch.Value
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
        Write-Output "Public URL: $($state.url)"
        Write-Output "PID: $($state.processId)"
        Write-Output "Log: $errorLog"
        exit 0
    }
    if ($tunnelProcess.HasExited) { throw "cloudflared exited. See $errorLog" }
} while ((Get-Date) -lt $deadline)
throw "The tunnel is still starting. See $errorLog. Stop it with scripts\stop-quick-tunnel.ps1."
