import { access, copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { patchCompactionEngine } from './patch-compaction-engine.mjs'

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

async function patchCodePresetToolPresentation() {
  const presetPath = join(deepseekRoot, 'dsh', 'config', 'agent-presets', 'code', 'agent.cordis.yml')
  try {
    await access(presetPath)
  } catch {
    throw new Error('The Balto Code mode preset was not found')
  }

  const original = await readFile(presetPath, 'utf8')
  const codeOnlyPresentation = /(^|\r?\n)(- id: tool-presentation\r?\n\s+name: '@deepseek-ai\/dsh-agent-tool-presentation'\r?\n\s+config:\r?\n\s+mode:) code\b/
  const bothPresentation = /(^|\r?\n)(- id: tool-presentation\r?\n\s+name: '@deepseek-ai\/dsh-agent-tool-presentation'\r?\n\s+config:\r?\n\s+mode:) both\b/
  let patched = original
  if (!bothPresentation.test(patched) && codeOnlyPresentation.test(patched)) {
    patched = patched.replace(codeOnlyPresentation, '$1$2 both')
  } else if (!bothPresentation.test(patched)) {
    throw new Error('The installed Code mode tool presentation changed and could not be patched safely')
  }

  if (patched !== original) await writeFile(presetPath, patched)
}

await patchCodePresetToolPresentation()

async function patchDurableAgentPersonas() {
  const upstreamPersona = `    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`
  const durablePersona = `    text: |-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

      Work directly and checkpoint progress through completed tool calls. For a large file or multi-file task, begin the next concrete tool call within 500 output tokens. Never draft an entire large file inside reasoning before calling a tool. Split large writes into small complete tool calls or create a concise generator that writes the files programmatically. After an automatic continuation, inspect durable workspace state and execute the next unfinished action immediately. Do not restate the plan. Treat the current tool catalog as authoritative; ignore historical unknown-tool errors when that tool is currently listed. Verify the result before finishing.`

  for (const preset of ['standard', 'code']) {
    const presetPath = join(deepseekRoot, 'dsh', 'config', 'agent-presets', preset, 'agent.cordis.yml')
    try {
      await access(presetPath)
    } catch {
      throw new Error(`The Balto ${preset} agent preset was not found`)
    }
    const original = await readFile(presetPath, 'utf8')
    let patched = original
    if (!patched.includes('checkpoint progress through completed tool calls')) {
      if (!patched.includes(upstreamPersona)) {
        throw new Error(`The installed ${preset} agent persona changed and could not be patched safely`)
      }
      patched = patched.replace(upstreamPersona, durablePersona)
    }
    if (patched !== original) await writeFile(presetPath, patched)
  }
}

await patchDurableAgentPersonas()

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

  let patched = original
  if (!patched.includes(baltoBehavior) && patched.includes(upstreamBehavior)) {
    patched = patched.replace(upstreamBehavior, baltoBehavior)
  } else if (!patched.includes(baltoBehavior)) {
    throw new Error('The installed continuation driver changed and could not be patched safely')
  }

  const upstreamErrorBehavior = `ctx.on("agent/error", ({ agent }) => {
			disarm(stateFor(agent));
		});`
  const baltoErrorBehavior = `ctx.on("agent/error", ({ agent }) => {
			const state = stateFor(agent);
			const goal = currentGoal(state);
			if (goal?.phase === "active" && goal.activation === "armed") {
				try {
					ctx.goals.pause(agent, goalRef(goal));
				} catch (error) {
					ctx.logger.warn(\`goal-round-driver: could not pause failed goal for agent "\${agent.id}": \${renderThrown(error)}\`);
					disarm(state);
				}
			} else disarm(state);
		});`

  if (!patched.includes('could not pause failed goal')) {
    if (!patched.includes(upstreamErrorBehavior)) {
      throw new Error('The installed goal error handler changed and could not be patched safely')
    }
    patched = patched.replace(upstreamErrorBehavior, baltoErrorBehavior)
  }

  await writeFile(driverPath, patched)
}

