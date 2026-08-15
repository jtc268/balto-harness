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
  const agentLoop = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib')
  const piAdapter = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib')
  const compaction = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib')
  const codePreset = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'code')
  const standardPreset = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard')
  await mkdir(assets, { recursive: true })
  await mkdir(goalDriver, { recursive: true })
  await mkdir(agentLoop, { recursive: true })
  await mkdir(piAdapter, { recursive: true })
  await mkdir(compaction, { recursive: true })
  await mkdir(codePreset, { recursive: true })
  await mkdir(standardPreset, { recursive: true })
  await writeFile(
    join(dist, 'index.html'),
    '<html><head><title>DeepSeek Harness</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  )
  await writeFile(join(assets, 'app.js'), 'const boot={children:"HARNESS"};const product="DeepSeek Harness"')
  await writeFile(
    join(goalDriver, 'index.js'),
    'if (event.data.reason.kind === "max-tokens") {\n\t\t\t\t\t\tdisarm(state);\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}\nctx.on("agent/error", ({ agent }) => {\n\t\t\tdisarm(stateFor(agent));\n\t\t});',
  )
  await writeFile(
    join(agentLoop, 'index.js'),
    'const message = {...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}};\nif (finish.kind === "max-tokens") return { kind: "max-tokens" };',
  )
  await writeFile(
    join(piAdapter, 'index.js'),
    'function foreignAssistant(message) { return message; }\nif (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");',
  )
  await writeFile(
    join(compaction, 'index.js'),
    'const COMPACTION_INSTRUCTION = ["old prompt"].join("\\n");\nconst range = selectCompactableRange(agent.session, measurement, spec.retainTokens);\n\t\t\tif (range === null) {',
  )
  await writeFile(
    join(codePreset, 'agent.cordis.yml'),
    "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n- id: tool-presentation\n  name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config:\n    mode: code\n",
  )
  await writeFile(
    join(standardPreset, 'agent.cordis.yml'),
    "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n",
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
    assert.match(continuation, /ctx\.goals\.pause/)
    const agentContinuation = await readFile(join(agentLoop, 'index.js'), 'utf8')
    assert.match(agentContinuation, /plugin: "balto-auto-continuation"/)
    assert.match(agentContinuation, /this\.inbox\.splice\("next-step"/)
    assert.match(agentContinuation, /return null/)
    assert.match(agentContinuation, /finish\.kind !== "max-tokens"/)
    const replayRecovery = await readFile(join(piAdapter, 'index.js'), 'utf8')
    assert.match(replayRecovery, /state\.stopReason === "length"/)
    assert.match(replayRecovery, /return foreignAssistant\(message\)/)
    const checkpointing = await readFile(join(compaction, 'index.js'), 'utf8')
    assert.match(checkpointing, /Use at most 640 tokens/)
    assert.match(checkpointing, /selected\.shadowedTokenCount < spec\.maxTokens \* 2/)
    const codeTools = await readFile(join(codePreset, 'agent.cordis.yml'), 'utf8')
    assert.match(codeTools, /mode: both/)
    assert.doesNotMatch(codeTools, /mode: code/)
    assert.match(codeTools, /checkpoint progress through completed tool calls/)
    const standardAgent = await readFile(join(standardPreset, 'agent.cordis.yml'), 'utf8')
    assert.match(standardAgent, /checkpoint progress through completed tool calls/)
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

test('collapsed sidebar uses a clear expand icon instead of a brand mark', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /function brandCollapsedSidebar\(\)/)
  assert.match(script, /data-balto-collapse-icon/)
  assert.match(script, /svg\[class\*="_railFish"\]/)
  assert.match(script, /toggle\.insertBefore\(icon, whale \|\| toggle\.firstChild\)/)
  assert.match(script, /<rect x="3\.5" y="3\.5" width="17" height="17" rx="3">/)
  assert.match(script, /<path d="M9 4v16">/)
  assert.match(script, /button\[aria-label="Open sidebar"\] > svg:not\(\[data-balto-collapse-icon\]\)/)
  assert.match(script, /button:not\(\[aria-label="Open sidebar"\]\) > svg\[data-balto-collapse-icon\]/)
  assert.doesNotMatch(script, /data-balto-collapse-mark/)
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
  assert.match(script, /mutation\.type === 'characterData'/)
  assert.match(script, /childList: true, characterData: true, subtree: true/)
  assert.match(script, /target = isLive \? Number\(data\.tokensPerSecond \|\| 0\) : 0/)
  assert.match(script, /bar\.dataset\.state = isLive \? 'live' : 'idle'/)
})

test('signed updates live beside the main interface speedometer', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /class="balto-update-button"/)
  assert.match(script, /aria-label="Install Balto update"/)
  assert.match(script, /await tauriInvoke\('check_for_updates'\)/)
  assert.match(script, /await tauriInvoke\('install_update'\)/)
  assert.match(script, /updateButton\.hidden = !availableUpdate/)
  assert.match(script, /@keyframes balto-update/)
})

