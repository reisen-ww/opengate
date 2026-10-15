/**
 * Loopback OpenAI-compatible endpoint backed by the isolated OpenCode runtime.
 *
 * pi-ai's provider points here. The endpoint is bound to 127.0.0.1 on an
 * ephemeral port and guarded by a per-process random secret, so no other local
 * process — and no browser page — can drive the runtime through it.
 *
 * The security model (loopback Host/Origin checks, constant-time bearer
 * comparison, ephemeral port, in-process secret, body cap) follows the
 * conventions already established by other loopback-backed Harness providers.
 *
 * @module dsh-opencode-xdbridge/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { prepare, sendSSE, BridgeError } from './protocol.js'
import { clientModelID } from './backend.js'

/** Requests larger than this are refused before parsing. */
const REQUEST_BODY_LIMIT = 8 * 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host must name loopback; this drops DNS-rebinding attempts before routing. */
function hostIsLoopback(host) {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin) {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function errorBody(message, type, code) {
  return { error: { message, type: type || 'invalid_request_error', ...(code ? { code } : {}) } }
}

/** Constant-time bearer comparison. */
function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${key}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > REQUEST_BODY_LIMIT) throw new BridgeError('请求体超过 8 MB', 413, 'payload_too_large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) }
  catch { throw new BridgeError('请求体不是合法 JSON', 400, 'invalid_json') }
}

/**
 * Start the loopback endpoint.
 *
 * @param {object} options
 * @param {(request: any, signal: AbortSignal, meta: object) => Promise<object>} options.complete
 * @param {() => Array<any>} options.getModels
 * @param {() => Promise<any>} [options.refresh]
 * @returns {Promise<{baseUrl: () => string, token: () => string, close: () => Promise<void>, server: import('node:http').Server}>}
 */
export async function createShim({ complete, getModels, refresh, logger = {} }) {
  const key = randomBytes(32).toString('hex')
  let origin

  const server = createServer(async (req, res) => {
    try {
      // Browser pages must never reach this endpoint, even from loopback.
      if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
        return writeJson(res, 403, errorBody('仅允许本机回环访问', 'permission_error'))
      }
      if (!authorized(req, key)) {
        return writeJson(res, 401, errorBody('需要本地代理 API key', 'authentication_error'))
      }

      const route = new URL(req.url, 'http://127.0.0.1').pathname

      if (req.method === 'GET' && route === '/health') {
        return writeJson(res, 200, { ok: true, models: getModels().length })
      }
      if (req.method === 'GET' && route === '/v1/models') {
        // The wire id is the provider-scoped id the adapter sends, so a client
        // that lists models here can call one back without translation.
        return writeJson(res, 200, {
          object: 'list',
          data: getModels().map(model => ({
            id: model.id,
            object: 'model',
            owned_by: 'opencode',
            name: clientModelID(model),
          })),
        })
      }
      if (req.method === 'POST' && route === '/admin/refresh') {
        await refresh?.()
        return writeJson(res, 200, { ok: true, models: getModels().length })
      }
      if (req.method !== 'POST' || route !== '/v1/chat/completions') {
        return writeJson(res, 404, errorBody('未找到该路径', 'not_found'))
      }

      const body = await readBody(req)
      const request = prepare(body, getModels())

      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort() })

      let heartbeat
      let streamStart
      const meta = {
        tools: request.tools.length,
        model: request.model.id,
        // Only a streaming response may write bytes early. On a non-streaming
        // request any write here would send the headers (and chunked encoding)
        // before the JSON body exists, which then fails with
        // ERR_HTTP_HEADERS_SENT when the real response is written.
        activity: body.stream
          ? progress => {
            if (progress.content === true && !streamStart && !controller.signal.aborted
              && !res.destroyed && !res.writableEnded) {
              // Emit the assistant role as soon as real content exists, so the
              // client can leave its "waiting" state without seeing partial output.
              streamStart = { id: `chatcmpl-${randomBytes(16).toString('hex')}`, created: Math.floor(Date.now() / 1000) }
              res.write(`data: ${JSON.stringify({
                ...streamStart,
                object: 'chat.completion.chunk',
                model: body.model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              })}\n\n`)
            }
          }
          : undefined,
      }

      try {
        if (body.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(': validating model response before emission\n\n')
          heartbeat = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': waiting\n\n')
          }, 10000)
          heartbeat.unref?.()
        }

        const result = await complete(request, controller.signal, meta)
        if (controller.signal.aborted) return
        result.model = body.model

        if (body.stream) {
          if (streamStart) Object.assign(result, streamStart)
          sendSSE(res, result, body.stream_options?.include_usage, Boolean(streamStart))
        } else {
          writeJson(res, 200, result)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error.name === 'TimeoutError' ? '模型请求超时' : error.message
        logger.warn?.(`dsh-opencode-xdbridge: request failed: ${error.code || error.name}: ${message}`)
        const payload = { message, type: error.code || 'upstream_error', code: error.code || 'upstream_error' }
        if (res.headersSent) res.end(`data: ${JSON.stringify({ error: payload })}\n\n`)
        else writeJson(res, error.status || 502, { error: payload })
      } finally {
        if (heartbeat) clearInterval(heartbeat)
      }
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      // A BridgeError raised before dispatch is a client mistake (bad model id,
      // bad payload) and is reported as such. Anything else is a real fault.
      if (error instanceof BridgeError) {
        writeJson(res, error.status || 400, errorBody(error.message, 'invalid_request_error', error.code))
        return
      }
      logger.error?.('dsh-opencode-xdbridge: shim failure', error)
      writeJson(res, error?.status || 500, errorBody(`内部错误：${error?.message ?? error}`, 'internal_error'))
    }
  })

  // Long inference turns must not be cut off by a socket-level timeout.
  server.requestTimeout = 0
  server.headersTimeout = 30000
  server.keepAliveTimeout = 72000

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  return {
    server,
    baseUrl: () => origin,
    token: () => key,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
