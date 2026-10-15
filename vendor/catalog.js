/**
 * The live model catalog for the bridge provider.
 *
 * The list is whatever the running OpenCode runtime currently advertises at
 * zero cost. It is refreshed on demand rather than pinned, because the free
 * roster changes as upstream rotates models in and out.
 *
 * The catalog also carries each model's last observed outcome, which is what
 * lets the settings card rank healthy models first and explain a failure
 * instead of showing a bare list.
 *
 * @module dsh-opencode-xdbridge/catalog
 */

import { clientModelID, matchesModelId } from './model-id.js'

/**
 * Coarse failure class for a message.
 *
 * Mirrors the distinctions a user can act on: a quota problem is not a broken
 * model, and a rate limit is not a permanent verdict.
 */
export function classifyFailure(message = '', status) {
  if (/insufficient[_ ]quota|quota.{0,30}(exceed|exhaust|deplet)|out of credits|额度.{0,10}(不足|用尽)/i.test(message)) return 'quota'
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) return 'rate_limit'
  // A geo restriction is an access failure the user cannot fix by retrying, but
  // it is not the same as a rejected key, so it gets its own label.
  if (/not available in your country|region.{0,20}(not|un)supported|地区.{0,10}(不支持|限制)/i.test(message)) return 'region'
  if (status === 401 || status === 403) return 'access'
  if (/timeout|timed out|超时/i.test(message)) return 'timeout'
  return 'error'
}

/**
 * Failure classes that mean "this model cannot serve you", as opposed to "we
 * could not reach it just now".
 *
 * A timeout, a rate limit or a transient server error says nothing durable
 * about a model: hiding it would take a working model away because of one slow
 * minute. Only a deterministic refusal — geo-blocked, credential rejected, out
 * of quota — justifies withdrawing it from the picker.
 */
export const BLOCKING_CATEGORIES = new Set(['region', 'access', 'quota'])

/** Whether a recorded failure should remove a model from the picker. */
export function isBlockingFailure(result) {
  return result?.ok === false && BLOCKING_CATEGORIES.has(result.category)
}

export class BridgeCatalog {
  #models = []
  #results = new Map()

  /**
   * Replace the catalog with a fresh reading from the runtime.
   *
   * Results for models that are still offered survive the refresh: a roster
   * re-read is not new evidence about a model's health, so dropping the
   * verdicts would make the card forget what it just learned.
   */
  replace(models) {
    this.#models = models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.context ?? model.input ?? 128_000,
      maxOutputTokens: model.output ?? 32_000,
      supportsImages: model.images === true,
      supportsTools: model.toolcall !== false,
      supportsReasoning: model.reasoning === true,
      // protocol.prepare() maps reasoning_effort onto model.variants and
      // decides whether an unsupported level is a hard 400. It reads a
      // `reasoning` flag, so the normalized entry has to carry it too —
      // without this every effort request was rejected as unsupported.
      reasoning: model.reasoning === true,
      supportedEfforts: Object.values(model.variants ?? {})
        .filter(options => !options?.disabled && typeof options.reasoningEffort === 'string')
        .map(options => options.reasoningEffort),
      variants: model.variants ?? {},
    }))

    const live = new Set(this.#models.map(model => model.id))
    for (const id of [...this.#results.keys()]) {
      if (!live.has(id)) this.#results.delete(id)
    }
  }

  /** Models that are currently usable, in picker order. */
  visible() {
    return this.#models.filter(model => {
      const result = this.#results.get(model.id)
      // A model with no verdict yet is offered: the free roster should not
      // appear empty just because nothing has been exercised through it.
      // A transient failure keeps it offered; only a blocking one withdraws it.
      return result === undefined || result.ok === true || !isBlockingFailure(result)
    })
  }

  /** Every model in the catalog, including ones currently marked unusable. */
  all() {
    return [...this.#models]
  }

  /** One model with its last result attached, for the card. */
  describe(modelId) {
    const model = this.find(modelId)
    if (model === undefined) return undefined
    return { ...model, lastResult: this.#results.get(model.id) }
  }

  /** Every model with its last result attached, for the card. */
  describeAll() {
    return this.#models.map(model => ({ ...model, lastResult: this.#results.get(model.id) }))
  }

  /**
   * Record the outcome of one model's last use.
   *
   * @param {string} modelId runtime id
   * @param {object} result outcome, already carrying `ok` and `source`
   */
  record(modelId, result) {
    if (!modelId) return
    const previous = this.#results.get(modelId)
    this.#results.set(modelId, {
      ...previous,
      ...result,
      time: result.time ?? Date.now(),
    })
  }

  /**
   * Counts the card's metric strip shows.
   *
   * `unusable` counts only blocking failures (geo-blocked, rejected, out of
   * quota). A transient failure — a timeout, a rate limit — is counted as
   * `flaky` instead, because the model is still offered and may well work on
   * the next try.
   */
  metrics() {
    let available = 0
    let unusable = 0
    let pending = 0
    let flaky = 0
    for (const model of this.#models) {
      const result = this.#results.get(model.id)
      if (result === undefined) pending += 1
      else if (result.ok) available += 1
      else if (isBlockingFailure(result)) unusable += 1
      else flaky += 1
    }
    return { discovered: this.#models.length, available, pending, unusable, flaky }
  }

  /** Look up one model by any id a client might send. */
  find(modelId) {
    return this.#models.find(model => matchesModelId(model, modelId))
  }

  /** The display id for one catalog entry. */
  displayID(model) {
    return clientModelID(model)
  }
}
