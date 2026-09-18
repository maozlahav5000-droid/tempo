[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$tempoProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tempoNodePath = "C:\Program Files\nodejs\node.exe"
$tempoWranglerCliPath = Join-Path $tempoProjectRoot "node_modules\wrangler\bin\wrangler.js"
$tempoWranglerConfigPath = Join-Path $tempoProjectRoot "dist\server\wrangler.json"
$tempoStatePath = Join-Path $tempoProjectRoot ".wrangler\state"
$tempoLogDirectory = Join-Path $tempoProjectRoot ".tempo-server"
$tempoOutputLogPath = Join-Path $tempoLogDirectory "server.log"
$tempoErrorLogPath = Join-Path $tempoLogDirectory "server-error.log"

New-Item -ItemType Directory -Path $tempoLogDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $tempoNodePath)) {
  "[$(Get-Date -Format o)] Node.js was not found at $tempoNodePath" | Out-File -FilePath $tempoErrorLogPath -Append
  exit 1
}

if (-not (Test-Path -LiteralPath $tempoWranglerCliPath)) {
  "[$(Get-Date -Format o)] Wrangler was not found at $tempoWranglerCliPath" | Out-File -FilePath $tempoErrorLogPath -Append
  exit 1
}

if (-not (Test-Path -LiteralPath $tempoWranglerConfigPath)) {
  "[$(Get-Date -Format o)] The TEMPO production build was not found at $tempoWranglerConfigPath" | Out-File -FilePath $tempoErrorLogPath -Append
  exit 1
}

Set-Location -LiteralPath $tempoProjectRoot
$env:WRANGLER_LOG_PATH = Join-Path $tempoProjectRoot ".wrangler\wrangler.log"

while ($true) {
  "[$(Get-Date -Format o)] Starting TEMPO at http://127.0.0.1:3000/" | Out-File -FilePath $tempoOutputLogPath -Append

  try {
    & $tempoNodePath $tempoWranglerCliPath dev --config $tempoWranglerConfigPath --local --ip 127.0.0.1 --port 3000 --persist-to $tempoStatePath --no-show-interactive-dev-session >> $tempoOutputLogPath 2>> $tempoErrorLogPath
  } catch {
    "[$(Get-Date -Format o)] $($_.Exception.Message)" | Out-File -FilePath $tempoErrorLogPath -Append
  }

  "[$(Get-Date -Format o)] TEMPO stopped unexpectedly. Restarting in 5 seconds." | Out-File -FilePath $tempoErrorLogPath -Append
  Start-Sleep -Seconds 5
}
