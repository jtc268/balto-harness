import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const host = '127.0.0.1'
const port = Number(process.env.BALTO_GATEWAY_PORT || 30100)
const upstream = new URL(process.env.BALTO_INFERENCE_URL || 'http://127.0.0.1:30000')
const servedModel = 'qwen3.8-27b-nvfp4-dspark'
const baltoData = process.env.BALTO_DATA || ''
const baltoResources = process.env.BALTO_RESOURCES || ''
const baltoAppExe = process.env.BALTO_APP_EXE || ''
const contextWindow = Number(process.env.BALTO_CONTEXT_WINDOW || 80000)
const maxStepOutputTokens = Number(process.env.BALTO_MAX_STEP_OUTPUT_TOKENS || 32768)
const contextSafetyTokens = Number(process.env.BALTO_CONTEXT_SAFETY_TOKENS || 4096)
const remoteStatePath = baltoData ? join(baltoData, 'state.json') : ''
let remoteAction = null

const speed = {
  state: 'idle',
  tokensPerSecond: 0,
  completionTokens: 0,
  elapsedSeconds: 0,
  error: null,
  maintenance: null,
  lastMaintenance: null,
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

function remoteOrigin(request) {
  const origin = request.headers.origin
  if (!origin) {
    const address = request.socket.remoteAddress || ''
    return /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(address) ? '*' : null
  }
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    if (LOCAL_REMOTE_HOSTS.has(hostname) || hostname.endsWith('.ts.net')) return origin
  } catch {}
  return null
}

const LOCAL_REMOTE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function remoteJson(request, response, status, value) {
  const allowedOrigin = remoteOrigin(request)
  if (!allowedOrigin) {
    json(response, 403, { ok: false, error: 'Remote settings are available only inside Balto' })
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  })
  response.end(body)
}

async function readRemoteStatus() {
  if (!remoteStatePath) return { available: false, remoteEnabled: false, remoteUrl: null }
  try {
    const state = JSON.parse(await readFile(remoteStatePath, 'utf8'))
    return {
      available: true,
      tailscaleInstalled: Boolean(state.tailscaleInstalled),
      tailscaleSignedIn: Boolean(state.tailscaleSignedIn),
      tailscaleDnsName: state.tailscaleDnsName || null,
      remoteEnabled: Boolean(state.remoteEnabled),
      remoteUrl: state.remoteUrl || null,
    }
  } catch (error) {
    return { available: false, remoteEnabled: false, remoteUrl: null, error: error.message }
  }
}

function runRemoteAction(enabled) {
  if (remoteAction) return remoteAction
  if (!baltoData || !baltoResources) return Promise.reject(new Error('Balto remote controls are not configured'))
  const script = join(baltoResources, 'balto.ps1')
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    enabled ? 'remote-on' : 'remote-off',
    '-BaltoData',
    baltoData,
    '-Resources',
    baltoResources,
    '-AppExe',
    baltoAppExe,
  ]
  remoteAction = new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errorOutput = ''
    child.stderr.on('data', (chunk) => {
      if (errorOutput.length < 8192) errorOutput += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(errorOutput.trim() || `Balto remote action exited with code ${code}`))
    })
  }).finally(() => {
    remoteAction = null
  })
  return remoteAction
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function contentText(value) {
  if (typeof value === 'string') return value.startsWith('data:image/') ? '[image]' : value
  if (Array.isArray(value)) return value.map(contentText).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'image' || value.type === 'image_url' || value.image_url) return '[image]'.repeat(1024)
  return Object.entries(value)
    .filter(([key]) => key !== 'image_url' && key !== 'url')
    .map(([, item]) => contentText(item))
    .join('\n')
}

function estimatePromptTokens(body) {
  const messageChars = contentText(body.messages || []).length
  const toolChars = contentText(body.tools || []).length
  return Math.ceil((messageChars + toolChars) / 2.5) + (body.messages?.length || 0) * 8 + 256
}

function requestPurpose(body) {
  const tail = contentText((body.messages || []).slice(-3)).toLowerCase()
  return tail.includes('acting as a compaction engine') ? 'compaction' : 'foreground'
}

function tuneRequest(buffer, path) {
  if (!path.endsWith('/chat/completions')) {
    return { buffer, purpose: 'foreground', estimatedPromptTokens: 0, maxTokens: 0 }
  }
  const body = JSON.parse(buffer.toString('utf8'))
  body.model = servedModel
  body.messages = body.messages?.map((message) =>
    message?.role === 'developer' ? { ...message, role: 'system' } : message,
  )
  const purpose = requestPurpose(body)
  body.temperature ??= 0.6
  body.top_p ??= 0.95
  body.top_k ??= 20
  body.seed ??= 0
  if (purpose === 'compaction') {
    body.temperature = 0
    body.top_p = 1
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false }
  }
  const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? maxStepOutputTokens)
  const requestedMaxTokens = Number.isFinite(requested) && requested > 0 ? requested : maxStepOutputTokens
  const estimatedPromptTokens = estimatePromptTokens(body)
  const availableOutputTokens = Math.max(1, contextWindow - estimatedPromptTokens - contextSafetyTokens)
  body.max_tokens = Math.max(1, Math.min(requestedMaxTokens, maxStepOutputTokens, availableOutputTokens))
  delete body.max_completion_tokens
  if (body.stream) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true, continuous_usage_stats: true }
  }
  return {
    buffer: Buffer.from(JSON.stringify(body)),
    purpose,
    estimatedPromptTokens,
    maxTokens: body.max_tokens,
  }
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
    const telemetry = requestState.telemetry
    telemetry.state = 'live'
    telemetry.completionTokens = completionTokens
    telemetry.elapsedSeconds = elapsedSeconds
    telemetry.tokensPerSecond = measuredTokens / elapsedSeconds
    telemetry.updatedAt = new Date().toISOString()
  } catch {
    // Non-JSON SSE lines are passed through untouched.
  }
}

