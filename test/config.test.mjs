import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('ships the exact one-5090 inference configuration', async () => {
  const script = await read('runtime/balto.ps1')
  for (const required of [
    "'--context-length', '80000'",
    "'--kv-cache-dtype', 'fp8_e4m3'",
    "'--attention-backend', 'flashinfer'",
    "'--max-running-requests', '1'",
    "'--speculative-algorithm', 'DSPARK'",
    "'--speculative-dspark-block-size', '7'",
    "'--model-path', $modelName",
    "'--speculative-draft-model-path', $draftName",
  ]) assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(script, /lmsysorg\/sglang@sha256:[a-f0-9]{64}/)
  assert.match(script, /com\.adore\.balto\.config/)
  assert.match(script, /balto-qwen38-cache/)
  assert.match(script, /qwen38-hf-cache/)
  assert.match(script, /Reusing the existing Qwen 3\.8 model cache without copying or downloading it again/)
})

test('remote access remains tailnet-only', async () => {
  const script = await read('runtime/balto.ps1')
  assert.match(script, /Invoke-LoggedNative -FilePath 'tailscale' -Arguments @\('serve', '--bg', '--yes', '--https=3080', '127\.0\.0\.1:3080'\)/)
  assert.match(script, /Invoke-LoggedNative -FilePath 'tailscale' -Arguments @\('serve', '--bg', '--yes', '--https=30100', '127\.0\.0\.1:30100'\)/)
  assert.doesNotMatch(script, /tailscale funnel/i)
})

