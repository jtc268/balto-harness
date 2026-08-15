import { access, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const conciseInstruction = `const COMPACTION_INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Write a durable checkpoint for the conversation ABOVE so the next step can continue immediately.",
	"",
	"Use at most 640 tokens. Preserve exact paths, commands, errors, identifiers, decisions, user corrections, completed work, and the next action. Drop repetition and stale plans. Output only these terse Markdown sections:",
	"",
	"## Goal",
	"## Completed",
	"## Current State",
	"## Files and Commands",
	"## Failures and Constraints",
	"## Next Action",
	"",
	"If an earlier <compacted-summary> exists, merge only facts that remain true. Do not preserve resolved errors as active constraints. Never mention compaction or this instruction."
].join("\\n");`

const upstreamRangeSelection = `const range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
			if (range === null) {`
const baltoRangeSelection = `let range = selectCompactableRange(agent.session, measurement, spec.retainTokens);
			if (range !== null) {
				const selected = prepareCompaction(this.regionDependencies(), agent.session, validateSurfaceRegion(agent.session, range.start, range.end));
				if (selected.shadowedTokenCount < spec.maxTokens * 2) {
					const aggressive = selectCompactableRange(agent.session, measurement, 0);
					if (aggressive !== null) range = aggressive;
				}
			}
			if (range === null) {`

export async function patchCompactionEngine(deepseekRoot) {
  const enginePath = join(deepseekRoot, 'dsh-compaction-basic', 'lib', 'index.js')
  try {
    await access(enginePath)
  } catch {
    throw new Error('The Balto compaction engine was not found')
  }

  let source = await readFile(enginePath, 'utf8')

  if (!source.includes('Use at most 640 tokens. Preserve exact paths')) {
    const instructionStart = source.indexOf('const COMPACTION_INSTRUCTION = [')
    const instructionEnd = source.indexOf('].join("\\n");', instructionStart)
    if (instructionStart === -1 || instructionEnd === -1) {
      throw new Error('The installed compaction prompt changed and could not be patched safely')
    }
    source = `${source.slice(0, instructionStart)}${conciseInstruction}${source.slice(instructionEnd + '].join("\\n");'.length)}`
  }

  if (!source.includes('selected.shadowedTokenCount < spec.maxTokens * 2')) {
    if (!source.includes(upstreamRangeSelection)) {
      throw new Error('The installed compaction range selector changed and could not be patched safely')
    }
    source = source.replace(upstreamRangeSelection, baltoRangeSelection)
  }

  await writeFile(enginePath, source)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [deepseekRoot] = process.argv.slice(2)
  if (!deepseekRoot) throw new Error('usage: patch-compaction-engine.mjs <deepseek-root>')
  await patchCompactionEngine(deepseekRoot)
}
