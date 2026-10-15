/**
 * The backend: one inference turn against the isolated OpenCode runtime.
 *
 * Responsibilities:
 *  - open a runtime session bound to the approval-gated agent,
 *  - send the external conversation and ask for a JSON envelope,
 *  - intercept every native approval, refusing it and handing the action to the
 *    external client when the offered tool schema can express it,
 *  - validate the envelope before it can become an executed action,
 *  - correct a malformed envelope once before giving up.
 *
 * The permission monitor is not optional. The runtime is configured with
 * `permission: ask` because that policy is what keeps OpenCode Zen's free tier
 * open; the monitor is what makes sure nothing is ever actually approved.
 *
 * @module dsh-opencode-xdbridge/backend
 */

import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BridgeError, decode, completion } from './protocol.js'
import { buildHandoff, handoffInput, rejectFeedback } from './handoff.js'
export { clientModelID } from './model-id.js'

/** Provider id the runtime exposes its free models under. */
const RUNTIME_PROVIDER = 'opencode'

/** Cap on retained approval payloads, which may embed file content. */
const PERMISSION_SAMPLE_LIMIT = 5

/**
 * Permission policy — the single source of truth for both places that need it.
 *
 * Every native operation is *asked* and then refused by the bridge, which is
 * what lets the runtime look like an ordinary OpenCode session upstream while
 * still executing nothing locally. The explicit denies are defence in depth:
 * they stop the request before it ever reaches the approval round-trip.
 *
 * It is applied twice — as the runtime-wide `permission` in
 * OPENCODE_CONFIG_CONTENT and per session at creation. Those two copies
 * previously drifted apart; keeping one exported constant is what stops that.
 *
 * Note (2026-10-15): denies do NOT trip the free-tier gate. The gate is keyed
 * on the Zen credential, not on permissions or TLS fingerprint — see
 * delegate.mjs `#seedAuth`.
 */
export const SESSION_PERMISSION_POLICY = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
}

/** The policy above in the array shape `POST /session` expects. */
export function sessionPermissions() {
  return Object.entries(SESSION_PERMISSION_POLICY).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }))
}

/** Bound long strings inside a retained approval payload. */
export function shrinkPermission(value, limit = 400) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)]))
  }
  return value
}

/** Tools a request may use: none when the client asked for none. */
export function allowedTools(request) {
  if (request.choice === 'none') return []
  return request.forced ? request.tools.filter(t => t.function.name === request.forced) : request.tools
}

/**
 * The free models the runtime advertises.
 *
 * "Free" is decided by the runtime's own catalog: a model counts only when
 * every cost dimension is zero. Anything the runtime cannot price at zero is
 * not offered, so this plugin can never quietly spend the user's credits.
 */