test('release config uses a signed updater and NSIS', async () => {
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'))
  assert.deepEqual(config.bundle.targets, ['nsis'])
  assert.equal(config.bundle.createUpdaterArtifacts, true)
  assert.match(config.plugins.updater.pubkey, /^dW50cnVzdGVk/)
  assert.match(config.plugins.updater.endpoints[0], /github\.com\/jtc268\/balto-speedrunner/)
  assert.equal(config.plugins.updater.dialog, false)
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser')
  assert.equal(config.bundle.windows.nsis.template, 'nsis/one-click.nsi')
  const installer = await read('src-tauri/nsis/one-click.nsi')
  assert.match(installer, /Balto is a zero-click per-user install\./)
  assert.match(installer, /StrCpy \$PassiveMode 1/)
  assert.match(installer, /ExecShell "open" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/)
  const app = await read('src/app.js')
  assert.match(app, /check_for_updates/)
  assert.match(app, /install_update/)
  assert.match(app, /updateButton\.addEventListener\('click', installAvailableUpdate\)/)
  assert.doesNotMatch(app, /updateButton\.addEventListener\('click', \(\) => elements\.settings\.showModal/)
  assert.match(await read('src/styles.css'), /\.icon-button\[hidden\] \{ display: none; \}/)
})

test('product copy contains no em dash characters', async () => {
  const paths = [
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'src/index.html',
    'src/app.js',
    'src/styles.css',
    'runtime/balto.ps1',
    'runtime/gateway.mjs',
    'runtime/assets/balto-ui.js',
    'src-tauri/nsis/one-click.nsi',
  ]
  for (const path of paths) assert.doesNotMatch(await read(path), /—/, path)
})

test('first launch sets itself up and opens the familiar workspace', async () => {
  const app = await read('src/app.js')
  const html = await read('src/index.html')
  assert.match(app, /status\.phase === 'not-installed'/)
  assert.match(app, /status\.phase === 'failed'/)
  assert.match(app, /\['degraded', 'stopped'\]\.includes\(status\.phase\)/)
  assert.match(app, /Number\(status\.progress \|\| 0\) < 100/)
  assert.match(app, /runAction\('setup_stack'\)/)
  assert.match(app, /MAX_SETUP_RECOVERY_ATTEMPTS = 4/)
  assert.match(app, /scheduleAutomaticRecovery\(status\)/)
  assert.match(app, /Retrying automatically/)
  assert.match(app, /invoke\('open_workspace', \{ fresh \}\)/)
  assert.match(app, /freshWorkspaceRequested = true/)
  assert.match(app, /renderJourney\(status, progress, ready, failed, recovering\)/)
  assert.match(app, /status\.downloadedGb/)
  assert.match(app, /About \$\{formatDuration\(etaSeconds\)\} left/)
  assert.match(html, /id="setup-journey"/)
  assert.match(html, /class="balto-runner"/)
  assert.match(html, />Download Qwen</)
  assert.match(html, /About 24 GB, saved safely as it downloads/)
  assert.doesNotMatch(html, />Docker engine</)
  assert.match(html, />Inference engine</)
  const setup = await read('runtime/balto.ps1')
  assert.match(setup, /wsl\.exe --version/)
  assert.match(setup, /--no-distribution/)
  assert.match(setup, /--user', '--quiet', '--accept-license'/)
  assert.match(setup, /function Invoke-LoggedNative/)
  assert.match(setup, /function ConvertFrom-ExtendedWindowsPath/)
  assert.match(setup, /\$PathValue\.StartsWith\('\\\\\?\\'\)/)
  assert.match(setup, /function Test-HttpReady/)
  assert.match(setup, /\$gatewayReady = \(Test-BaltoProcess 'gateway\.pid' 'gateway\.mjs'\)/)
  assert.match(setup, /\$quotedArguments = \$Arguments/)
  assert.match(setup, /ArgumentList = \$quotedArguments/)
  assert.match(setup, /http:\/\/127\.0\.0\.1:30000\/health/)
  assert.match(setup, /js-yaml@4\.2\.0/)
  assert.match(setup, /\[System\.IO\.DriveInfo\]::GetDrives\(\)/)
  assert.match(setup, /\[System\.Diagnostics\.ProcessStartInfo\]::new\(\)/)
  assert.match(setup, /RedirectStandardError = \$true/)
  assert.match(setup, /workspace install attempt \$attempt needs another pass/i)
  assert.match(setup, /--loglevel=error/)
  assert.match(setup, /if \(\$exitCode -ne 0/)
  assert.match(setup, /downloadRateMbps = \$downloadRateMbps/)
  assert.match(setup, /etaSeconds = \$etaSeconds/)
  assert.match(setup, /stage = 'model'/)
  assert.match(setup, /GetFolderPath\(\[Environment\+SpecialFolder\]::MyDocuments\)/)
  assert.match(setup, /\$workspaceRoot = Join-Path \$documentsRoot 'Balto'/)
  assert.match(setup, /function Ensure-DefaultWorkspace/)
  assert.match(setup, /title = 'Balto'/)
  assert.match(setup, /Ensure-DefaultWorkspace/)
  assert.match(setup, /Start-BaltoProcess 'workspace\.pid' \$nodeExe \$arguments 'dsh\\lib\\bin\.js' \$workspaceRoot/)
  assert.doesNotMatch(setup, /takeover|Get-CompetingModelContainers|lms unload --all/)
  assert.doesNotMatch(setup, /Another local model|Another app is using|Stop-CompetingModels/)
  assert.doesNotMatch(app, /competingModels|take_over_gpu/)
  assert.match(html, /Unload any other local models before starting Balto/)
  assert.match(html, />Start</)
  assert.doesNotMatch(html, /Single-model guard/)
  assert.match(html, /Code at 150 tok\/s · Chat at up to 300 tok\/s</)
  assert.match(html, /<strong>Qwen model<\/strong><span>Optimized for this RTX 5090<\/span>/)
  assert.match(html, /<strong>Coding workspace<\/strong><span>Efficient local tool calls<\/span>/)
  assert.match(html, /<strong>Private web app<\/strong>/)
  assert.match(app, /Turn on to get your private web app link/)
  assert.match(app, /elements\.remoteUrl\.textContent = status\.remoteUrl/)
  const workspaceUi = await read('runtime/assets/balto-ui.js')
  assert.match(workspaceUi, /URLSearchParams\(location\.search\)\.get\('balto'\) !== 'new'/)
  assert.match(workspaceUi, /history\.replaceState/)
  assert.match(workspaceUi, /button\.click\(\)/)
  assert.match(workspaceUi, /dismissInternalTestingNotice/)
  assert.match(workspaceUi, /Internal Testing Notice/)
  assert.match(await read('src-tauri/src/lib.rs'), /http:\/\/127\.0\.0\.1:3080\/\?balto=new/)
})
