import { access, copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [dshRoot, resources] = process.argv.slice(2)
if (!dshRoot || !resources) throw new Error('usage: patch-dsh.mjs <dsh-root> <resources>')

const deepseekRoots = [
  join(dshRoot, 'node_modules', '@deepseek-ai'),
  join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
]
let deepseekRoot
for (const candidate of deepseekRoots) {
  try {
    await access(join(candidate, 'dsh-web-frontend', 'dist', 'index.html'))
    deepseekRoot = candidate
    break
  } catch {
    // npm may hoist the pinned DSH packages or keep them nested.
  }
}
if (!deepseekRoot) throw new Error('The Balto coding workspace frontend was not found')
const dist = join(deepseekRoot, 'dsh-web-frontend', 'dist')
const assets = join(dist, 'assets')
const scriptTag = '<script defer src="/assets/balto-ui.js"></script>'
const prepaintStyle = '<style id="balto-prepaint">svg[viewBox="0 0 182 24"]{visibility:hidden!important}</style>'

await copyFile(join(resources, 'assets', 'balto-ui.js'), join(assets, 'balto-ui.js'))
await copyFile(join(resources, 'assets', 'balto-mark.svg'), join(assets, 'balto-mark.svg'))
await copyFile(join(resources, 'assets', 'balto-mark.svg'), join(dist, 'favicon.svg'))

const indexPath = join(dist, 'index.html')
let index = await readFile(indexPath, 'utf8')
index = index.replaceAll('DeepSeek Harness', 'Balto Speedrunner')
index = index
  .replace(/\s*<style id="balto-prepaint">[\s\S]*?<\/style>\s*/g, '\n')
  .replace(/\s*<script defer src="\/assets\/balto-ui\.js"><\/script>\s*/g, '\n')
const firstModule = '<script type="module"'
const earlyBranding = `${prepaintStyle}\n    ${scriptTag}\n    ${firstModule}`
index = index.includes(firstModule)
  ? index.replace(firstModule, earlyBranding)
  : index.replace('</head>', `    ${prepaintStyle}\n    ${scriptTag}\n  </head>`)
await writeFile(indexPath, index)

const manifestPath = join(dist, 'manifest.webmanifest')
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.name = 'Balto Speedrunner'
  manifest.short_name = 'Balto'
  manifest.description = 'Fast local coding agent for RTX 5090'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
} catch {
  // Older releases may not ship a manifest.
}

async function patchUserFacingBundles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await patchUserFacingBundles(path)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const original = await readFile(path, 'utf8')
    const patched = original
      .replaceAll('DeepSeek Harness', 'Balto Speedrunner')
      .replaceAll('DeepSeek-Harness', 'Balto Speedrunner')
      .replaceAll('children:"HARNESS"', 'children:"BALTO"')
      .replaceAll('children: "HARNESS"', 'children: "BALTO"')
    if (patched !== original) await writeFile(path, patched)
  }
}

await patchUserFacingBundles(deepseekRoot)

async function patchLongRunContinuation() {
  const driverPath = join(deepseekRoot, 'dsh-goal-round-driver', 'lib', 'index.js')
  try {
    await access(driverPath)
  } catch {
    throw new Error('The Balto long-run continuation driver was not found')
  }

  const original = await readFile(driverPath, 'utf8')
  const upstreamBehavior = `if (event.data.reason.kind === "max-tokens") {
\t\t\t\t\t\tdisarm(state);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`
  const baltoBehavior = `if (event.data.reason.kind === "max-tokens") {
\t\t\t\t\t\tstate.needsCheckpoint = true;
\t\t\t\t\t\trequestDrive(state);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`

  if (original.includes(baltoBehavior)) return
  if (!original.includes(upstreamBehavior)) {
    throw new Error('The installed continuation driver changed and could not be patched safely')
  }
  await writeFile(driverPath, original.replace(upstreamBehavior, baltoBehavior))
}

await patchLongRunContinuation()
console.log(`Patched Balto branding in ${dist}`)