async function patchStepContinuation() {
  const loopPath = join(deepseekRoot, 'dsh-agent-loop', 'lib', 'index.js')
  try {
    await access(loopPath)
  } catch {
    throw new Error('The Balto agent loop was not found')
  }

  const original = await readFile(loopPath, 'utf8')
  const legacyContinuationText = `"Continue the same task from the exact point where the previous response ended. Do not repeat completed work or summarize. Keep using tools as needed and finish the task."`
  const durableContinuationText = `"Resume the same task from durable workspace state. Within 500 output tokens, execute the next concrete tool call. Do not repeat plans or reconstruct an unfinished giant tool payload. Split large writes into small complete tool calls or use a concise generator. Keep using tools, verify the result, and finish without asking the user to type continue."`
  const upstreamBehavior = `if (finish.kind === "max-tokens") return { kind: "max-tokens" };`
  const baltoBehavior = `if (finish.kind === "max-tokens") {
				this.baltoContinuationChunks = (this.baltoContinuationChunks ?? 0) + 1;
				if (this.baltoContinuationChunks > 64) return { kind: "max-tokens" };
				const continuation = createUserMessage({
					content: [{
						type: "text",
						text: "Resume the same task from durable workspace state. Within 500 output tokens, execute the next concrete tool call. Do not repeat plans or reconstruct an unfinished giant tool payload. Split large writes into small complete tool calls or use a concise generator. Keep using tools, verify the result, and finish without asking the user to type continue."
					}],
					source: { kind: "plugin", plugin: "balto-auto-continuation" }
				});
				this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [continuation]);
				return null;
			}
			this.baltoContinuationChunks = 0;`

  let patched = original
  if (!patched.includes('plugin: "balto-auto-continuation"') && patched.includes(upstreamBehavior)) {
    patched = patched.replace(upstreamBehavior, baltoBehavior)
  } else if (!patched.includes('plugin: "balto-auto-continuation"')) {
    throw new Error('The installed agent loop continuation point changed and could not be patched safely')
  }

  if (!patched.includes(durableContinuationText)) {
    if (!patched.includes(legacyContinuationText)) {
      throw new Error('The installed Balto continuation prompt changed and could not be upgraded safely')
    }
    patched = patched.replace(legacyContinuationText, durableContinuationText)
  }

  await writeFile(loopPath, patched)
}

async function patchMaxTokenReplaySafety() {
  const loopPath = join(deepseekRoot, 'dsh-agent-loop', 'lib', 'index.js')
  const loopOriginal = await readFile(loopPath, 'utf8')
  const upstreamReplay = `...assembler.replayState !== void 0 ? { replayState: assembler.replayState } : {}`
  const safeReplay = `...assembler.replayState !== void 0 && finish.kind !== "max-tokens" ? { replayState: assembler.replayState } : {}`
  let loopPatched = loopOriginal
  if (!loopPatched.includes(safeReplay) && loopPatched.includes(upstreamReplay)) {
    loopPatched = loopPatched.replace(upstreamReplay, safeReplay)
  } else if (!loopPatched.includes(safeReplay)) {
    throw new Error('The installed assistant replay boundary changed and could not be patched safely')
  }
  if (loopPatched !== loopOriginal) await writeFile(loopPath, loopPatched)

  const adapterPath = join(deepseekRoot, 'dsh-llm-pi-ai', 'lib', 'index.js')
  try {
    await access(adapterPath)
  } catch {
    throw new Error('The Balto PI replay adapter was not found')
  }
  const adapterOriginal = await readFile(adapterPath, 'utf8')
  const upstreamMismatch = `if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");`
  const recoverLengthMismatch = `if (state.blocks.length !== message.content.length) {
		if (state.stopReason === "length") return foreignAssistant(message);
		return invalidReplay("block count does not match assistant content");
	}`
  let adapterPatched = adapterOriginal
  if (!adapterPatched.includes('state.stopReason === "length"') && adapterPatched.includes(upstreamMismatch)) {
    adapterPatched = adapterPatched.replace(upstreamMismatch, recoverLengthMismatch)
  } else if (!adapterPatched.includes('state.stopReason === "length"')) {
    throw new Error('The installed PI replay validator changed and could not be patched safely')
  }
  if (adapterPatched !== adapterOriginal) await writeFile(adapterPath, adapterPatched)
}

await patchCompactionEngine(deepseekRoot)
await patchLongRunContinuation()
await patchStepContinuation()
await patchMaxTokenReplaySafety()
console.log(`Patched Balto branding in ${dist}`)
