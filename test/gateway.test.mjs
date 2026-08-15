import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

test('gateway applies safe sampling and reports exact streaming speed', async (context) => {
  const gatewaySource = await readFile(new URL('../runtime/gateway.mjs', import.meta.url), 'utf8')
  assert.match(gatewaySource, /'connection'/)
  assert.match(gatewaySource, /'transfer-encoding'/)
  assert.match(gatewaySource, /error\.cause\?\.message/)
  assert.match(gatewaySource, /completionTokens < 4/)
  assert.match(gatewaySource, /BALTO_MAX_STEP_OUTPUT_TOKENS/)
  assert.match(gatewaySource, /acting as a compaction engine/)
  assert.match(gatewaySource, /new URL\('\/v1\/models', upstream\)/)
  assert.doesNotMatch(gatewaySource, /new URL\('\/health', upstream\)/)
  let received
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let token = 1; token <= 4; token++) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }], usage: { completion_tokens: token } })}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    response.end('data: [DONE]\n\n')
  })
  const upstreamPort = await listen(upstream)
  context.after(() => upstream.close())

  const portProbe = http.createServer()
  const gatewayPort = await listen(portProbe)
  await new Promise((resolve) => portProbe.close(resolve))

  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/gateway.mjs', import.meta.url))], {
    env: {
      ...process.env,
      BALTO_GATEWAY_PORT: String(gatewayPort),
      BALTO_INFERENCE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: 'ignore',
  })
  context.after(() => child.kill())

  await waitFor(`http://127.0.0.1:${gatewayPort}/health`)
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'anything',
      stream: true,
      max_completion_tokens: 4096,
      messages: [
        { role: 'developer', content: 'You are Balto.' },
        { role: 'user', content: 'test' },
      ],
    }),
  })
  assert.equal(response.status, 200)
  await response.text()

  assert.equal(received.model, 'qwen3.8-27b-nvfp4-dspark')
  assert.equal(received.messages[0].role, 'system')
  assert.equal(received.max_tokens, 4096)
  assert.equal('max_completion_tokens' in received, false)
  assert.equal(received.temperature, 0.6)
  assert.equal(received.top_p, 0.95)
  assert.equal(received.top_k, 20)
  assert.equal(received.seed, 0)
  assert.equal(received.stream_options.continuous_usage_stats, true)

  const telemetry = await fetch(`http://127.0.0.1:${gatewayPort}/speed`).then((item) => item.json())
  assert.equal(telemetry.state, 'complete')
  assert.equal(telemetry.error, null)
  assert.equal(telemetry.completionTokens, 4)
  assert.ok(telemetry.tokensPerSecond > 0)
})

test('gateway budgets output against context and isolates compaction telemetry', async (context) => {
  const received = []
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let token = 1; token <= 4; token++) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }], usage: { completion_tokens: token } })}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    response.end('data: [DONE]\n\n')
  })
  const upstreamPort = await listen(upstream)
  context.after(() => upstream.close())

  const portProbe = http.createServer()
  const gatewayPort = await listen(portProbe)
  await new Promise((resolve) => portProbe.close(resolve))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/gateway.mjs', import.meta.url))], {
    env: {
      ...process.env,
      BALTO_GATEWAY_PORT: String(gatewayPort),
      BALTO_INFERENCE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: 'ignore',
  })
  context.after(() => child.kill())
  await waitFor(`http://127.0.0.1:${gatewayPort}/health`)

  const send = async (messages, maxTokens) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anything', stream: true, max_tokens: maxTokens, messages }),
    })
    assert.equal(response.status, 200)
    await response.text()
  }

  await send([{ role: 'user', content: 'normal coding turn' }], 32768)
  const foreground = await fetch(`http://127.0.0.1:${gatewayPort}/speed`).then((item) => item.json())
  assert.equal(foreground.completionTokens, 4)
  assert.equal(received[0].max_tokens, 32768)

  await send([{ role: 'user', content: 'You are now acting as a compaction engine for this AI coding assistant.' }], 768)
  const afterCompaction = await fetch(`http://127.0.0.1:${gatewayPort}/speed`).then((item) => item.json())
  assert.equal(afterCompaction.completionTokens, 4)
  assert.equal(afterCompaction.maintenance, null)
  assert.equal(afterCompaction.lastMaintenance.state, 'complete')
  assert.equal(afterCompaction.lastMaintenance.maxTokens, 768)
  assert.equal(received[1].chat_template_kwargs.enable_thinking, false)
  assert.equal(received[1].temperature, 0)

  await send([{ role: 'user', content: 'x'.repeat(175000) }], 32768)
  assert.ok(received[2].max_tokens > 0)
  assert.ok(received[2].max_tokens < 32768, `long prompt reserved ${received[2].max_tokens} output tokens`)
})

test('gateway survives an interrupted upstream stream and remains healthy', async (context) => {
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}')
      return
    }
    for await (const _chunk of request) {
      // Drain the request before forcing a mid-stream reset.
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    response.socket.destroy()
  })
  const upstreamPort = await listen(upstream)
  context.after(() => upstream.close())

  const portProbe = http.createServer()
  const gatewayPort = await listen(portProbe)
  await new Promise((resolve) => portProbe.close(resolve))

  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/gateway.mjs', import.meta.url))], {
    env: {
      ...process.env,
      BALTO_GATEWAY_PORT: String(gatewayPort),
      BALTO_INFERENCE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: 'ignore',
  })
  context.after(() => child.kill())

  await waitFor(`http://127.0.0.1:${gatewayPort}/health`)
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'anything', stream: true, messages: [{ role: 'user', content: 'test' }] }),
  })
  await response.text()

  assert.equal(child.exitCode, null)
  await waitFor(`http://127.0.0.1:${gatewayPort}/health`)
  const telemetry = await fetch(`http://127.0.0.1:${gatewayPort}/speed`).then((item) => item.json())
  assert.equal(telemetry.state, 'error')
  assert.match(telemetry.error, /terminated|reset|socket|closed/i)
})

test('gateway exposes private access status only to Balto origins', async (context) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'balto-remote-'))
  context.after(() => rm(stateRoot, { recursive: true, force: true }))
  await writeFile(join(stateRoot, 'state.json'), JSON.stringify({
    tailscaleInstalled: true,
    tailscaleSignedIn: true,
    tailscaleDnsName: 'tower.example.ts.net',
    remoteEnabled: true,
    remoteUrl: 'https://tower.example.ts.net:3080',
  }))

  const portProbe = http.createServer()
  const gatewayPort = await listen(portProbe)
  await new Promise((resolve) => portProbe.close(resolve))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/gateway.mjs', import.meta.url))], {
    env: { ...process.env, BALTO_GATEWAY_PORT: String(gatewayPort), BALTO_DATA: stateRoot },
    stdio: 'ignore',
  })
  context.after(() => child.kill())
  await waitFor(`http://127.0.0.1:${gatewayPort}/remote`)

  const allowed = await fetch(`http://127.0.0.1:${gatewayPort}/remote`, {
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
  const status = await allowed.json()
  assert.equal(status.remoteEnabled, true)
  assert.equal(status.remoteUrl, 'https://tower.example.ts.net:3080')

  const rejected = await fetch(`http://127.0.0.1:${gatewayPort}/remote`, {
    headers: { origin: 'https://example.com' },
  })
  assert.equal(rejected.status, 403)
})
