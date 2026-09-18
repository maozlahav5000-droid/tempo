[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$tempoProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tempoLogDirectory = Join-Path $tempoProjectRoot ".tempo-server"
$tempoWatchdogLogPath = Join-Path $tempoLogDirectory "watchdog.log"
$tempoServerTaskName = "TEMPO Local Server"
$tempoWranglerConfigPath = Join-Path $tempoProjectRoot "dist\server\wrangler.json"
$tempoHealthUrls = @(
  "http://127.0.0.1:3000/",
  "http://127.0.0.1:3000/api/notes",
  "http://127.0.0.1:3000/api/library",
  "http://127.0.0.1:3000/api/folders"
)

New-Item -ItemType Directory -Path $tempoLogDirectory -Force | Out-Null

$tempoHealthy = $true
foreach ($tempoHealthUrl in $tempoHealthUrls) {
  try {
    $tempoResponse = Invoke-WebRequest -Uri $tempoHealthUrl -UseBasicParsing -TimeoutSec 5
    if ($tempoResponse.StatusCode -ne 200) {
      $tempoHealthy = $false
      break
    }
  } catch {
    $tempoHealthy = $false
    break
  }
}

if ($tempoHealthy) {
  exit 0
}

try {
  $tempoTask = Get-ScheduledTask -TaskName $tempoServerTaskName -ErrorAction Stop
  $tempoTaskInfo = Get-ScheduledTaskInfo -TaskName $tempoServerTaskName -ErrorAction Stop

  # Give a newly launched server enough time to open the local port.
  if ($tempoTask.State -eq "Running" -and ((Get-Date) - $tempoTaskInfo.LastRunTime).TotalSeconds -lt 90) {
    exit 0
  }

  "[$(Get-Date -Format o)] TEMPO health check failed. Restarting the server task." | Out-File -FilePath $tempoWatchdogLogPath -Append

  if ($tempoTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $tempoServerTaskName -ErrorAction SilentlyContinue
    for ($tempoStopAttempt = 0; $tempoStopAttempt -lt 10; $tempoStopAttempt++) {
      Start-Sleep -Seconds 1
      $tempoTask = Get-ScheduledTask -TaskName $tempoServerTaskName -ErrorAction Stop
      if ($tempoTask.State -ne "Running") {
        break
      }
    }
  }

  # Task Scheduler can stop the wrapper while leaving Wrangler/workerd orphaned.
  # Remove only this project's server process tree so port 3000 can be reopened.
  $tempoProcesses = @(Get-CimInstance Win32_Process)
  $tempoServerRoots = @($tempoProcesses | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.Contains($tempoWranglerConfigPath) -and
    $_.CommandLine.Contains("--port 3000")
  })
  $tempoServerProcessIds = [System.Collections.Generic.List[int]]::new()
  $tempoSeenProcessIds = [System.Collections.Generic.HashSet[int]]::new()

  foreach ($tempoServerRoot in $tempoServerRoots) {
    if ($tempoSeenProcessIds.Add([int]$tempoServerRoot.ProcessId)) {
      $tempoServerProcessIds.Add([int]$tempoServerRoot.ProcessId)
    }
  }

  for ($tempoProcessIndex = 0; $tempoProcessIndex -lt $tempoServerProcessIds.Count; $tempoProcessIndex++) {
    $tempoParentProcessId = $tempoServerProcessIds[$tempoProcessIndex]
    foreach ($tempoChildProcess in $tempoProcesses | Where-Object { $_.ParentProcessId -eq $tempoParentProcessId }) {
      if ($tempoSeenProcessIds.Add([int]$tempoChildProcess.ProcessId)) {
        $tempoServerProcessIds.Add([int]$tempoChildProcess.ProcessId)
      }
    }
  }

  for ($tempoProcessIndex = $tempoServerProcessIds.Count - 1; $tempoProcessIndex -ge 0; $tempoProcessIndex--) {
    Stop-Process -Id $tempoServerProcessIds[$tempoProcessIndex] -Force -ErrorAction SilentlyContinue
  }

  for ($tempoPortWaitAttempt = 0; $tempoPortWaitAttempt -lt 10; $tempoPortWaitAttempt++) {
    if (-not (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Seconds 1
  }

  Start-ScheduledTask -TaskName $tempoServerTaskName -ErrorAction Stop
} catch {
  "[$(Get-Date -Format o)] Watchdog error: $($_.Exception.Message)" | Out-File -FilePath $tempoWatchdogLogPath -Append
  exit 1
}

exit 0
