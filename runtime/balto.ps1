param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'setup', 'start', 'stop', 'remote-on', 'remote-off')]
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

New-Item -ItemType Directory -Force -Path $BaltoData, $runtimeRoot, $dshHome, $pidRoot | Out-Null

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  [System.IO.File]::AppendAllText($logPath, "[$stamp] $Message`r`n")
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$Prefix,
    [switch]$AllowFailure
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # npm, Docker, winget, and Tailscale legitimately write progress and warnings
    # to stderr. Capture that output without promoting it to a terminating error.
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  foreach ($line in $output) { Write-Log "${Prefix}: $line" }
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "$Prefix exited with code $exitCode. Open the setup log for details."
  }
}

function New-DefaultState {
  @{
    phase = 'not-installed'
    message = 'Ready to inspect this PC.'
    progress = 0
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
    $status = (& tailscale status --json 2>$null | Out-String) | ConvertFrom-Json
    $result.signedIn = $status.BackendState -eq 'Running'
    if ($status.Self.DNSName) { $result.dnsName = $status.Self.DNSName.TrimEnd('.') }
  }
  catch { Write-Log "Tailscale status failed: $($_.Exception.Message)" }
  return $result
}

function Test-RemoteEnabled([string]$DnsName) {
  if (-not $DnsName) { return $false }
  try {
    $serve = (& tailscale serve status --json 2>$null | Out-String) | ConvertFrom-Json
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
      $gpuLine = (& nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
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
    try { $dockerReady = [bool](& docker info --format '{{.ServerVersion}}' 2>$null) } catch { $dockerReady = $false }
  }

  $tailscale = Get-TailscaleInfo
  $remoteEnabled = Test-RemoteEnabled $tailscale.dnsName
  $baltoContainerRunning = $false
  if ($dockerReady) {
    try { $baltoContainerRunning = [bool](& docker ps --filter "name=^/$containerName$" --format '{{.Names}}' 2>$null) } catch {}
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
      $state.message = 'A Balto service stopped. Start the stack to recover it.'
      $state.progress = 90
    }
    elseif ($inferenceReady -and $workspaceReady) {
      $state.phase = 'ready'
      $state.message = 'Qwen 3.8 27B is loaded and the coding workspace is live.'
      $state.progress = 100
    }
    elseif ($state.phase -eq 'not-installed') {
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
      & wsl.exe --version *> $null
      $wslReady = $LASTEXITCODE -eq 0
    }
    catch { $wslReady = $false }
  }
  if ($wslReady) { return }

  Update-State @{ phase = 'installing'; progress = 11; message = 'Preparing Windows for high-speed local inference. Approve the Windows prompt if it appears.' }
  Write-Log 'Installing WSL without a user distribution.'
  $wslInstall = Start-Process -FilePath 'wsl.exe' -ArgumentList @('--install', '--no-distribution', '--web-download') -Verb RunAs -Wait -PassThru
  if ($wslInstall.ExitCode -ne 0) { throw "Windows inference support exited with code $($wslInstall.ExitCode)." }

  try {
    & wsl.exe --version *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }
  catch {}
  throw 'Windows inference support was installed. Restart Windows once, then Balto will continue automatically.'
}

function Ensure-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Update-State @{ phase = 'installing'; progress = 13; message = 'Preparing the local inference engine.' }
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

  try { if (& docker info --format '{{.ServerVersion}}' 2>$null) { return } } catch {}
  $desktopCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  )
  $desktop = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($desktop) {
    Update-State @{ phase = 'installing'; progress = 18; message = 'Starting the local inference engine.' }
    Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null
  }
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try { if (& docker info --format '{{.ServerVersion}}' 2>$null) { return } } catch {}
    Start-Sleep -Seconds 2
  }
  throw 'Docker Desktop is installed but its engine did not start. A Windows restart may be required.'
}

function Ensure-NodeRuntime {
  if (Test-Path -LiteralPath $nodeExe) { return }
  Update-State @{ phase = 'downloading-runtime'; progress = 22; message = "Downloading Balto's private Node.js runtime." }
  $archive = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64.zip"
  $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
  Write-Log "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
  Remove-Item -LiteralPath $archive -Force
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'The private Node.js runtime did not install correctly.' }
}