async function proxy(request, response) {
  const target = new URL(request.url, upstream)
  const upstreamAbort = new AbortController()
  const abortUpstream = () => {
    if (!response.writableEnded) upstreamAbort.abort(new Error('Balto client disconnected'))
  }
  response.once('close', abortUpstream)
  let body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request)
  let requestMetadata = { purpose: 'foreground', estimatedPromptTokens: 0, maxTokens: 0 }
  try {
    if (body?.length) {
      const tuned = tuneRequest(body, target.pathname)
      body = tuned.buffer
      requestMetadata = tuned
    }
  } catch (error) {
    response.off('close', abortUpstream)
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
    upstreamResponse = await fetch(target, {
      method: request.method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
      signal: upstreamAbort.signal,
    })
  } catch (error) {
    response.off('close', abortUpstream)
    if (upstreamAbort.signal.aborted) return
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
    response.off('close', abortUpstream)
    response.end()
    return
  }

  const isStream = (upstreamResponse.headers.get('content-type') || '').includes('text/event-stream')
  if (!isStream) {
    try {
      const output = Buffer.from(await upstreamResponse.arrayBuffer())
      response.end(output)
    } finally {
      response.off('close', abortUpstream)
    }
    return
  }

  const isMaintenance = requestMetadata.purpose === 'compaction'
  const initialTelemetry = {
    state: isMaintenance ? 'compacting' : 'starting',
    tokensPerSecond: 0,
    completionTokens: 0,
    elapsedSeconds: 0,
    error: null,
    estimatedPromptTokens: requestMetadata.estimatedPromptTokens,
    maxTokens: requestMetadata.maxTokens,
    updatedAt: new Date().toISOString(),
  }
  if (isMaintenance) speed.maintenance = initialTelemetry
  else Object.assign(speed, initialTelemetry)
  const telemetry = isMaintenance ? speed.maintenance : speed
  speed.updatedAt = new Date().toISOString()
  const requestState = { firstTokenAt: 0, pending: '', telemetry }
  const reader = upstreamResponse.body.getReader()
  let streamError = null
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
  } catch (error) {
    streamError = error
    if (!upstreamAbort.signal.aborted) {
      const detail = error.cause?.message || error.message
      telemetry.state = 'error'
      telemetry.error = detail
      telemetry.updatedAt = new Date().toISOString()
      console.error(`Balto upstream stream interrupted: ${detail}`)
    }
  } finally {
    response.off('close', abortUpstream)
    reader.releaseLock()
    if (!streamError) {
      telemetry.state = 'complete'
      telemetry.error = null
    }
    telemetry.updatedAt = new Date().toISOString()
    if (isMaintenance) {
      speed.lastMaintenance = { ...telemetry }
      speed.maintenance = null
    }
    speed.updatedAt = new Date().toISOString()
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1')
  if (requestUrl.pathname === '/remote' && request.method === 'OPTIONS') {
    const allowedOrigin = remoteOrigin(request)
    if (!allowedOrigin) {
      json(response, 403, { ok: false })
      return
    }
    response.writeHead(204, {
      'access-control-allow-origin': allowedOrigin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'Origin',
    })
    response.end()
    return
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    response.end()
    return
  }
  if (requestUrl.pathname === '/remote' && request.method === 'GET') {
    remoteJson(request, response, 200, await readRemoteStatus())
    return
  }
  if (requestUrl.pathname === '/remote' && request.method === 'POST') {
    if (!remoteOrigin(request)) {
      remoteJson(request, response, 403, { ok: false })
      return
    }
    let enabled
    try {
      const body = JSON.parse((await readBody(request)).toString('utf8'))
      enabled = body.enabled
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
      await runRemoteAction(enabled)
      remoteJson(request, response, 200, { ok: true, ...(await readRemoteStatus()) })
    } catch (error) {
      remoteJson(request, response, 500, { ok: false, error: error.message })
    }
    return
  }
  if (request.url === '/speed') {
    json(response, 200, speed)
    return
  }
  if (request.url === '/health') {
    try {
      const check = await fetch(new URL('/v1/models', upstream), { signal: AbortSignal.timeout(1500) })
      json(response, check.ok ? 200 : 503, { ok: check.ok, upstream: upstream.toString() })
    } catch (error) {
      json(response, 503, { ok: false, error: error.message })
    }
    return
  }
  await proxy(request, response)
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    const detail = error.cause?.message || error.message
    speed.state = 'error'
    speed.error = detail
    speed.updatedAt = new Date().toISOString()
    console.error(`Balto gateway request failed: ${detail}`)
    if (!response.headersSent) {
      json(response, 502, { error: { message: `Balto request failed: ${detail}` } })
    } else if (!response.writableEnded && !response.destroyed) {
      response.end()
    }
  })
})

server.listen(port, host, () => {
  console.log(`Balto gateway listening at http://${host}:${port}`)
})
