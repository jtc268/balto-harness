param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'setup', 'start', 'stop', 'restart-workspace', 'remote-on', 'remote-off')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$BaltoData,
  [Parameter(Mandatory = $true)]
  [string]$Resources,
  [string]$AppExe
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertFrom-ExtendedWindowsPath([string]$PathValue) {
  if (-not $PathValue) { return $PathValue }
  if ($PathValue.StartsWith('\\?\UNC\')) { return '\\' + $PathValue.Substring(8) }
  if ($PathValue.StartsWith('\\?\')) { return $PathValue.Substring(4) }
  return $PathValue
}

$BaltoData = ConvertFrom-ExtendedWindowsPath $BaltoData
$Resources = ConvertFrom-ExtendedWindowsPath $Resources
$AppExe = ConvertFrom-ExtendedWindowsPath $AppExe

$statePath = Join-Path $BaltoData 'state.json'
$stateTempPath = Join-Path $BaltoData 'state.json.tmp'
$logPath = Join-Path $BaltoData 'balto.log'
$runtimeRoot = Join-Path $BaltoData 'runtime'
$dshRoot = Join-Path $runtimeRoot 'dsh'
$dshHome = Join-Path $BaltoData 'home'
$pidRoot = Join-Path $BaltoData 'pids'
$documentsRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
if (-not $documentsRoot) { $documentsRoot = Join-Path $env:USERPROFILE 'Documents' }
$workspaceRoot = Join-Path $documentsRoot 'Balto'
$nodeVersion = '22.22.1'
$nodeFolder = "node-v$nodeVersion-win-x64"
$nodeRoot = Join-Path $runtimeRoot $nodeFolder
$nodeExe = Join-Path $nodeRoot 'node.exe'
$npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
$containerName = 'balto-qwen38'
$containerImage = 'lmsysorg/sglang@sha256:febfb971c7352570fc445c466ebd6ffc9d896024958e544a60f2137fd85856b1'
$containerConfig = 'qwen38-nvfp4-dspark-80k-v1'
$modelName = 'RadixArk/Qwen3.8-27B-NVFP4'
$draftName = 'RadixArk/Qwen3.8-27B-DSpark'

New-Item -ItemType Directory -Force -Path $BaltoData, $runtimeRoot, $dshHome, $pidRoot, $workspaceRoot | Out-Null

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  [System.IO.File]::AppendAllText($logPath, "[$stamp] $Message`r`n")
}

function ConvertTo-NativeArgument([AllowEmptyString()][string]$Argument) {
  if ($null -eq $Argument -or $Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
      [void]$builder.Append('\"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Invoke-HiddenNativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $process = $null
  try {
    # Native tools routinely write normal progress and warnings to stderr.
    # Use Process directly so PowerShell can never mistake those lines for failures.
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start $Prefix." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $exitCode = $process.ExitCode
  }
  finally {
    if ($process) { $process.Dispose() }
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = $stdout
    StdErr = $stderr
  }
}

function Invoke-HiddenNativeNoOutput {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::new()
  try {
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start $FilePath." }
    $process.WaitForExit()
    return $process.ExitCode
  }
  finally {
    $process.Dispose()
  }
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$Prefix,
    [switch]$AllowFailure
  )

  $result = Invoke-HiddenNativeCapture -FilePath $FilePath -Arguments $Arguments
  foreach ($stream in @($result.StdOut, $result.StdErr)) {
    foreach ($line in ($stream -split '\r?\n')) {
      if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Log "${Prefix}: $line" }
    }
  }
  if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "$Prefix exited with code $($result.ExitCode). Open the setup log for details."
  }
}

function New-DefaultState {
  @{
    phase = 'not-installed'
    stage = 'system-check'
    message = 'Ready to inspect this PC.'
    progress = 0
    startedAt = $null
    downloadedGb = $null
    downloadTotalGb = 24
    downloadRateMbps = $null
    etaSeconds = $null
    gpuName = $null
    gpuMemoryMib = $null
    gpuMemoryUsedMib = $null
    dockerInstalled = $false
    dockerReady = $false
    tailscaleInstalled = $false
    tailscaleSignedIn = $false
    tailscaleDnsName = $null
    remoteEnabled = $false
    remoteUrl = $null
    inferenceReady = $false
    workspaceReady = $false
    warning = $null
    updatedAt = $null
  }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath)) { return New-DefaultState }
  try {
    $loaded = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state = New-DefaultState
    foreach ($property in $loaded.PSObject.Properties) { $state[$property.Name] = $property.Value }
    $state.Remove('competingModels')
    return $state
  }
  catch {
    Write-Log "State was unreadable and will be rebuilt: $($_.Exception.Message)"
    return New-DefaultState
  }
}

