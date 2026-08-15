import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const MODEL = 'qwen3.8-27b-nvfp4-dspark'
const PROVIDER = 'sglang'
const SIGNAL = new AbortController().signal
const CHECKPOINT = [
  '## Primary Request and Intent',
  '- PRIMARY_TASK_PRESERVED',
  '## Files and Code',
  '- C:\\Balto\\workspace\\current.ts',
  '## Current Work',
  '- Continue CURRENT_TASK_SENTINEL',
  '## Next Step',
  '- Resume the next coding step',
].join('\n')

function numberField(section, name) {
  const match = section.match(new RegExp(`\\b${name}:\\s*(\\d+(?:\\.\\d+)?)`))
  assert.ok(match, `missing ${name} in Balto compaction policy`)
  return Number(match[1])
}

async function baltoPolicy() {
  const profile = await readFile(new URL('../runtime/templates/profile.patch.yml', import.meta.url), 'utf8')
  const section = profile.match(/- id: compaction-basic\b[\s\S]*?(?=\n- id:|$)/)?.[0]
  assert.ok(section, 'Balto compaction-basic profile is missing')
  assert.match(section, /disabled:\s*false/)
  assert.match(section, new RegExp(`provider:\\s*${PROVIDER}`))
  assert.match(section, new RegExp(`model:\\s*${MODEL.replaceAll('.', '\\.')}`))
  return {
    auto: true,
    modelPolicies: [{
      provider: PROVIDER,
      model: MODEL,
      thresholdRatio: numberField(section, 'thresholdRatio'),
      retainTokens: numberField(section, 'retainTokens'),
      maxTokens: numberField(section, 'maxTokens'),
      compactionRetries: numberField(section, 'compactionRetries'),
      maxOverflowRetries: numberField(section, 'maxOverflowRetries'),
    }],
  }
}

class CompactionAdapter extends LlmAdapter {
  requests = []

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 80_000 },
    })
  }

  async * stream(options) {
    this.requests.push(options)
    assert.equal(options.purpose, 'compaction')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: CHECKPOINT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  const adapter = new CompactionAdapter()
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const policy = await baltoPolicy()
  const compact = new BasicCompactionEngine(ctx, policy)
  return { ctx, adapter, compact, policy }
}

function longCodingSession(id) {
  const session = Session.create(SessionId(id))
  const userPadding = 'repository requirement and constraint '.repeat(300)
  const assistantPadding = 'implementation detail and verification '.repeat(300)
  const resultPadding = 'tool output line with source evidence '.repeat(220)

  for (let turn = 1; turn <= 8; turn += 1) {
    const callId = CallId(`read-${turn}`)
    const oldSentinel = turn === 1 ? 'OLD_HISTORY_SENTINEL ' : ''
    const currentSentinel = turn === 8 ? 'CURRENT_TASK_SENTINEL ' : ''
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${oldSentinel}${currentSentinel}${userPadding} user turn ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: PROVIDER, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `${assistantPadding} assistant turn ${turn}` },
          { type: 'tool-call', id: callId, name: 'read', arguments: `{"turn":${turn}}` },
        ],
        source: { kind: 'model', provider: PROVIDER, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn,
      step: 1,
      callId,
      name: 'read',
      arguments: `{"turn":${turn}}`,
    })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `${resultPadding} result turn ${turn}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 9 })
  return session
}

function owner(session) {
  return { session, options: { provider: PROVIDER, model: MODEL } }
}

function textOf(messages) {
  return JSON.stringify(messages)
}

function assertToolPairsAreUnique(messages) {
  const calls = new Map()
  const results = new Map()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, (calls.get(block.id) ?? 0) + 1)
      if (block.type === 'tool-result') results.set(block.toolCallId, (results.get(block.toolCallId) ?? 0) + 1)
    }
  }
  assert.ok(calls.size > 0, 'the retained surface should include recent tool calls')
  for (const [callId, count] of calls) {
    assert.equal(count, 1, `tool call ${callId} was duplicated`)
    assert.equal(results.get(callId), 1, `tool call ${callId} lost or duplicated its result`)
  }
  for (const [callId, count] of results) {
    assert.equal(count, 1, `tool result ${callId} was duplicated`)
    assert.equal(calls.get(callId), 1, `tool result ${callId} lost its call`)
  }
}

test('Balto compacts a pressured 80K coding session and resumes the step pipeline', async (t) => {
  const { ctx, adapter, policy } = await harness()
  try {
    const session = longCodingSession('balto-pressure-compaction')
    const before = ctx.tokenMeter.measure(session)
    const threshold = 80_000 * policy.modelPolicies[0].thresholdRatio
    assert.ok(before.totalTokens >= threshold, `${before.totalTokens} tokens did not reach ${threshold}`)
    let downstreamCalls = 0

    const decision = await agentEvents(ctx, owner(session)).waterfall(
      'agent/pre-step',
      { messages: [], turn: 9, step: 1, signal: SIGNAL },
      () => {
        downstreamCalls += 1
        return Promise.resolve({ kind: 'enter', messages: [] })
      },
    )

    assert.deepEqual(decision, { kind: 'enter', messages: [] })
    assert.equal(downstreamCalls, 1, 'the next step did not resume exactly once')
    assert.equal(adapter.requests.length, 1, 'expected one isolated summary request')
    assert.equal(adapter.requests[0].maxTokens, 1536)
    const summaryInput = textOf(adapter.requests[0].messages)
    assert.match(summaryInput, /OLD_HISTORY_SENTINEL/)
    assert.match(summaryInput, /acting as a compaction engine/)

    const after = ctx.tokenMeter.measure(session)
    assert.ok(after.totalTokens < threshold, `compacted surface is still above threshold: ${after.totalTokens}`)
    assert.ok(after.totalTokens < before.totalTokens, 'compaction did not reduce the request')
    t.diagnostic(`context reduced from ${before.totalTokens} to ${after.totalTokens} tokens; threshold ${threshold}`)

    const lifecycle = session.events
      .filter((event) => event.type.startsWith('compaction/'))
      .map((event) => event.type)
    assert.deepEqual(lifecycle, ['compaction/start', 'compaction/summary', 'compaction/end'])

    const current = session.deriveMessages()
    const currentText = textOf(current)
    assert.match(currentText, /PRIMARY_TASK_PRESERVED/)
    assert.match(currentText, /CURRENT_TASK_SENTINEL/)
    assert.doesNotMatch(currentText, /OLD_HISTORY_SENTINEL/)
    assertToolPairsAreUnique(current)
  } finally {
    await ctx.fiber.dispose()
  }
})

function giantIndivisibleStepSession(id) {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `OLD_TINY_SENTINEL ${'brief requirement '.repeat(180)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `GIANT_STEP_SENTINEL ${'generated implementation detail '.repeat(3800)}` }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `CURRENT_TASK_SENTINEL ${'current requirement '.repeat(500)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${'current implementation '.repeat(1000)} waiting for next step` }],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 3 })
  return session
}

