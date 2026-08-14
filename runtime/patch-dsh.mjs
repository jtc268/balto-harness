import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [dshRoot, resources] = process.argv.slice(2)
if (!dshRoot || !resources) throw new Error('usage: patch-dsh.mjs <dsh-root> <resources>')

const deepseekRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const dist = join(deepseekRoot, 'dsh-web-frontend', 'dist')
const assets = join(dist, 'assets')
const scriptTag = '    <script defer src="/assets/balto-ui.js"></script>'

await copyFile(join(resources, 'assets', 'balto-ui.js'), join(assets, 'balto-ui.js'))
await copyFile(join(resources, 'assets', 'balto-mark.svg'), join(assets, 'balto-mark.svg'))
await copyFile(join(resources, 'assets', 'balto-mark.svg'), join(dist, 'favicon.svg'))

const indexPath = join(dist, 'index.html')
let index = await readFile(indexPath, 'utf8')
index = index.replaceAll('DeepSeek Harness', 'Balto Harness')
if (!index.includes('/assets/balto-ui.js')) index = index.replace('</body>', `${scriptTag}\n  </body>`)
await writeFile(indexPath, index)

const manifestPath = join(dist, 'manifest.webmanifest')
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.name = 'Balto Harness'
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
      .replaceAll('DeepSeek Harness', 'Balto Harness')
      .replaceAll('DeepSeek-Harness', 'Balto Harness')
    if (patched !== original) await writeFile(path, patched)
  }
}

await patchUserFacingBundles(deepseekRoot)
console.log(`Patched Balto branding in ${dist}`)