export function freeModels(providers) {
  const provider = providers.all?.find(p => p.id === RUNTIME_PROVIDER)
  if (!provider) throw new Error('运行时未提供 opencode provider')
  return Object.entries(provider.models)
    .filter(([, model]) => {
      const cost = model.cost
      return cost && cost.input === 0 && cost.output === 0
        && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0
        && model.capabilities?.output?.text !== false
        && model.status !== 'deprecated'
    })
    .map(([id, model]) => ({
      id: `${RUNTIME_PROVIDER}/${id}`,
      name: model.name || id,
      context: model.limit?.context,
      input: model.limit?.input,
      images: model.capabilities?.input?.image === true,
      output: model.limit?.output,
      toolcall: model.capabilities?.toolcall === true,
      reasoning: model.capabilities?.reasoning === true,
      variants: model.variants ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Client-facing model id, re-exported so callers need only one import. */
export class Backend {
  constructor(base, password, timeout, log = () => {}) {
    Object.assign(this, {
      base,
      password,
      timeout,
      log,
      active: new Map(),
      events: null,
      toolParts: new Map(),
      pendingApprovals: new Map(),
      usageBySession: new Map(),
    })
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
    }
  }

  /** One JSON request against the runtime. */
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const requestSignal = timeout == null
      ? signal
      : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new BridgeError(
              `OpenCode HTTP ${response.statusCode}: ${text.slice(0, 600)}`,
              response.statusCode >= 500 ? 502 : response.statusCode,
              'upstream_error',
            ))
          }
          try { resolve(JSON.parse(text)) }
          catch { reject(new BridgeError('OpenCode 返回了非 JSON 响应', 502, 'upstream_error')) }
        })
      })
      req.on('error', reject)
      req.setTimeout(0)
      req.end(body !== undefined ? JSON.stringify(body) : undefined)
    })
  }

  /**
   * Subscribe to the runtime's event stream.
   *
   * One connection serves every in-flight request. It carries two things the
   * request/response path does not: the tool part behind a blocked approval, and
   * the runtime's own upstream retry state.
   */
  watchEvents() {
    if (this.events) return
    const controller = new AbortController()
    this.events = controller
    ;(async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal) }
        catch (error) {
          if (controller.signal.aborted) return
          this.log(`Event stream error: ${error.message}`)
        }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {})
      }
    })().catch(() => {})
  }

  stopEvents() {
    this.events?.abort()
    this.events = null
  }

  streamEvents(signal) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + '/event', {
        method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' },
      }, response => {
        if (response.statusCode !== 200) {
          response.resume()
          return reject(new BridgeError(`事件流 HTTP ${response.statusCode}`, 502, 'event_stream_error'))
        }
        let buffer = ''
        response.on('data', chunk => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            try { this.handleEvent(JSON.parse(line.slice(5).trim())) } catch { /* ignore malformed frame */ }
          }
        })
        response.on('error', reject)
        response.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
  }

  handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper
    if (['permission.asked', 'permission.updated'].includes(event?.type) && event.properties?.id) {
      this.pendingApprovals.set(event.properties.id, event.properties)
    }
    if (event?.type === 'permission.replied') this.pendingApprovals.delete(event.properties?.requestID)

    // The tool part carries the name and arguments of a call an approval gate
    // blocked. It arrives here before the approval, and the HTTP listing of
    // messages does not include it.
    const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined
    if (part?.type === 'tool' && part.callID) {
      this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} })
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value)
    }

    const info = event?.type === 'message.updated' ? event.properties?.info : undefined
    if (info?.role === 'assistant' && info.tokens && this.usageBySession.has(info.sessionID)) {
      this.usageBySession.set(info.sessionID, info.tokens)
    }

    const sessionID = event?.properties?.sessionID
    const meta = sessionID ? this.active.get(sessionID) : undefined
    if (!meta || typeof meta.activity !== 'function') return
    const progress = { sessionID, model: meta.model, type: event.type, at: Date.now() }
    const status = event.properties?.status
    if (event.type === 'session.status' && status) {
      if (status.type === 'retry' || (status.type === 'busy' && (!meta.stage || meta.stage === 'retry'))) {
        progress.status = status.type === 'busy' ? 'waiting' : 'retry'
      }
      if (status.type === 'retry') {
        Object.assign(progress, { attempt: status.attempt, message: status.message, next: status.next })
      }
    }
    if (event.type === 'session.error') {
      progress.error = event.properties?.error?.data?.message || event.properties?.error?.name || '上游错误'
    }
    if (part && ['text', 'reasoning'].includes(part.type) && part.text) {
      progress.content = true
      progress.status = part.type === 'reasoning' ? 'reasoning' : 'receiving'
    }
    if (event.type === 'message.part.delta' && event.properties?.delta) {
      progress.content = true
      progress.status = 'receiving'
    }
    if (['permission.asked', 'permission.updated'].includes(event.type)) progress.status = 'permission'
    if (progress.status) meta.stage = progress.status
    meta.activity(progress)
  }

  progress(meta, status, extra = {}) {
    meta.stage = status
    meta.activity?.({ sessionID: meta.sessionID, model: meta.model, type: 'bridge.phase', status, ...extra })
  }

  async reject(permission, message, signal) {
    const result = await this.request(
      `/permission/${encodeURIComponent(permission.id)}/reply`,
      'POST', { reply: 'reject', message }, signal, 5000,
    )
    this.pendingApprovals.delete(permission.id)
    return result
  }

  /**
   * Read back the native action behind a blocked call.
   *
   * The name arrives on the event stream; the arguments may still be empty while
   * the part is pending, so a few short waits are worth it before giving up.
   */
  async blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID)
      if (part?.tool) return part
      await delay(120, undefined, { signal, ref: false }).catch(() => {})
    }
    return { failure: '没有事件携带这个 call ID' }
  }

  async pendingPermissions(sessionID, signal) {
    const cached = () => [...this.pendingApprovals.values()].filter(p => p.sessionID === sessionID)
    let pending
    try {
      pending = await this.request('/permission', 'GET', undefined, signal, 5000)
    } catch (error) {
      if (!signal?.aborted) this.log(`Permission monitor query failed: ${error.code || error.name}: ${error.message}`)
      return cached()
    }
    if (!Array.isArray(pending)) {
      this.log('Permission monitor query failed: non-array response')
      return cached()
    }
    return pending.filter(p => p.sessionID === sessionID)
  }

  async handoffUsage(sessionID, signal) {
    try {
      const messages = await this.request(
        `/session/${encodeURIComponent(sessionID)}/message?limit=1`, 'GET', undefined, signal, 5000,
      )
      const info = Array.isArray(messages) ? messages.findLast(m => m.info?.role === 'assistant')?.info : undefined
      if (info?.tokens) return info.tokens
    } catch (error) {
      if (!signal?.aborted) this.log(`Usage lookup failed: ${error.code || error.name}`)
    }
    return this.usageBySession.get(sessionID)
  }

  /**
   * Refuse one native approval, or hand the action to the external client.
   *
   * @returns {{handoff: {name: string, arguments: object}}|null}
   */
  async handlePermission(permission, request, signal, rejected, meta) {
    const callID = permission.tool?.callID
    if (callID && rejected.has(callID)) return null
    if (callID) rejected.add(callID)
    meta.nativeAttempts += 1
    // Keep the approval request verbatim: OpenCode's field names differ from the
    // SDK types, so cherry-picking fields silently loses the useful ones.
    if (meta.permissions.length < PERMISSION_SAMPLE_LIMIT) meta.permissions.push(shrinkPermission(permission))

    const action = callID ? await this.blockedAction(callID, signal) : null
    const native = action?.tool ?? (permission.metadata?.command ? 'bash' : null)
    const handoff = native
      ? buildHandoff({ native, input: handoffInput(action, permission), tools: allowedTools(request) })
      : null

    if (handoff) {
      this.progress(meta, 'handoff')
      await this.reject(permission, 'This native action is executed by the external client instead.', signal).catch(() => {})
      return { handoff }
    }

    const reason = !callID
      ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action
        ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session'
    const label = native || (permission.metadata?.filepath ? `a file operation on ${permission.metadata.filepath}` : permission.permission || 'native tool')
    // A permission may already be gone (session aborted, duplicate reply):
    // never let that failing reply take the whole request down with it.
    await this.reject(permission, rejectFeedback(label, reason), signal).catch(() => {})
    return null
  }

  /** Read the runtime's free-model catalog. */
  async models() {
    const result = freeModels(await this.request('/provider'))
    if (result.length === 0) throw new Error('未找到免费模型，保留现有列表')
    return result
  }

  /**
   * Run one inference turn.
   *
   * @returns {Promise<object>} an OpenAI chat.completion
   */
  async complete(request, signal, meta = {}) {
    meta.steps = 0
    meta.nativeAttempts = 0
    meta.permissions = []

    const session = await this.request('/session', 'POST', {
      title: 'DSH OpenCode Bridge',
      // 单一真相源：与 runtime.js 注入的 OPENCODE_CONFIG_CONTENT 用同一份策略。
      // 上游门禁对 deny 敏感，两份手抄副本曾经不同步（此处仍带 deny 而
      // runtime.js 已改成全 ask），导致建 session 时立刻 403。
      permission: sessionPermissions(),
    }, signal)

    const route = `/session/${encodeURIComponent(session.id)}`
    meta.sessionID = session.id
    this.usageBySession.set(session.id, undefined)
    if (typeof meta.activity === 'function') this.active.set(session.id, meta)
    this.watchEvents()
    this.progress(meta, 'waiting')

    const guard = new AbortController()
    const rejected = new Set()
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])])

    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(session.id, guardSignal)
        // A failed poll never grants approval: native actions stay waiting.
        for (const permission of pending ?? []) {
          if (request.chatOnly) {
            throw new BridgeError('仅对话模型尝试调用本地工具，已阻止执行', 502, 'native_tool_activity')
          }
          const result = await this.handlePermission(permission, request, guardSignal, rejected, meta)
          if (result?.handoff) return result
        }
        await delay(250, undefined, { signal: guardSignal })
      }
    })()

    let successful = false
    try {
      const tools = allowedTools(request)
      const callsSchema = {
        type: 'array',
        ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length
          ? {
            items: {
              anyOf: tools.map(({ function: tool }) => ({
                type: 'object',
                properties: {
                  name: { type: 'string', const: tool.name },
                  arguments: tool.parameters || { type: 'object' },
                },
                required: ['name', 'arguments'],
                additionalProperties: false,
              })),
            },
          }
          : { maxItems: 0, items: { type: 'object' } }),
      }

      const payload = {
        model: { providerID: RUNTIME_PROVIDER, modelID: request.model.id.slice(`${RUNTIME_PROVIDER}/`.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge',
        system: request.chatOnly
          ? request.system
          : `${request.system}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`,
        ...(request.chatOnly
          ? {}
          : {
            format: {
              type: 'json_schema',
              retryCount: 0,
              schema: {
                type: 'object',
                properties: { content: { type: 'string' }, calls: callsSchema },
                required: ['content', 'calls'],
                additionalProperties: false,
              },
            },
          }),
        parts: [{ type: 'text', text: request.text }, ...(request.images ?? [])],
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        meta.steps += 1
        this.progress(meta, attempt ? 'correcting' : 'waiting')
        this.usageBySession.set(session.id, undefined)

        const response = await Promise.race([
          watch,
          this.request(`${route}/message`, 'POST', payload, signal, null),
        ])
        this.progress(meta, 'checking')

        let handoff = response?.handoff ?? null
        if (!handoff) {
          // Close the race: an approval raised just before the response landed
          // must still be refused or handed over.
          const late = await this.pendingPermissions(session.id, guardSignal)
          for (const permission of late ?? []) {
            if (request.chatOnly && permission.tool) {
              throw new BridgeError('仅对话模型尝试调用本地工具，已阻止执行', 502, 'native_tool_activity')
            }
            const result = await this.handlePermission(permission, request, guardSignal, rejected, meta)
            if (result?.handoff) { handoff = result.handoff; break }
          }
        }

        // A handed-over action becomes the model's answer; no extra upstream turn.
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {})
          meta.calls = 1
          meta.handoff = handoff.name
          successful = true
          return completion(request.model.id, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call_${randomUUID().replaceAll('-', '')}`,
              type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) },
            }],
          }, await this.handoffUsage(session.id, signal))
        }

        if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
          const error = response.info.error
          throw new BridgeError(
            error.data?.message || error.message || error.name || '模型请求失败',
            error.data?.statusCode || 502,
            'model_error',
          )
        }

        // 'invalid' marks a call whose arguments failed to parse: nothing ran, so
        // it belongs to the format path, not to native activity.
        if (response.parts?.some(p => p.type === 'tool'
          && (request.chatOnly || !['StructuredOutput', 'invalid'].includes(p.tool))
          && !(rejected.has(p.callID) && p.state?.status === 'error'))) {
          throw new BridgeError('检测到意外的本地工具活动，已拒绝该响应', 502, 'native_tool_activity')
        }

        // The envelope arrives one of three ways: the runtime's structured field,
        // a completed StructuredOutput call, or plain text.
        const structuredPart = (response.parts || []).find(
          p => p.type === 'tool' && p.tool === 'StructuredOutput' && p.state?.status === 'completed' && p.state?.input,
        )
        const envelope = response.info?.structured ?? structuredPart?.state?.input
        const text = envelope !== undefined
          ? JSON.stringify(envelope)
          : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('')

        let message
        try {
          if (response.info?.finish === 'length') {
            throw new BridgeError('模型输出被截断', 502, 'output_truncated')
          }
          if (!text.trim()) {
            const unparsed = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'invalid')
            if (request.chatOnly) throw new BridgeError('模型没有返回文本', 502, 'empty_response')
            throw new BridgeError(
              unparsed
                ? `模型提交的调用参数不是合法 JSON：${unparsed.state?.input?.error ?? '运行时未给出细节'}`
                : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本三者都为空',
              502, 'invalid_model_output',
            )
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request)
        } catch (error) {
          // One bounded correction, only ever on a path that already failed.
          if (request.chatOnly || signal?.aborted
            || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(error.code)) {
            throw error
          }
          if (attempt === 0) {
            const cut = error.code === 'output_truncated'
            payload.parts = [{
              type: 'text',
              text: cut
                ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
                : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.',
            }]
            continue
          }
          throw error
        }

        meta.calls = message.tool_calls?.length ?? 0
        successful = true
        return completion(request.model.id, message, response.info?.tokens)
      }
    } finally {
      guard.abort()
      await watch.catch(() => {})
      this.usageBySession.delete(session.id)
      if (this.usageBySession.size === 0) this.stopEvents()
      for (const [id, permission] of this.pendingApprovals) {
        if (permission.sessionID === session.id) this.pendingApprovals.delete(id)
      }
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID: session.id, model: meta.model, type: 'request.done' })
        this.active.delete(session.id)
      }
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) {
        await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {})
      }
      await this.request(route, 'DELETE', undefined, undefined, 5000)
        .catch(error => this.log(`Session cleanup failed: ${error.code || error.name}`))
    }
  }
}
