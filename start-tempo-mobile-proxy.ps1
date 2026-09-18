[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$tempoProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tempoNodePath = "C:\Program Files\nodejs\node.exe"
$tempoProxyScriptPath = Join-Path $tempoProjectRoot "mobile-proxy.mjs"
$tempoLogDirectory = Join-Path $tempoProjectRoot ".tempo-server"
$tempoAccessTokenPath = Join-Path $tempoLogDirectory "mobile-access-token.txt"
$tempoProxyLogPath = Join-Path $tempoLogDirectory "mobile-proxy.log"
$tempoProxyErrorLogPath = Join-Path $tempoLogDirectory "mobile-proxy-error.log"

New-Item -ItemType Directory -Path $tempoLogDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $tempoAccessTokenPath)) {
  $tempoTokenBytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tempoTokenBytes)
  $tempoAccessToken = [Convert]::ToBase64String($tempoTokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  Set-Content -LiteralPath $tempoAccessTokenPath -Value $tempoAccessToken -Encoding ASCII -NoNewline
}

Set-Location -LiteralPath $tempoProjectRoot

while ($true) {
  try {
    & $tempoNodePath $tempoProxyScriptPath >> $tempoProxyLogPath 2>> $tempoProxyErrorLogPath
  } catch {
    "[$(Get-Date -Format o)] $($_.Exception.Message)" | Out-File -FilePath $tempoProxyErrorLogPath -Append
  }

  "[$(Get-Date -Format o)] TEMPO mobile access stopped. Restarting in 5 seconds." | Out-File -FilePath $tempoProxyErrorLogPath -Append
  Start-Sleep -Seconds 5
}