function Save-State($State) {
  $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $json = $State | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($stateTempPath, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $stateTempPath -Destination $statePath -Force
}

function Update-State([hashtable]$Values) {
  $state = Read-State
  foreach ($key in $Values.Keys) { $state[$key] = $Values[$key] }
  Save-State $state
}

function Enable-SetupResume {
  if (-not $AppExe -or -not (Test-Path -LiteralPath $AppExe)) { return }
  $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-Item -Path $runPath -Force | Out-Null
  Set-ItemProperty -Path $runPath -Name 'BaltoSetupResume' -Value "`"$AppExe`""
}

function Disable-SetupResume {
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'BaltoSetupResume' -ErrorAction SilentlyContinue
}

function Test-TcpPort([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    return $task.Wait(350) -and $client.Connected
  }
  catch { return $false }
  finally { $client.Dispose() }
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch { return $false }
}

function Test-BaltoProcess([string]$PidName, [string]$Needle) {
  $pidPath = Join-Path $pidRoot $PidName
  if (-not (Test-Path -LiteralPath $pidPath)) { return $false }
  try {
    $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    return [bool]($process -and $process.CommandLine -like "*$Needle*")
  }
  catch { return $false }
}

function Get-TailscaleInfo {
  $result = [ordered]@{ installed = $false; signedIn = $false; dnsName = $null }
  if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { return $result }
  $result.installed = $true
  try {
    $statusResult = Invoke-HiddenNativeCapture -FilePath 'tailscale' -Arguments @('status', '--json')
    if ($statusResult.ExitCode -ne 0) { throw "Tailscale status exited with code $($statusResult.ExitCode)." }
    $status = $statusResult.StdOut | ConvertFrom-Json
    $result.signedIn = $status.BackendState -eq 'Running'
    if ($status.Self.DNSName) { $result.dnsName = $status.Self.DNSName.TrimEnd('.') }
  }
  catch { Write-Log "Tailscale status failed: $($_.Exception.Message)" }
  return $result
}

function Test-RemoteEnabled([string]$DnsName) {
  if (-not $DnsName) { return $false }
  try {
    $serveResult = Invoke-HiddenNativeCapture -FilePath 'tailscale' -Arguments @('serve', 'status', '--json')
    if ($serveResult.ExitCode -ne 0) { throw "Tailscale Serve status exited with code $($serveResult.ExitCode)." }
    $serve = $serveResult.StdOut | ConvertFrom-Json
    foreach ($property in $serve.Web.PSObject.Properties) {
      if ($property.Name -eq "${DnsName}:3080" -and $property.Value.Handlers.'/'.Proxy -eq 'http://127.0.0.1:3080') { return $true }
    }
  }
  catch { Write-Log "Tailscale Serve status failed: $($_.Exception.Message)" }
  return $false
}

function Refresh-Status([switch]$PreservePhase) {
  $state = Read-State
  $gpuName = $null
  $gpuMemory = $null
  $gpuUsed = $null
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    try {
      $gpuResult = Invoke-HiddenNativeCapture -FilePath 'nvidia-smi' -Arguments @('--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits')
      if ($gpuResult.ExitCode -ne 0) { throw "GPU check exited with code $($gpuResult.ExitCode)." }
      $gpuLine = ($gpuResult.StdOut -split '\r?\n' | Select-Object -First 1)
      if ($gpuLine) {
        $gpuParts = $gpuLine -split ',' | ForEach-Object { $_.Trim() }
        $gpuName = $gpuParts[0]
        $gpuMemory = [uint64]$gpuParts[1]
        $gpuUsed = [uint64]$gpuParts[2]
      }
    }
    catch { Write-Log "GPU check failed: $($_.Exception.Message)" }
  }

  $dockerInstalled = [bool](Get-Command docker -ErrorAction SilentlyContinue)
  $dockerReady = $false
  if ($dockerInstalled) {
    try {
      $dockerInfo = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}')
      $dockerReady = $dockerInfo.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($dockerInfo.StdOut)
    }
    catch { $dockerReady = $false }
  }

  $tailscale = Get-TailscaleInfo
  $remoteEnabled = Test-RemoteEnabled $tailscale.dnsName
  $baltoContainerRunning = $false
  if ($dockerReady) {
    try {
      $dockerPs = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('ps', '--filter', "name=^/$containerName$", '--format', '{{.Names}}')
      $baltoContainerRunning = $dockerPs.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($dockerPs.StdOut)
    }
    catch {}
  }
  $inferenceReady = $baltoContainerRunning -and (Test-HttpReady 'http://127.0.0.1:30000/health')
  $gatewayReady = (Test-BaltoProcess 'gateway.pid' 'gateway.mjs') -and (Test-TcpPort 30100)
  $workspaceReady = $gatewayReady -and (Test-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js') -and (Test-TcpPort 3080)
  $warning = $null

  if ($gpuName -and $gpuName -notmatch 'RTX 5090') {
    $warning = "Balto's pinned configuration is tested for one RTX 5090. Detected $gpuName."
  }

  $state.gpuName = $gpuName
  $state.gpuMemoryMib = $gpuMemory
  $state.gpuMemoryUsedMib = $gpuUsed
  $state.dockerInstalled = $dockerInstalled
  $state.dockerReady = $dockerReady
  $state.tailscaleInstalled = $tailscale.installed
  $state.tailscaleSignedIn = $tailscale.signedIn
  $state.tailscaleDnsName = $tailscale.dnsName
  $state.remoteEnabled = $remoteEnabled
  $state.remoteUrl = if ($remoteEnabled) { "https://$($tailscale.dnsName):3080" } else { $null }
  $state.inferenceReady = $inferenceReady
  $state.workspaceReady = $workspaceReady
  $state.warning = $warning

  if (-not $PreservePhase) {
    if ($state.phase -eq 'ready' -and (-not $inferenceReady -or -not $workspaceReady)) {
      $state.phase = 'degraded'
      $state.stage = 'launch'
      $state.message = 'A Balto service stopped. Start the stack to recover it.'
      $state.progress = 90
    }
    elseif ($inferenceReady -and $workspaceReady) {
      $state.phase = 'ready'
      $state.stage = 'ready'
      $state.message = 'Qwen 3.8 27B is loaded and the coding workspace is live.'
      $state.progress = 100
    }
    elseif ($state.phase -eq 'not-installed') {
      $state.stage = 'system-check'
      $state.message = if ($gpuName) { 'System check complete. Balto is ready to install.' } else { 'No supported NVIDIA GPU was detected.' }
      $state.progress = 8
    }
  }
  Save-State $state
  return $state
}

function Assert-Compatible {
  $state = Refresh-Status -PreservePhase
  if (-not $state.gpuName -or $state.gpuName -notmatch 'RTX 5090') { throw 'Balto currently requires one NVIDIA GeForce RTX 5090.' }
  if ($state.gpuMemoryMib -lt 30000) { throw 'Balto requires at least 30 GB of available GPU memory.' }

  $fullDataPath = [System.IO.Path]::GetFullPath($BaltoData)
  $driveRoot = [System.IO.Path]::GetPathRoot($fullDataPath)
  if (-not $driveRoot) { throw "Balto could not resolve the storage drive for $fullDataPath." }
  $disk = [System.IO.DriveInfo]::GetDrives() | Where-Object {
    $fullDataPath.StartsWith($_.RootDirectory.FullName, [System.StringComparison]::OrdinalIgnoreCase)
  } | Sort-Object { $_.RootDirectory.FullName.Length } -Descending | Select-Object -First 1
  if (-not $disk) { throw "Balto could not inspect free space on $driveRoot." }
  if (-not $disk.IsReady -or $disk.AvailableFreeSpace -lt 90GB) { throw "Balto needs at least 90 GB free on $driveRoot for the image, model cache, and updates." }

}

function Ensure-Wsl {
  $wslReady = $false
  if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    try {
      $wslVersion = Invoke-HiddenNativeCapture -FilePath 'wsl.exe' -Arguments @('--version')
      $wslReady = $wslVersion.ExitCode -eq 0
    }
    catch { $wslReady = $false }
  }
  if ($wslReady) { return }

  Update-State @{ phase = 'installing'; stage = 'windows'; progress = 11; message = 'Preparing Windows for high-speed local inference. Approve the Windows prompt if it appears.' }
  Write-Log 'Installing WSL without a user distribution.'
  $wslInstall = Start-Process -FilePath 'wsl.exe' -ArgumentList @('--install', '--no-distribution', '--web-download') -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  if ($wslInstall.ExitCode -ne 0) { throw "Windows inference support exited with code $($wslInstall.ExitCode)." }

  try {
    $wslVersion = Invoke-HiddenNativeCapture -FilePath 'wsl.exe' -Arguments @('--version')
    if ($wslVersion.ExitCode -eq 0) { return }
  }
  catch {}
  throw 'Windows inference support was installed. Restart Windows once, then Balto will continue automatically.'
}

function Ensure-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Update-State @{ phase = 'installing'; stage = 'engine'; progress = 13; message = 'Preparing the local inference engine.' }
    Write-Log 'Installing Docker Desktop in official per-user mode.'
    $dockerInstaller = Join-Path $runtimeRoot 'Docker Desktop Installer.exe'
    $dockerInstallerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
    if (-not (Test-Path -LiteralPath $dockerInstaller)) {
      Invoke-WebRequest -Uri $dockerInstallerUrl -OutFile $dockerInstaller -UseBasicParsing
    }
    $installProcess = Start-Process -FilePath $dockerInstaller -ArgumentList @('install', '--user', '--quiet', '--accept-license', '--backend=wsl-2', '--no-windows-containers') -Wait -PassThru -WindowStyle Hidden
    if ($installProcess.ExitCode -ne 0) { throw "The local inference engine installer exited with code $($installProcess.ExitCode)." }
    Remove-Item -LiteralPath $dockerInstaller -Force -ErrorAction SilentlyContinue
    $machineDocker = 'C:\Program Files\Docker\Docker\resources\bin'
    $userDocker = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'
    if (Test-Path -LiteralPath $machineDocker) { $env:PATH = "$machineDocker;$env:PATH" }
    if (Test-Path -LiteralPath $userDocker) { $env:PATH = "$userDocker;$env:PATH" }
  }

  try {
    $dockerInfo = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}')
    if ($dockerInfo.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($dockerInfo.StdOut)) { return }
  }
  catch {}
  $desktopCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  )
  $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($desktop) {
    Update-State @{ phase = 'installing'; stage = 'engine'; progress = 18; message = 'Starting the local inference engine.' }
    Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null
  }
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      $dockerInfo = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}')
      if ($dockerInfo.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($dockerInfo.StdOut)) { return }
    }
    catch {}
    Start-Sleep -Seconds 2
  }
  throw 'Docker Desktop is installed but its engine did not start. A Windows restart may be required.'
}

function Ensure-NodeRuntime {
  if (Test-Path -LiteralPath $nodeExe) { return }
  Update-State @{ phase = 'downloading-runtime'; stage = 'app-runtime'; progress = 22; message = "Downloading Balto's private Node.js runtime." }
  $archive = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64.zip"
  $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
  Write-Log "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
  Remove-Item -LiteralPath $archive -Force
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'The private Node.js runtime did not install correctly.' }
}

function Ensure-DefaultWorkspace {
  $storageRoot = Join-Path $dshHome 'storages'
  $workspaceStatePath = Join-Path $storageRoot 'workspace.json'
  $workspaceStateTempPath = Join-Path $storageRoot 'workspace.json.tmp'
  $canonicalWorkspace = [System.IO.Path]::GetFullPath($workspaceRoot).TrimEnd('\')
  New-Item -ItemType Directory -Force -Path $storageRoot, $canonicalWorkspace | Out-Null

  if (Test-Path -LiteralPath $workspaceStatePath) {
    $workspaceState = Get-Content -LiteralPath $workspaceStatePath -Raw | ConvertFrom-Json
    if ($workspaceState.unit.name -ne 'workspace' -or $workspaceState.unit.version -ne 2) {
      Write-Log 'The workspace registry uses a newer format. Balto left it unchanged.'
      return
    }
    foreach ($entry in $workspaceState.tables.workspaces.PSObject.Properties) {
      if ([string]::Equals([string]$entry.Value.path, $canonicalWorkspace, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    }
  }
  else {
    $workspaceState = [pscustomobject]@{
      unit = [pscustomobject]@{ name = 'workspace'; version = 2 }
      global = [pscustomobject]@{ initialized = $true; workspaceIds = @(); archivedSessionIds = @() }
      tables = [pscustomobject]@{ workspaces = [pscustomobject]@{} }
    }
  }

  $workspaceId = [guid]::NewGuid().ToString()
  $createdAt = (Get-Date).ToUniversalTime().ToString('o')
  $record = [pscustomobject]@{
    path = $canonicalWorkspace
    title = 'Balto'
    sessionIds = @()
    createdAt = $createdAt
    updatedAt = $createdAt
  }
  $workspaceState.tables.workspaces | Add-Member -NotePropertyName $workspaceId -NotePropertyValue $record
  $workspaceState.global.initialized = $true
  $workspaceState.global.workspaceIds = @($workspaceId) + @($workspaceState.global.workspaceIds)
  $json = $workspaceState | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($workspaceStateTempPath, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $workspaceStateTempPath -Destination $workspaceStatePath -Force
  Write-Log "Created the default coding workspace at $canonicalWorkspace."
}

function Ensure-WorkspaceRuntime {
  $dshEntry = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  $yamlModule = Join-Path $dshRoot 'node_modules\js-yaml\dist\js-yaml.mjs'
  if (-not (Test-Path -LiteralPath $dshEntry) -or -not (Test-Path -LiteralPath $yamlModule)) {
    Update-State @{ phase = 'downloading-runtime'; stage = 'app-runtime'; progress = 28; message = 'Installing the Balto coding workspace.' }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      Write-Log "Installing the pinned coding workspace. Attempt $attempt of 3."
      try {
        Invoke-LoggedNative -FilePath $nodeExe -Arguments @($npmCli, 'install', '--prefix', $dshRoot, '@deepseek-ai/dsh@0.1.0-rc.6', 'js-yaml@4.2.0', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error') -Prefix 'workspace install'
      }
      catch {
        Write-Log "Workspace install attempt $attempt needs another pass: $($_.Exception.Message)"
      }
      if ((Test-Path -LiteralPath $dshEntry) -and (Test-Path -LiteralPath $yamlModule)) { break }
      if ($attempt -lt 3) {
        Update-State @{ phase = 'downloading-runtime'; stage = 'app-runtime'; progress = 28; message = 'Finishing the Balto coding workspace. Downloaded files are being reused.' }
        Start-Sleep -Seconds (2 * $attempt)
      }
    }
  }
  if (-not (Test-Path -LiteralPath $dshEntry) -or -not (Test-Path -LiteralPath $yamlModule)) {
    throw 'Balto could not finish the coding workspace. Your downloaded files are safe and setup will resume automatically.'
  }
  Invoke-LoggedNative -FilePath $nodeExe -Arguments @((Join-Path $Resources 'patch-dsh.mjs'), $dshRoot, $Resources) -Prefix 'brand'
  $settingsPath = Join-Path $dshHome 'settings.yaml'
  if (-not (Test-Path -LiteralPath $settingsPath)) {
    Copy-Item -LiteralPath (Join-Path $Resources 'templates\settings.yaml') -Destination $settingsPath
    Write-Log 'Created the Balto Qwen model profile.'
  }
  Invoke-LoggedNative -FilePath $nodeExe -Arguments @(
    (Join-Path $Resources 'configure-settings.mjs'),
    $settingsPath,
    (Join-Path $Resources 'templates\settings.yaml'),
    $yamlModule
  ) -Prefix 'settings'
  Ensure-DefaultWorkspace
}

function Stop-BaltoProcess([string]$PidName, [string]$Needle) {
  $pidPath = Join-Path $pidRoot $PidName
  if (-not (Test-Path -LiteralPath $pidPath)) { return }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if ($process -and $process.CommandLine -like "*$Needle*") { Stop-Process -Id $processId -Force }
  }
  catch { Write-Log "Could not stop process ${processId}: $($_.Exception.Message)" }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

function Start-BaltoProcess([string]$PidName, [string]$FilePath, [string[]]$Arguments, [string]$Needle, [string]$WorkingDirectory = '') {
  $pidPath = Join-Path $pidRoot $PidName
  if (Test-Path -LiteralPath $pidPath) {
    try {
      $existingId = [int](Get-Content -LiteralPath $pidPath -Raw)
      $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $existingId"
      if ($existing -and $existing.CommandLine -like "*$Needle*") { return }
    }
    catch {}
  }
  $stdout = Join-Path $BaltoData "$PidName.out.log"
  $stderr = Join-Path $BaltoData "$PidName.err.log"
  if (-not $AppExe -or -not (Test-Path -LiteralPath $AppExe)) {
    throw 'Balto could not find its hidden service launcher.'
  }
  $launcherArguments = @(
    '--balto-launch-hidden',
    '--pid-file', $pidPath,
    '--stdout', $stdout,
    '--stderr', $stderr
  )
  if ($WorkingDirectory) { $launcherArguments += @('--cwd', $WorkingDirectory) }
  $launcherArguments += @('--', $FilePath)
  $launcherArguments += $Arguments
  $launcherExitCode = Invoke-HiddenNativeNoOutput -FilePath $AppExe -Arguments $launcherArguments
  if ($launcherExitCode -ne 0) { throw "Balto could not launch the $PidName service." }
  if (-not (Test-Path -LiteralPath $pidPath)) { throw "Balto could not record the $PidName service." }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
  if (-not $process -or $process.CommandLine -notlike "*$Needle*") {
    throw "Balto could not verify the $PidName service."
  }
}

function Get-ModelCacheVolume {
  $baltoCache = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('volume', 'ls', '--filter', 'name=^balto-qwen38-cache$', '--format', '{{.Name}}')
  if ($baltoCache.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($baltoCache.StdOut)) { return 'balto-qwen38-cache' }

  # Reuse the exact Qwen 3.8 cache from the original tuned stack when upgrading
  # this machine. Fresh installs receive Balto's own volume below.
  $legacyCache = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('volume', 'ls', '--filter', 'name=^qwen38-hf-cache$', '--format', '{{.Name}}')
  if ($legacyCache.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($legacyCache.StdOut)) {
    Write-Log 'Reusing the existing Qwen 3.8 model cache without copying or downloading it again.'
    return 'qwen38-hf-cache'
  }
  return 'balto-qwen38-cache'
}

function Ensure-Container {
  $cacheVolume = Get-ModelCacheVolume
  $existingResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('ps', '-a', '--filter', "name=^/$containerName$", '--format', '{{.Names}}')
  if ($existingResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingResult.StdOut)) {
    $labelsResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('inspect', '--format', '{{json .Config.Labels}}', $containerName)
    if ($labelsResult.ExitCode -ne 0) { throw 'Could not inspect the Balto container.' }
    $installedLabels = $labelsResult.StdOut | ConvertFrom-Json
    $installedConfig = $installedLabels.'com.adore.balto.config'
    if ($installedConfig -eq $containerConfig) {
      $runningResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('ps', '--filter', "name=^/$containerName$", '--format', '{{.Names}}')
      if ($runningResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($runningResult.StdOut)) {
        Invoke-LoggedNative -FilePath 'docker' -Arguments @('start', $containerName) -Prefix 'docker'
      }
      return
    }
    Write-Log "Replacing Balto container configuration '$installedConfig' with '$containerConfig'. Model weights remain in the persistent volume."
    Invoke-LoggedNative -FilePath 'docker' -Arguments @('rm', '--force', $containerName) -Prefix 'docker'
  }

  Update-State @{ phase = 'downloading-runtime'; stage = 'inference-runtime'; progress = 34; message = 'Downloading the pinned SGLang runtime. Docker resumes interrupted layers.' }
  Invoke-LoggedNative -FilePath 'docker' -Arguments @('pull', $containerImage) -Prefix 'docker pull'
  Invoke-LoggedNative -FilePath 'docker' -Arguments @('volume', 'create', $cacheVolume) -Prefix 'docker volume'

  Update-State @{ phase = 'downloading-model'; stage = 'model'; progress = 47; message = 'Downloading Qwen 3.8 27B NVFP4 and its DSpark draft. Partial downloads are preserved.'; downloadedGb = 0; downloadTotalGb = 24; downloadRateMbps = $null; etaSeconds = $null }
  $dockerArgs = @(
    'run', '-d', '--name', $containerName,
    '--label', "com.adore.balto.config=$containerConfig",
    '--restart', 'unless-stopped',
    '--gpus', 'all',
    '--shm-size', '32g',
    '--ipc=host',
    '-e', 'HF_HUB_ENABLE_HF_TRANSFER=1',
    '-p', '127.0.0.1:30000:30000',
    '-v', "${cacheVolume}:/root/.cache/huggingface/hub",
    $containerImage,
    'sglang', 'serve',
    '--trust-remote-code',
    '--model-path', $modelName,
    '--served-model-name', 'qwen3.8-27b-nvfp4-dspark',
    '--context-length', '80000',
    '--mem-fraction-static', '0.95',
    '--kv-cache-dtype', 'fp8_e4m3',
    '--attention-backend', 'flashinfer',
    '--chunked-prefill-size', '2048',
    '--mm-feature-transport', 'cpu',
    '--max-running-requests', '1',
    '--max-total-tokens', '80000',
    '--disable-radix-cache',
    '--cuda-graph-max-bs-decode', '1',
    '--cuda-graph-bs-decode', '1',
    '--disable-prefill-cuda-graph',
    '--reasoning-parser', 'qwen3',
    '--tool-call-parser', 'qwen3_coder',
    '--speculative-algorithm', 'DSPARK',
    '--speculative-draft-model-path', $draftName,
    '--speculative-dspark-block-size', '7',
    '--speculative-draft-model-quantization', 'unquant',
    '--mamba-ssm-dtype', 'bfloat16',
    '--max-mamba-cache-size', '1',
    '--host', '0.0.0.0',
    '--port', '30000'
  )
  Invoke-LoggedNative -FilePath 'docker' -Arguments $dockerArgs -Prefix 'docker run'
}

function Wait-ForInference {
  $lastDownloadedBytes = $null
  $lastSampleTime = Get-Date
  $expectedModelBytes = 24GB
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    if (Test-HttpReady 'http://127.0.0.1:30000/health') { return }
    if ($attempt % 3 -eq 0) {
      $downloadedBytes = 0
      try {
        $downloadResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('exec', $containerName, 'sh', '-lc', 'du -sb /root/.cache/huggingface/hub 2>/dev/null | cut -f1')
        if ($downloadResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($downloadResult.StdOut)) {
          $downloadedBytes = [uint64]$downloadResult.StdOut.Trim()
        }
      }
      catch {}
      $sampleTime = Get-Date
      $downloadedGb = [math]::Round($downloadedBytes / 1GB, 1)
      $modelProgress = [math]::Min(1, $downloadedBytes / $expectedModelBytes)
      $progress = [math]::Min(84, 50 + [math]::Floor($modelProgress * 34))
      $detail = if ($downloadedGb -gt 0) { "$downloadedGb GB downloaded and verified." } else { 'Connecting to the model host.' }
      $downloadRateMbps = $null
      $etaSeconds = $null
      if ($null -ne $lastDownloadedBytes -and $downloadedBytes -gt $lastDownloadedBytes) {
        $sampleSeconds = ($sampleTime - $lastSampleTime).TotalSeconds
        if ($sampleSeconds -gt 0) {
          $bytesPerSecond = ($downloadedBytes - $lastDownloadedBytes) / $sampleSeconds
          $downloadRateMbps = [math]::Round($bytesPerSecond / 1MB, 1)
          $remainingBytes = [math]::Max(0, $expectedModelBytes - $downloadedBytes)
          if ($bytesPerSecond -gt 0 -and $remainingBytes -gt 0) {
            $etaSeconds = [uint64][math]::Min(21600, [math]::Ceiling($remainingBytes / $bytesPerSecond))
          }
        }
      }
      Update-State @{
        phase = 'downloading-model'
        stage = 'model'
        progress = $progress
        message = "Preparing Qwen 3.8 27B. $detail Interrupted downloads resume automatically."
        downloadedGb = $downloadedGb
        downloadTotalGb = 24
        downloadRateMbps = $downloadRateMbps
        etaSeconds = $etaSeconds
      }
      $lastDownloadedBytes = $downloadedBytes
      $lastSampleTime = $sampleTime
    }
    $runningResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('inspect', '-f', '{{.State.Running}}', $containerName)
    if ($runningResult.ExitCode -ne 0 -or $runningResult.StdOut.Trim() -ne 'true') {
      $logsResult = Invoke-HiddenNativeCapture -FilePath 'docker' -Arguments @('logs', '--tail', '25', $containerName)
      $tail = @($logsResult.StdOut, $logsResult.StdErr) -join "`r`n"
      throw "The SGLang container stopped. Recent log:`n$tail"
    }
    Start-Sleep -Seconds 5
  }
  throw 'The model did not become ready within 20 minutes. Balto preserved all downloaded data for retry.'
}