test('Balto checkpoints a giant indivisible coding step instead of retrying a tiny sliver', async () => {
  const { ctx, adapter, policy } = await harness()
  try {
    const session = giantIndivisibleStepSession('balto-giant-step-compaction')
    const before = ctx.tokenMeter.measure(session)
    const threshold = 80_000 * policy.modelPolicies[0].thresholdRatio
    assert.ok(before.totalTokens >= threshold, `${before.totalTokens} tokens did not reach ${threshold}`)

    await agentEvents(ctx, owner(session)).waterfall(
      'agent/pre-step',
      { messages: [], turn: 3, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )

    assert.equal(adapter.requests.length, 1)
    assert.equal(adapter.requests[0].maxTokens, 1536)
    const summaryInput = textOf(adapter.requests[0].messages)
    assert.match(summaryInput, /OLD_TINY_SENTINEL/)
    assert.match(summaryInput, /GIANT_STEP_SENTINEL/)
    assert.deepEqual(
      session.events.filter((event) => event.type.startsWith('compaction/')).map((event) => event.type),
      ['compaction/start', 'compaction/summary', 'compaction/end'],
    )
    assert.ok(ctx.tokenMeter.measure(session).totalTokens < threshold)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('Balto force-compacts a provider overflow and requests one clean retry', async () => {
  const { ctx, adapter } = await harness()
  try {
    const session = longCodingSession('balto-overflow-compaction')
    const subject = owner(session)
    const generation = session.surface.replaceGeneration
    let downstreamCalls = 0
    const action = await agentEvents(ctx, subject).waterfall(
      'agent/request-error',
      {
        turn: 9,
        step: 1,
        provider: PROVIDER,
        failure: {
          message: 'request too large for model context',
          code: CONTEXT_WINDOW_EXCEEDED_CODE,
        },
        retryPolicy: undefined,
        signal: SIGNAL,
      },
      () => {
        downstreamCalls += 1
        return Promise.resolve(undefined)
      },
    )

    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(downstreamCalls, 0, 'overflow recovery delegated instead of retrying')
    assert.equal(adapter.requests.length, 1, 'overflow recovery summarized more than once')
    assert.equal(session.surface.replaceGeneration, generation + 1)
    assert.equal(session.events.filter((event) => event.type === 'turn/start' && event.data.turn === 9).length, 1)
    assertToolPairsAreUnique(session.deriveMessages())
  } finally {
    await ctx.fiber.dispose()
  }
})
