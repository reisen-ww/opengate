/**
 * Reasoning-effort mapping between the runtime's OpenCode variants and the
 * OpenAI `reasoning_effort` values the Harness sends.
 *
 * @module dsh-opencode-xdbridge/reasoning
 */

/** OpenAI effort names, weakest first. */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Map OpenAI effort names onto this model's real OpenCode variants.
 *
 * Only variants the runtime actually advertises are exposed, so a level the
 * model cannot honour is never offered to the client.
 *
 * @returns {Record<string, string>} effort name -> variant name
 */
export function reasoningEfforts(model) {
  if (!model.reasoning) return {}
  return Object.fromEntries(
    Object.entries(model.variants ?? {})
      .filter(([, options]) => !options.disabled && EFFORT_LEVELS.includes(options.reasoningEffort))
      .map(([variant, options]) => [options.reasoningEffort, variant]),
  )
}
