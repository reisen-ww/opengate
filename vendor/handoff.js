/**
 * Hand a blocked native action over to the external client.
 *
 * The runtime is configured to *ask* before any native operation (that policy
 * is what keeps the free-tier gate open). When a model tries to act locally
 * anyway, the bridge refuses the native call and — where the external tool
 * schema allows it — returns that same action as an external tool call instead.
 * Restating the action is exactly the step models fail at, and it costs a full
 * extra upstream turn, so mapping it here is both cheaper and more reliable.
 *
 * The external tool list sent with each request is the authority: only keys
 * that exist in the target schema are filled, and every required key must be
 * satisfiable, otherwise no handoff is produced and the model gets corrective
 * feedback instead.
 *
 * @module dsh-opencode-xdbridge/handoff
 */

import { BridgeError } from './protocol.js'

/** Native action categories and the external tool names they may map onto. */
const CATEGORIES = [
  {
    native: ['bash', 'shell'],
    targets: ['Bash', 'PowerShell'],
    fields: { command: 'command', description: 'description', timeout: 'timeout' },
  },
  {
    native: ['read'],
    targets: ['Read'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', offset: 'offset', limit: 'limit' },
  },
  {
    native: ['write'],
    targets: ['Write'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', content: 'content' },
  },
  {
    native: ['edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'],
    targets: ['Edit', 'MultiEdit'],
    fields: {
      filePath: 'file_path', file_path: 'file_path', path: 'file_path',
      oldString: 'old_string', old_string: 'old_string',
      newString: 'new_string', new_string: 'new_string',
      replaceAll: 'replace_all', replace_all: 'replace_all', edits: 'edits',
    },
  },
  {
    native: ['glob'],
    targets: ['Glob', 'LS'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' },
  },
  {
    native: ['grep'],
    targets: ['Grep', 'Search'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include', output_mode: 'output_mode' },
  },
  {
    native: ['skill'],
    targets: ['Skill'],
    fields: {
      name: ['name', 'skill'], skill: ['skill', 'name'],
      args: ['args', 'arguments'], arguments: ['arguments', 'args'],
    },
  },
]

/**
 * Map a blocked native action onto an external tool call.
 *
 * @returns {{name: string, arguments: Record<string, unknown>}|null} the external
 *   call, or null when the offered tool schemas cannot express this action.
 */
export function buildHandoff({ native, input = {}, tools = [] }) {
  const name = String(native ?? '').toLowerCase()
  const category = CATEGORIES.find(entry => entry.native.includes(name))
  if (!category) return null

  for (const target of category.targets) {
    const spec = tools.map(tool => tool?.function).find(fn => fn?.name?.toLowerCase() === target.toLowerCase())
    const properties = spec?.parameters?.properties
    if (!properties) continue

    const args = {}
    for (const [key, value] of Object.entries(input)) {
      const candidates = category.fields[key]
      if (!candidates || value === undefined) continue
      // A field may have several acceptable target names: external tools
      // disagree on spelling, and the schema decides which one is real.
      for (const mapped of Array.isArray(candidates) ? candidates : [candidates]) {
        if (args[mapped] !== undefined || !Object.hasOwn(properties, mapped)) continue
        args[mapped] = value
        break
      }
    }

    const required = Array.isArray(spec.parameters.required) ? spec.parameters.required : []
    if (Object.keys(args).length === 0) continue
    if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue
    return { name: spec.name, arguments: args }
  }
  return null
}

/**
 * Merge the arguments reported by the runtime with the approval metadata.
 *
 * While a call is still pending, OpenCode reports its arguments through the
 * approval metadata rather than the tool part, whose input stays empty until the
 * call runs. The tool part wins when it has them; the metadata fills the gaps.
 */
export function handoffInput(action, permission) {
  const input = { ...(action?.input ?? {}) }
  const metadata = permission?.metadata ?? {}
  const fallback = {
    command: metadata.command,
    filePath: metadata.filepath ?? metadata.filePath ?? metadata.path,
    pattern: metadata.pattern ?? (Array.isArray(metadata.patterns) ? metadata.patterns[0] : undefined),
  }
  for (const [key, value] of Object.entries(fallback)) {
    if (input[key] === undefined && typeof value === 'string' && value.trim()) input[key] = value
  }
  return input
}

/**
 * Feedback for a native action that could not be handed over.
 *
 * Naming the tool and the reason matters: a silent or generic refusal is what
 * makes a model retry the same native call over and over.
 */
export function rejectFeedback(native, reason) {
  return `Native tool "${native}" was blocked: ${reason}. Native execution is forbidden; the external client owns execution. `
    + 'Return the requested external action inside the calls array using StructuredOutput. The external client will execute it and supply results. Do not call any other native tools.'
}

/**
 * Validate a translated action against the receiver's own schema.
 *
 * A translation is not trusted: the same rules that govern the static table
 * apply here, so a translation can never widen what may be executed.
 */
export function validateAction(candidate, tools = []) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new BridgeError('翻译后的动作不是对象', 502, 'invalid_tool_call')
  }
  const spec = tools.map(tool => tool?.function)
    .find(fn => fn?.name && fn.name.toLowerCase() === String(candidate.name ?? '').toLowerCase())
  if (!spec) throw new BridgeError('翻译后的动作使用了接收方未提供的工具', 502, 'invalid_tool_call')

  const args = candidate.arguments ?? {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new BridgeError('翻译后的动作参数不是对象', 502, 'invalid_tool_call')
  }
  const properties = spec.parameters?.properties ?? {}
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      throw new BridgeError(`翻译后的动作设置了接收方未声明的参数：${key}`, 502, 'invalid_tool_call')
    }
  }
  const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : []
  if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== '')) {
    throw new BridgeError('翻译后的动作缺少必需参数', 502, 'invalid_tool_call')
  }
  return { name: spec.name, arguments: args }
}