function Start-LocalServices {
  Update-State @{ phase = 'starting'; stage = 'launch'; progress = 88; message = 'Starting the Balto gateway and coding workspace.'; etaSeconds = $null }
  $env:PATH = "$nodeRoot;$env:PATH"
  $env:DSH_HOME = $dshHome
  Start-BaltoProcess 'gateway.pid' $nodeExe @((Join-Path $Resources 'gateway.mjs')) 'gateway.mjs'

  $dshEntry = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  $profilePatch = Join-Path $Resources 'templates\profile.patch.yml'
  $arguments = @($dshEntry, '--profile', 'web', '--patch', $profilePatch, '--host', '127.0.0.1', '--port', '3080')
  $tailscale = Get-TailscaleInfo
  if ($tailscale.signedIn -and $tailscale.dnsName) {
    $arguments += @('--trusted-host', "$($tailscale.dnsName):3080")
  }
  Start-BaltoProcess 'workspace.pid' $nodeExe $arguments 'dsh\lib\bin.js' $workspaceRoot

  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ((Test-BaltoProcess 'gateway.pid' 'gateway.mjs') -and (Test-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js') -and (Test-TcpPort 30100) -and (Test-TcpPort 3080)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'The Balto coding workspace did not start. Open the setup log for details.'
}

function Enable-Remote {
  $state = Refresh-Status -PreservePhase
  if (-not $state.workspaceReady) { throw 'Start Balto before enabling private remote access.' }
  if (-not $state.tailscaleInstalled) {
    Update-State @{ message = 'Installing Tailscale with winget.' }
    Invoke-LoggedNative -FilePath 'winget' -Arguments @('install', '--exact', '--id', 'Tailscale.Tailscale', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') -Prefix 'winget'
  }
  $tailscale = Get-TailscaleInfo
  if (-not $tailscale.signedIn) { throw 'Open Tailscale and sign in, then turn on remote steering again.' }

  Stop-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js'
  Start-LocalServices
  Invoke-LoggedNative -FilePath 'tailscale' -Arguments @('serve', '--bg', '--yes', '--https=3080', '127.0.0.1:3080') -Prefix 'tailscale'
  Invoke-LoggedNative -FilePath 'tailscale' -Arguments @('serve', '--bg', '--yes', '--https=30100', '127.0.0.1:30100') -Prefix 'tailscale'
  Refresh-Status | Out-Null
}

function Disable-Remote {
  if (Get-Command tailscale -ErrorAction SilentlyContinue) {
    Invoke-LoggedNative -FilePath 'tailscale' -Arguments @('serve', '--yes', '--https=3080', 'off') -Prefix 'tailscale' -AllowFailure
    Invoke-LoggedNative -FilePath 'tailscale' -Arguments @('serve', '--yes', '--https=30100', 'off') -Prefix 'tailscale' -AllowFailure
  }
  Refresh-Status | Out-Null
}

function Install-Balto {
  Enable-SetupResume
  Update-State @{ phase = 'installing'; stage = 'system-check'; progress = 10; message = 'Checking this RTX 5090 system.'; warning = $null; startedAt = (Get-Date).ToUniversalTime().ToString('o'); downloadedGb = $null; downloadRateMbps = $null; etaSeconds = $null }
  Assert-Compatible
  Ensure-Wsl
  Ensure-Docker
  Ensure-NodeRuntime
  Ensure-WorkspaceRuntime
  Ensure-Container
  Wait-ForInference
  Start-LocalServices
  Update-State @{ phase = 'ready'; stage = 'ready'; progress = 100; message = 'Qwen 3.8 27B is loaded and the coding workspace is live.'; inferenceReady = $true; workspaceReady = $true; etaSeconds = 0 }
  Disable-SetupResume
  Refresh-Status | Out-Null
}

$actionMutex = [System.Threading.Mutex]::new($false, 'Local\Adore.BaltoSpeedrunner.Action')
$actionMutexAcquired = $false
try {
  try {
    $waitMilliseconds = if ($Action -eq 'status') { 0 } else { 3000 }
    $actionMutexAcquired = $actionMutex.WaitOne($waitMilliseconds)
  }
  catch [System.Threading.AbandonedMutexException] {
    $actionMutexAcquired = $true
  }
  if (-not $actionMutexAcquired) {
    Write-Log "Action skipped because another Balto action is running: $Action"
    exit 0
  }
}
catch {
  $actionMutex.Dispose()
  throw
}

try {
  Write-Log "Action started: $Action"
  switch ($Action) {
    'status' {
      Refresh-Status | Out-Null
    }
    'setup' {
      Install-Balto
    }
    'start' {
      Assert-Compatible
      Ensure-Docker
      Ensure-NodeRuntime
      Ensure-WorkspaceRuntime
      Ensure-Container
      Wait-ForInference
      Start-LocalServices
      Update-State @{ phase = 'ready'; stage = 'ready'; progress = 100; message = 'Balto is ready.'; etaSeconds = 0 }
      Disable-SetupResume
      Refresh-Status | Out-Null
    }
    'stop' {
      Update-State @{ phase = 'stopping'; stage = 'launch'; progress = 95; message = 'Stopping Balto without removing model data.' }
      Disable-Remote
      Stop-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js'
      Stop-BaltoProcess 'gateway.pid' 'gateway.mjs'
      if (Get-Command docker -ErrorAction SilentlyContinue) { Invoke-LoggedNative -FilePath 'docker' -Arguments @('stop', $containerName) -Prefix 'docker' -AllowFailure }
      Update-State @{ phase = 'stopped'; stage = 'launch'; progress = 0; message = 'Balto is stopped. Model files remain cached.'; inferenceReady = $false; workspaceReady = $false }
    }
    'restart-workspace' {
      Stop-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js'
      Stop-BaltoProcess 'gateway.pid' 'gateway.mjs'
      Ensure-NodeRuntime
      Ensure-WorkspaceRuntime
      Start-LocalServices
      Update-State @{ phase = 'ready'; stage = 'ready'; progress = 100; message = 'Balto is ready.'; etaSeconds = 0 }
      Refresh-Status | Out-Null
    }
    'remote-on' { Enable-Remote }
    'remote-off' { Disable-Remote }
  }
  Write-Log "Action completed: $Action"
}
catch {
  $message = $_.Exception.Message
  Write-Log "Action failed: $Action. $message"
  if ($_.ScriptStackTrace) { Write-Log "Stack: $($_.ScriptStackTrace -replace '[\r\n]+', ' | ')" }
  Update-State @{ phase = 'failed'; message = $message; warning = $message }
  exit 1
}
finally {
  if ($actionMutexAcquired) { $actionMutex.ReleaseMutex() }
  $actionMutex.Dispose()
}