test('remote control settings only mount on the General tab', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /generalButton\?\.getAttribute\('aria-current'\) === 'true'/)
  assert.match(script, /if \(!generalIsActive\) \{/)
  assert.match(script, /existingRow\?\.remove\(\)/)
})

test('the add menu exposes mobile-safe image attachments while preserving paste intake', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /function mountAttachmentControl\(\)/)
  assert.match(script, /id = 'balto-attachment-input'/)
  assert.match(script, /input\.accept = 'image\/png,image\/jpeg,image\/webp,image\/gif'/)
  assert.match(script, />Attach file</)
  assert.match(script, /PNG, JPG, WebP, or GIF/)
  assert.match(script, /balto-attachment-paperclip/)
  assert.match(script, /new Event\('paste', \{ bubbles: true, cancelable: true \}\)/)
  assert.match(script, /Object\.defineProperty\(paste, 'clipboardData'/)
  assert.match(script, /target\.dispatchEvent\(paste\)/)
  assert.match(script, /button\[aria-label="Commands"\], button\[data-balto-add="true"\]/)
})

test('mobile UI uses an overlay drawer and collision-free compact controls', async () => {
  const script = await readFile(join(repoRoot, 'runtime', 'assets', 'balto-ui.js'), 'utf8')
  assert.match(script, /const mobileSidebarQuery = window\.matchMedia\('\(max-width: 720px\)'\)/)
  assert.match(script, /id = 'balto-mobile-sidebar-backdrop'/)
  assert.match(script, /function closeMobileSidebarAfterSelection\(event\)/)
  assert.match(script, /session && !session\.hasAttribute\('aria-expanded'\)/)
  assert.match(script, /sidebar\.querySelector\('button\[aria-label="Collapse sidebar"\]'\)\?\.click\(\)/)
  assert.match(script, /function syncMobileKeyboard\(\)/)
  assert.match(script, /window\.innerHeight - viewport\.height - viewport\.offsetTop/)
  assert.match(script, /body\.classList\.toggle\('balto-keyboard-open', keyboardOpen\)/)
  assert.match(script, /grid-template-columns: 0 minmax\(0, 1fr\) 0 !important/)
  assert.match(script, /body\.balto-mobile-sidebar-open #balto-live-bar/)
  assert.match(script, /\.wSkVaW_titleRow \{ display: none !important; \}/)
  assert.match(script, /min-height: 88px !important/)
  assert.match(script, /justify-content: center !important;\s+gap: 32px !important/)
  assert.match(script, /\[role="tooltip"\] \{ display: none !important; \}/)
  assert.match(script, /z-index: 1200;\s+inset: 0;\s+display: block/)
  assert.doesNotMatch(script, /backdrop-filter: blur\(2px\)/)
  assert.match(script, /\.uV2eYG_root \.FJxK0a_root,/)
  assert.match(script, /\._7KE1Ra_root \{ min-width: 0; max-width: 118px; \}/)
  assert.match(script, /width: 100% !important;\s+min-width: 0;\s+max-width: 100% !important/)
  assert.match(script, /\._7KE1Ra_menu \{\s+right: -46px !important/)
  assert.match(script, /--dsh-composer-side-clearance: 0px/)
  assert.match(script, /\.uV2eYG_card \{ width: 100% !important; max-width: none !important/)
  assert.match(script, /body\.balto-keyboard-open \.wSkVaW_composerStack/)
  assert.match(script, /translateY\(calc\(-1 \* var\(--balto-keyboard-inset, 0px\)\)\)/)
  assert.match(script, /#balto-live-bar \.balto-sprinter \{ width: 38px; height: 26px; \}/)
  assert.match(script, /#balto-live-bar \.balto-sprinter::after \{ content: ""; position: absolute; left: 0;/)
  assert.match(script, /@media \(max-width: 360px\)/)
  assert.match(script, /\.VOzbGW_panel \{/)
  assert.match(script, /height: 100dvh/)
})