function Ensure-WorkspaceRuntime {
  $dshEntry = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  $yamlModule = Join-Path $dshRoot 'node_modules\js-yaml\dist\js-yaml.mjs'
  if (-not (Test-Path -LiteralPath $dshEntry) -or -not (Test-Path -LiteralPath $yamlModule)) {
    Update-State @{ phase = 'downloading-runtime'; progress = 28; message = 'Installing the Balto coding workspace.' }
    Write-Log 'Installing the pinned agent interface and compatible YAML runtime.'
    Invoke-LoggedNative -FilePath $nodeExe -Arguments @($npmCli, 'install', '--prefix', $dshRoot, '@deepseek-ai/dsh@0.1.0-rc.6', 'js-yaml@4.2.0', '--omit=dev', '--no-audit', '--no-fund') -Prefix 'npm'
  }
  if (-not (Test-Path -LiteralPath $dshEntry)) { throw 'The Balto coding workspace did not install correctly.' }
  if (-not (Test-Path -LiteralPath $yamlModule)) { throw 'The Balto coding workspace YAML runtime did not install correctly.' }
  Invoke-LoggedNative -FilePath $nodeExe -Arguments @((Join-Path $Resources 'patch-dsh.mjs'), $dshRoot, $Resources) -Prefix 'brand'
  Copy-Item -LiteralPath (Join-Path $Resources 'templates\settings.yaml') -Destination (Join-Path $dshHome 'settings.yaml') -Force
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

function Start-BaltoProcess([string]$PidName, [string]$FilePath, [string[]]$Arguments, [string]$Needle) {
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
  $quotedArguments = $Arguments | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }
  $process = Start-Process -FilePath $FilePath -ArgumentList $quotedArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  [System.IO.File]::WriteAllText($pidPath, [string]$process.Id)
}

function Get-ModelCacheVolume {
  $baltoCache = & docker volume ls --filter 'name=^balto-qwen38-cache$' --format '{{.Name}}' 2>$null
  if ($baltoCache) { return 'balto-qwen38-cache' }

  # Reuse the exact Qwen 3.8 cache from the original tuned stack when upgrading
  # this machine. Fresh installs receive Balto's own volume below.
  $legacyCache = & docker volume ls --filter 'name=^qwen38-hf-cache$' --format '{{.Name}}' 2>$null
  if ($legacyCache) {
    Write-Log 'Reusing the existing Qwen 3.8 model cache without copying or downloading it again.'
    return 'qwen38-hf-cache'
  }
  return 'balto-qwen38-cache'
}

