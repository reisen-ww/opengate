/**
 * The one place that decides what a model is called on the wire.
 *
 * Both the request path (matching a client-sent id back to a catalog entry) and
 * the listing path (publishing ids) must agree, so the rule lives here rather
 * than being restated in each module.
 *
 * @module dsh-opencode-xdbridge/model-id
 */

/**
 * Client-facing model id.
 *
 * Kept stable and provider-scoped so a model saved in the picker keeps working
 * across restarts.
 */
export function clientModelID(model) {
  return `OC · ${model.name}`
}

/**
 * True when a client-sent model id refers to this catalog entry.
 *
 * Accepts the display id, the raw runtime id and the bare name, because a
 * client may echo back any of the three depending on where it read the list.
 */
export function matchesModelId(model, requested) {
  return requested === model.id
    || requested === model.name
    || requested === clientModelID(model)
}
