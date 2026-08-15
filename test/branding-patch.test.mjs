import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('branding patch runs before the upstream module and removes its boot wordmark', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balto-branding-'))
  const dshRoot = join(root, 'dsh')
  const dist = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
  const assets = join(dist, 'assets')
  const goalDriver = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-goal-round-driver', 'lib')
  await mkdir(assets, { recursive: true })
  await mkdir(goalDriver, { recursive: true })
  await writeFile(
    join(dist, 'index.html'),
    '<html><head><title>DeepSeek Harness</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  )
  await writeFile(join(assets, 'app.js'), 'const boot={children:"HARNESS"};const product="DeepSeek Harness"')
  await writeFile(
    join(goalDriver, 'index.js'),
    'if (event.data.reason.kind === "max-tokens") {\n\t\t\t\t\t\tdisarm(state);\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}',
  )

  try {
    await execFileAsync(process.execPath, [join(repoRoot, 'runtime', 'patch-dsh.mjs'), dshRoot, join(repoRoot, 'runtime')])
    const html = await readFile(join(dist, 'index.html'), 'utf8')
    const bundle = await readFile(join(assets, 'app.js'), 'utf8')
    assert.ok(html.indexOf('/assets/balto-ui.js') < html.indexOf('<script type="module"'))
    assert.match(html, /id="balto-prepaint"/)
    assert.match(html, /svg\[viewBox="0 0 182 24"\]\{visibility:hidden!important\}/)
    assert.doesNotMatch(html, /DeepSeek Harness/)
    assert.doesNotMatch(bundle, /HARNESS/)
    assert.doesNotMatch(bundle, /DeepSeek Harness/)
    assert.match(bundle, /children:"BALTO"/)
    const continuation = await readFile(join(goalDriver, 'index.js'), 'utf8')
    assert.match(continuation, /state\.needsCheckpoint = true/)
    assert.match(continuation, /requestDrive\(state\)/)
    assert.doesNotMatch(continuation, /disarm\(state\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preview badge is removed from the Balto hero', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /\[class\*="_previewBadge"\]/)
  assert.match(script, /display: none !important/)
  assert.match(script, /\['@deepseek-ai\/dsh-system-prompt', 'Balto system prompt'\]/)
})

test('live meter is compact and animated', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.doesNotMatch(script, /class="balto-brand"/)
  assert.doesNotMatch(script, /class="balto-name">Balto/)
  assert.match(script, /class="balto-sprinter"/)
  assert.match(script, /@keyframes balto-sprint/)
  assert.match(script, /@keyframes balto-trail/)
  assert.match(script, /prefers-reduced-motion: reduce/)
  assert.match(script, /if \(!\(root instanceof Node\)\) return/)
})
