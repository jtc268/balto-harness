param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [ValidateRange(1, 10)]
  [int]$Iterations = 3,
  [ValidateRange(2, 30)]
  [int]$TimeoutMinutes = 12
)

$ErrorActionPreference = 'Stop'
$localAppData = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)).TrimEnd('\')
$dataPath = Join-Path $localAppData 'com.adore.balto-speedrunner'
$installRoot = Join-Path $localAppData 'Balto Speedrunner'
$appExe = Join-Path $installRoot 'balto-speedrunner.exe'
$installerPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Installer))
$qaRoot = Join-Path $localAppData ("Balto-QA-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$originalBackup = Join-Path $qaRoot 'original-user-data'
$failedData = Join-Path $qaRoot 'failed-cycle-data'
$results = [System.Collections.Generic.List[object]]::new()

function Assert-SafeQaPath([string]$PathValue) {
  $fullPath = [System.IO.Path]::GetFullPath($PathValue)
  if (-not $fullPath.StartsWith($localAppData + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe QA path outside LocalAppData: $fullPath"
  }
  if ([string]::Equals($fullPath, $localAppData, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to operate on the LocalAppData root.'
  }
  return $fullPath
}

function Stop-BaltoUiAndServices([string]$RuntimeData) {
  Get-Process 'balto-speedrunner' -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'powershell.exe' -and
    $_.CommandLine -like '*Balto Speedrunner\runtime\balto.ps1*' -and
    $_.CommandLine -like '*com.adore.balto-speedrunner*'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $runtimePrefix = [System.IO.Path]::GetFullPath((Join-Path $RuntimeData 'runtime')).TrimEnd('\') + '\'
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $needles = @{
    'workspace.pid' = 'dsh\lib\bin.js'
    'gateway.pid' = 'gateway.mjs'
  }
  foreach ($entry in $needles.GetEnumerator()) {
    $pidPath = Join-Path $RuntimeData "pids\$($entry.Key)"
    if (-not (Test-Path -LiteralPath $pidPath)) { continue }
    try {
      $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
      if ($process -and $process.CommandLine -like "*$($entry.Value)*") {
        Stop-Process -Id $processId -Force
      }
    }
    catch {}
  }
  Start-Sleep -Milliseconds 800
}

function Remove-QaTree([string]$PathValue) {
  $confirmedPath = Assert-SafeQaPath $PathValue
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    if (-not (Test-Path -LiteralPath $confirmedPath)) { return }
    try {
      Remove-Item -LiteralPath $confirmedPath -Recurse -Force
      return
    }
    catch {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

function Install-Balto {
  $setup = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 400
    $setup.Refresh()
  } while (-not $setup.HasExited -and (Get-Date) -lt $deadline)
  if (-not $setup.HasExited) { throw 'The Windows installer did not finish within two minutes.' }
  if ($setup.ExitCode -ne 0) { throw "The Windows installer exited with code $($setup.ExitCode)." }
  if (-not (Test-Path -LiteralPath $appExe)) { throw 'The Balto application was not installed.' }
}

function Start-BaltoUi {
  if (-not (Get-Process 'balto-speedrunner' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $appExe | Out-Null
  }
}

function Stop-BaltoWorkspaceForRecoveryQa {
  $pidPath = Join-Path $dataPath 'pids\workspace.pid'
  if (-not (Test-Path -LiteralPath $pidPath)) { throw 'The workspace PID file is missing.' }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if (-not $process -or $process.CommandLine -notlike '*dsh\lib\bin.js*') {
    throw 'The workspace PID did not identify the Balto workspace process.'
  }
  Stop-Process -Id $processId -Force
  return $processId
}

function Wait-ForWatchdogRecovery([int]$Cycle, [int]$StoppedProcessId) {
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $pidPath = Join-Path $dataPath 'pids\workspace.pid'
    $statePath = Join-Path $dataPath 'state.json'
    if ((Test-Path -LiteralPath $pidPath) -and (Test-Path -LiteralPath $statePath)) {
      try {
        $newProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($newProcessId -ne $StoppedProcessId -and $state.phase -eq 'ready' -and $state.workspaceReady) {
          $process = Get-CimInstance Win32_Process -Filter "ProcessId = $newProcessId"
          $workspace = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080/' -TimeoutSec 5).StatusCode
          if ($process.CommandLine -like '*dsh\lib\bin.js*' -and $workspace -eq 200) {
            Write-Host "Cycle ${Cycle}: watchdog recovery pass"
            return $newProcessId
          }
        }
      }
      catch {}
    }
    Start-Sleep -Seconds 2
  }
  throw "Cycle $Cycle did not recover the coding workspace within 90 seconds."
}

function Wait-ForCleanReady([int]$Cycle) {
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $lastMarker = ''
  while ((Get-Date) -lt $deadline) {
    $statePath = Join-Path $dataPath 'state.json'
    if (Test-Path -LiteralPath $statePath) {
      try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $marker = "$($state.phase)|$($state.progress)|$($state.stage)"
        if ($marker -ne $lastMarker) {
          Write-Host "Cycle ${Cycle}: $($state.progress)% $($state.phase) $($state.message)"
          $lastMarker = $marker
        }
        if ($state.phase -eq 'failed') {
          throw "Cycle $Cycle entered a failed phase: $($state.message)"
        }
        if ($state.phase -eq 'ready' -and $state.inferenceReady -and $state.workspaceReady) {
          $backend = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:30000/health' -TimeoutSec 10).StatusCode
          $workspace = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080/' -TimeoutSec 10).StatusCode
          if ($backend -ne 200 -or $workspace -ne 200) { throw "Cycle $Cycle services were not healthy." }
          $logPath = Join-Path $dataPath 'balto.log'
          if ((Get-Content -LiteralPath $logPath -Raw) -match 'Action failed:') {
            throw "Cycle $Cycle logged an action failure."
          }
          return [pscustomobject]@{
            cycle = $Cycle
            version = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
            backend = $backend
            workspace = $workspace
            readyAt = (Get-Date).ToUniversalTime().ToString('o')
          }
        }
      }
      catch {
        if ($_.Exception.Message -like "Cycle $Cycle*") { throw }
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "Cycle $Cycle did not become ready within $TimeoutMinutes minutes."
}

$dataPath = Assert-SafeQaPath $dataPath
$qaRoot = Assert-SafeQaPath $qaRoot
$originalBackup = Assert-SafeQaPath $originalBackup
$failedData = Assert-SafeQaPath $failedData
New-Item -ItemType Directory -Path $qaRoot | Out-Null
$originalMoved = $false
$cycleRunning = $false

try {
  Stop-BaltoUiAndServices $dataPath
  if (Test-Path -LiteralPath $dataPath) {
    Move-Item -LiteralPath $dataPath -Destination $originalBackup
    $originalMoved = $true
  }

  for ($cycle = 1; $cycle -le $Iterations; $cycle++) {
    $cycleRunning = $true
    Write-Host "Cycle ${cycle}: installing $installerPath"
    Install-Balto
    Start-BaltoUi
    $result = Wait-ForCleanReady $cycle
    $stoppedWorkspacePid = Stop-BaltoWorkspaceForRecoveryQa
    $recoveredWorkspacePid = Wait-ForWatchdogRecovery $cycle $stoppedWorkspacePid
    $result | Add-Member -NotePropertyName watchdogRecovery -NotePropertyValue $true
    $result | Add-Member -NotePropertyName recoveredWorkspacePid -NotePropertyValue $recoveredWorkspacePid
    $results.Add($result)
    Write-Host "Cycle ${cycle}: clean pass"

    Stop-BaltoUiAndServices $dataPath
    if (Test-Path -LiteralPath $dataPath) {
      Remove-QaTree $dataPath
    }
    $cycleRunning = $false
  }
}
catch {
  Write-Host "QA failure: $($_.Exception.Message)"
  Stop-BaltoUiAndServices $dataPath
  if ($cycleRunning -and (Test-Path -LiteralPath $dataPath)) {
    Move-Item -LiteralPath $dataPath -Destination $failedData
  }
  throw
}
finally {
  Stop-BaltoUiAndServices $dataPath
  if (Test-Path -LiteralPath $dataPath) {
    Remove-QaTree $dataPath
  }
  if ($originalMoved -and (Test-Path -LiteralPath $originalBackup)) {
    Move-Item -LiteralPath $originalBackup -Destination $dataPath
  }
  if ((Test-Path -LiteralPath $qaRoot) -and @(Get-ChildItem -LiteralPath $qaRoot -Force).Count -eq 0) {
    Remove-Item -LiteralPath $qaRoot -Force
  }
  Start-BaltoUi
}

$results | ConvertTo-Json -Depth 4
