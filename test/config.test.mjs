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
})

test('remote access remains tailnet-only', async () => {
  const script = await read('runtime/balto.ps1')
  assert.match(script, /tailscale serve --bg --yes --https=3080 127\.0\.0\.1:3080/)
  assert.match(script, /tailscale serve --bg --yes --https=30100 127\.0\.0\.1:30100/)
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
  assert.match(app, /runAction\('setup_stack'\)/)
  assert.match(app, /invoke\('open_workspace'\)/)
  assert.doesNotMatch(html, />Docker engine</)
  assert.match(html, />Inference engine</)
  const setup = await read('runtime/balto.ps1')
  assert.match(setup, /wsl\.exe --version/)
  assert.match(setup, /--no-distribution/)
  assert.match(setup, /--user', '--quiet', '--accept-license'/)
  assert.match(setup, /'takeover'/)
  assert.match(setup, /docker stop \$name/)
  assert.match(setup, /lms unload --all/)
  assert.match(app, /runAction\('take_over_gpu'\)/)
})