function Ensure-Container {
  $cacheVolume = Get-ModelCacheVolume
  $existing = & docker ps -a --filter "name=^/$containerName$" --format '{{.Names}}' 2>$null
  if ($existing) {
    $installedLabels = (& docker inspect --format '{{json .Config.Labels}}' $containerName 2>$null | Out-String) | ConvertFrom-Json
    $installedConfig = $installedLabels.'com.adore.balto.config'
    if ($installedConfig -eq $containerConfig) {
      $running = & docker ps --filter "name=^/$containerName$" --format '{{.Names}}' 2>$null
      if (-not $running) { Invoke-LoggedNative -FilePath 'docker' -Arguments @('start', $containerName) -Prefix 'docker' }
      return
    }
    Write-Log "Replacing Balto container configuration '$installedConfig' with '$containerConfig'. Model weights remain in the persistent volume."
    Invoke-LoggedNative -FilePath 'docker' -Arguments @('rm', '--force', $containerName) -Prefix 'docker'
  }

  Update-State @{ phase = 'downloading-runtime'; progress = 34; message = 'Downloading the pinned SGLang runtime. Docker resumes interrupted layers.' }
  Invoke-LoggedNative -FilePath 'docker' -Arguments @('pull', $containerImage) -Prefix 'docker pull'
  Invoke-LoggedNative -FilePath 'docker' -Arguments @('volume', 'create', $cacheVolume) -Prefix 'docker volume'

  Update-State @{ phase = 'downloading-model'; progress = 47; message = 'Downloading Qwen 3.8 27B NVFP4 and its DSpark draft. Partial downloads are preserved.' }
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
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    if (Test-HttpReady 'http://127.0.0.1:30000/health') { return }
    if ($attempt % 3 -eq 0) {
      $downloadedBytes = 0
      try { $downloadedBytes = [uint64](& docker exec $containerName sh -lc 'du -sb /root/.cache/huggingface/hub 2>/dev/null | cut -f1' 2>$null) } catch {}
      $downloadedGb = [math]::Round($downloadedBytes / 1GB, 1)
      $modelProgress = [math]::Min(1, $downloadedBytes / 24GB)
      $progress = [math]::Min(84, 50 + [math]::Floor($modelProgress * 34))
      $detail = if ($downloadedGb -gt 0) { "$downloadedGb GB downloaded and verified." } else { 'Connecting to the model host.' }
      Update-State @{ phase = 'downloading-model'; progress = $progress; message = "Preparing Qwen 3.8 27B. $detail Interrupted downloads resume automatically." }
    }
    $running = & docker inspect -f '{{.State.Running}}' $containerName 2>$null
    if ($running -ne 'true') {
      $tail = (& docker logs --tail 25 $containerName 2>&1 | Out-String)
      throw "The SGLang container stopped. Recent log:`n$tail"
    }
    Start-Sleep -Seconds 5
  }
  throw 'The model did not become ready within 20 minutes. Balto preserved all downloaded data for retry.'
}

function Start-LocalServices {
  Update-State @{ phase = 'starting'; progress = 88; message = 'Starting the Balto gateway and coding workspace.' }
  $env:PATH = "$nodeRoot;$env:PATH"
  $env:DSH_HOME = $dshHome
  Start-BaltoProcess 'gateway.pid' $nodeExe @((Join-Path $Resources 'gateway.mjs')) 'gateway.mjs'

  $dshEntry = Join-Path $dshRoot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  $arguments = @($dshEntry, 'web', '--host', '127.0.0.1', '--port', '3080')
  $tailscale = Get-TailscaleInfo
  if ($tailscale.signedIn -and $tailscale.dnsName) {
    $arguments += @('--trusted-host', "$($tailscale.dnsName):3080")
  }
  Start-BaltoProcess 'workspace.pid' $nodeExe $arguments 'dsh\lib\bin.js'

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
  Update-State @{ phase = 'installing'; progress = 10; message = 'Checking this RTX 5090 system.'; warning = $null }
  Assert-Compatible
  Ensure-Wsl
  Ensure-Docker
  Ensure-NodeRuntime
  Ensure-WorkspaceRuntime
  Ensure-Container
  Wait-ForInference
  Start-LocalServices
  Update-State @{ phase = 'ready'; progress = 100; message = 'Qwen 3.8 27B is loaded and the coding workspace is live.'; inferenceReady = $true; workspaceReady = $true }
  Disable-SetupResume
  Refresh-Status | Out-Null
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
      Update-State @{ phase = 'ready'; progress = 100; message = 'Balto is ready.' }
      Disable-SetupResume
      Refresh-Status | Out-Null
    }
    'stop' {
      Update-State @{ phase = 'stopping'; progress = 95; message = 'Stopping Balto without removing model data.' }
      Disable-Remote
      Stop-BaltoProcess 'workspace.pid' 'dsh\lib\bin.js'
      Stop-BaltoProcess 'gateway.pid' 'gateway.mjs'
      if (Get-Command docker -ErrorAction SilentlyContinue) { Invoke-LoggedNative -FilePath 'docker' -Arguments @('stop', $containerName) -Prefix 'docker' -AllowFailure }
      Update-State @{ phase = 'stopped'; progress = 0; message = 'Balto is stopped. Model files remain cached.'; inferenceReady = $false; workspaceReady = $false }
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
