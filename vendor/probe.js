/**
 * Model detection.
 *
 * A detection run must approximate real traffic: a model that answers with text
 * and proposes no action is a model the Harness cannot use for tool work, and
 * finding that out here is much cheaper than finding it out mid-task.
 *
 * The probe therefore offers several tools and lets the model choose, then
 * checks that the action it returned actually matches what was asked.
 *
 * @module dsh-opencode-xdbridge/probe
 */

import { randomBytes } from 'node:crypto'
import { BridgeError } from './protocol.js'

/**
 * Budget for one detection run, retries included.
 *
 * Kept for callers that want a whole-model ceiling; the per-attempt budget
 * ({@link PROBE_ATTEMPT_TIMEOUT_MS}) is what each try actually gets.
 */
export const PROBE_TIMEOUT = 60_000

/**
 * Tools offered to the model during detection.
 *
 * Deliberately a realistic mixed set rather than one forced tool: with a single
 * forced tool the probe would only validate transport and format, and would
 * pass a model that cannot actually choose an action.
 */
export const PROBE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the external working directory.',
      parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path of the file to read' } }, required: ['file_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a file in the external working directory.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command on the external machine.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'List files matching a pattern.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: 'Search the web.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
]

/** Build the detection request body for one model. */
export function probeBody(model, token) {
  return {
    model: model.id,
    messages: [{ role: 'user', content: `Read /external/probe-${token}.txt and report its contents.` }],
    tools: structuredClone(PROBE_TOOLS),
    parallel_tool_calls: false,
  }
}

/**
 * Judge a detection response.
 *
 * A text-only reply is the failure this probe exists to catch, not an
 * acceptable answer. A mismatched action is a different failure again: the
 * envelope was valid but the action was wrong, and the names that came back are
 * part of the evidence.
 */
export function judgeProbe(response, token) {
  const calls = response?.choices?.[0]?.message?.tool_calls
  if (!calls?.length) {
    throw new BridgeError('模型只返回了文本，没有产生任何动作', 502, 'no_action')
  }
  let args = {}
  try { args = JSON.parse(calls[0].function?.arguments || '{}') } catch { /* judged below */ }
  if (calls.length !== 1 || calls[0].function?.name !== 'Read' || !String(args.file_path || '').includes(token)) {
    const names = calls.map(call => call?.function?.name || '未命名').join('、') || '无调用'
    throw new BridgeError(`模型返回的动作与探测请求不符（收到 ${names}）`, 502, 'probe_mismatch')
  }
  return calls[0]
}

/** Failure classes worth one retry, because they are single stochastic events. */
export const RETRYABLE_PROBE = new Set(['probe_mismatch', 'no_action'])

/**
 * Budget for ONE detection attempt.
 *
 * Per attempt, not for the whole probe. Sharing one deadline between the first
 * try and the retry starved the retry: a model that took 45 s to answer with
 * text left the second attempt almost no time, so a legitimate "chat only"
 * verdict was reported as a timeout instead.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 90_000

/** How many attempts one model gets. */
export const PROBE_ATTEMPTS = 2

/**
 * Run detection, retrying a semantic miss once.
 *
 * Each attempt owns its own deadline, so a slow first try cannot consume the
 * retry's budget. A format failure belongs to the chat-only path and is not
 * retried; a timeout is retried, because it usually reflects load rather than a
 * property of the model.
 *
 * @param {object} options
 * @param {(token: string, signal: AbortSignal) => Promise<object>} options.complete
 * @param {number} [options.attempts]
 * @param {number} [options.timeoutMs] per-attempt budget
 */
export async function probeModel({ complete, attempts = PROBE_ATTEMPTS, timeoutMs = PROBE_ATTEMPT_TIMEOUT_MS }) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const token = randomBytes(8).toString('hex')
    // A fresh controller per attempt: this is the fix for the starved retry.
    const deadline = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; deadline.abort() }, timeoutMs)
    try {
      const response = await complete(token, deadline.signal)
      judgeProbe(response, token)
      return response
    } catch (error) {
      lastError = probeFailure(error, timedOut)
      const retryable = RETRYABLE_PROBE.has(lastError.code) || lastError.code === 'timeout'
      if (attempt >= attempts - 1 || !retryable) throw lastError
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/**
 * Whether an error means the response format cannot carry tool calls at all.
 *
 * Such a model is still usable for plain conversation, so it is published with
 * tools disabled rather than being withdrawn.
 */
export function formatUnsupported(error) {
  return ['invalid_model_output', 'invalid_tool_call'].includes(error?.code)
    || /only.{0,10}auto.{0,40}supported.{0,20}tool_choice/i.test(error?.message || '')
}

/**
 * Turn a timed-out detection into the error the card should show.
 *
 * A caller's own abort can surface as a plain `AbortError` rather than the flag
 * being set, so both spellings are recognised: otherwise a timeout would be
 * recorded as an opaque generic failure.
 */
export function probeFailure(cause, timedOut) {
  const aborted = timedOut || cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR'
  if (!aborted) return cause
  const error = new BridgeError('模型探测超时', 504, 'timeout')
  error.name = 'TimeoutError'
  return error
}
