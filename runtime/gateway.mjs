import http from 'node:http'
import { performance } from 'node:perf_hooks'

const host = '127.0.0.1'
const port = Number(process.env.BALTO_GATEWAY_PORT || 30100)
const upstream = new URL(process.env.BALTO_INFERENCE_URL || 'http://127.0.0.1:30000')
const servedModel = 'qwen3.8-27b-nvfp4-dspark'

const speed = {
  state: 'idle',
  tokensPerSecond: 0,
  completionTokens: 0,
  elapsedSeconds: 0,
  updatedAt: new Date().toISOString(),
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function tuneRequest(buffer, path) {
  if (!path.endsWith('/chat/completions')) return buffer
  const body = JSON.parse(buffer.toString('utf8'))
  body.model = servedModel
  body.messages = body.messages?.map((message) =>
    message?.role === 'developer' ? { ...message, role: 'system' } : message,
  )
  body.temperature ??= 0.6
  body.top_p ??= 0.95
  body.top_k ??= 20
  body.seed ??= 0
  const requestedMaxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 32768)
  body.max_tokens = Math.min(requestedMaxTokens, 32768)
  delete body.max_completion_tokens
  if (body.stream) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true, continuous_usage_stats: true }
  }
  return Buffer.from(JSON.stringify(body))
}

function updateSpeedFromEvent(line, requestState) {
  if (!line.startsWith('data:')) return
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return
  try {
    const event = JSON.parse(payload)
    const completionTokens = Number(event?.usage?.completion_tokens || 0)
    if (completionTokens <= 0) return
    const now = performance.now()
    if (!requestState.firstTokenAt) requestState.firstTokenAt = now
    const elapsedSeconds = Math.max((now - requestState.firstTokenAt) / 1000, 0.001)
    if (completionTokens < 4 || elapsedSeconds < 0.02) return
    const measuredTokens = Math.max(completionTokens - 1, 1)
    speed.state = 'live'
    speed.completionTokens = completionTokens
    speed.elapsedSeconds = elapsedSeconds
    speed.tokensPerSecond = measuredTokens / elapsedSeconds
    speed.updatedAt = new Date().toISOString()
  } catch {
    // Non-JSON SSE lines are passed through untouched.
  }
}

async function proxy(request, response) {
  const target = new URL(request.url, upstream)
  let body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request)
  try {
    if (body?.length) body = tuneRequest(body, target.pathname)
  } catch (error) {
    json(response, 400, { error: { message: `Invalid JSON request: ${error.message}` } })
    return
  }

  const headers = { ...request.headers }
  for (const name of [
    'host',
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'expect',
    'content-length',
  ]) delete headers[name]
  headers.authorization = headers.authorization || 'Bearer local-balto'
  if (body) headers['content-length'] = String(body.length)

  let upstreamResponse
  try {
    upstreamResponse = await fetch(target, { method: request.method, headers, body, duplex: body ? 'half' : undefined })
  } catch (error) {
    const detail = error.cause?.message || error.message
    json(response, 502, { error: { message: `Balto inference is unavailable: ${detail}` } })
    return
  }

  const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries())
  responseHeaders['access-control-allow-origin'] = '*'
  responseHeaders['access-control-allow-headers'] = '*'
  delete responseHeaders['content-length']
  response.writeHead(upstreamResponse.status, responseHeaders)

  if (!upstreamResponse.body) {
    response.end()
    return
  }

  const isStream = (upstreamResponse.headers.get('content-type') || '').includes('text/event-stream')
  if (!isStream) {
    const output = Buffer.from(await upstreamResponse.arrayBuffer())
    response.end(output)
    return
  }

  speed.state = 'starting'
  speed.tokensPerSecond = 0
  speed.completionTokens = 0
  speed.elapsedSeconds = 0
  speed.updatedAt = new Date().toISOString()
  const requestState = { firstTokenAt: 0, pending: '' }
  const reader = upstreamResponse.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      response.write(chunk)
      requestState.pending += chunk.toString('utf8')
      const lines = requestState.pending.split(/\r?\n/)
      requestState.pending = lines.pop() || ''
      for (const line of lines) updateSpeedFromEvent(line, requestState)
    }
  } finally {
    speed.state = 'complete'
    speed.updatedAt = new Date().toISOString()
    response.end()
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    response.end()
    return
  }
  if (request.url === '/speed') {
    json(response, 200, speed)
    return
  }
  if (request.url === '/health') {
    try {
      const check = await fetch(new URL('/health', upstream), { signal: AbortSignal.timeout(1500) })
      json(response, check.ok ? 200 : 503, { ok: check.ok, upstream: upstream.toString() })
    } catch (error) {
      json(response, 503, { ok: false, error: error.message })
    }
    return
  }
  await proxy(request, response)
})

server.listen(port, host, () => {
  console.log(`Balto gateway listening at http://${host}:${port}`)
})
