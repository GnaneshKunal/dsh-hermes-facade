/**
 * Conversions from the facade's webui shapes to the Hermes host's wire shapes.
 *
 * @module dsh-hermes-facade/src/hermes/shapes
 */

import { PROFILE_NAME } from './protocol.mjs'

/**
 * One session row for GET /api/sessions and session.list.
 * @param {object} item facade session row.
 * @returns {object} Hermes session row.
 */
export function sessionRowOf(item) {
  const id = String(item?.session_id ?? item?.sessionId ?? '')
  return {
    id,
    source: 'gui',
    ...(typeof item?.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
    ...(typeof item?.preview === 'string' && item.preview.length > 0 ? { preview: item.preview } : {}),
    ...(Number.isFinite(item?.last_message_at) ? { last_active: item.last_message_at } : {}),
    ...(Number.isFinite(item?.created_at) ? { started_at: item.created_at } : {}),
    pinned: item?.pinned === true,
    archived: item?.archived === true,
    unread: false,
    hidden: false,
    ...(typeof item?.model === 'string' && item.model.length > 0 ? { model: item.model } : {}),
    ...(typeof item?.workspace === 'string' && item.workspace.length > 0 ? { cwd: item.workspace } : {}),
    ...(Number.isSafeInteger(item?.message_count) ? { message_count: item.message_count } : {}),
    profile: PROFILE_NAME,
  }
}

/**
 * One transcript row in the shape the Hermes client decodes.
 * @param {object} message facade ChatMessage.
 * @param {number} index position in the page.
 * @returns {object} transcript row.
 */
export function transcriptRowOf(message, index) {
  const content = message?.content
  return {
    role: typeof message?.role === 'string' ? message.role : 'assistant',
    content: typeof content === 'string' || Array.isArray(content) ? content : (content === undefined ? '' : String(content)),
    row_id: index + 1,
    ...(Number.isFinite(message?.timestamp) ? { timestamp: message.timestamp } : {}),
    ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(typeof message?.tool_call_id === 'string' && message.tool_call_id.length > 0
      ? { tool_call_id: message.tool_call_id } : {}),
    ...(typeof message?.tool_name === 'string' && message.tool_name.length > 0
      ? { tool_name: message.tool_name } : {}),
    ...(typeof message?.reasoning === 'string' && message.reasoning.length > 0
      ? { reasoning: message.reasoning } : {}),
  }
}

/**
 * The info block session.resume, session.create and session.info carry.
 * @param {object} detail facade session detail.
 * @param {object} [extra] overrides.
 * @returns {object} info.
 */
export function sessionInfoOf(detail, extra = {}) {
  const id = String(detail?.session_id ?? detail?.sessionId ?? '')
  return {
    session_id: id,
    running: detail?.is_streaming === true,
    ...(typeof detail?.model === 'string' && detail.model.length > 0 ? { model: detail.model } : {}),
    ...(typeof detail?.model_provider === 'string' && detail.model_provider.length > 0
      ? { provider: detail.model_provider } : {}),
    ...(typeof detail?.title === 'string' && detail.title.length > 0 ? { title: detail.title } : {}),
    ...(typeof detail?.workspace === 'string' && detail.workspace.length > 0 ? { cwd: detail.workspace } : {}),
    stored_session_id: id,
    session_key: id,
    yolo: false,
    ...(typeof detail?.reasoning_effort === 'string' && detail.reasoning_effort.length > 0
      ? { reasoning_effort: detail.reasoning_effort } : {}),
    ...(detail?.is_streaming === true && Number.isFinite(detail?.turn_started_at)
      ? { turn_started_at: detail.turn_started_at } : {}),
    ...extra,
  }
}

/**
 * The session.resume reply.
 * @param {object} detail facade session detail.
 * @param {object} [options] options.
 * @param {string} [options.infoExtra] extra info fields.
 * @returns {object} reply.
 */
export function resumeReplyOf(detail, options = {}) {
  const id = String(detail?.session_id ?? detail?.sessionId ?? '')
  const info = sessionInfoOf(detail, options.info ?? {})
  return {
    session_id: id,
    stored_session_id: id,
    session_key: id,
    message_count: Number.isSafeInteger(detail?.message_count) ? detail.message_count : 0,
    messages: [],
    messages_omitted: true,
    info,
    open_requests: [],
    running: info.running === true,
    ...(info.running === true && Number.isFinite(detail?.turn_started_at)
      ? { turn_started_at: detail.turn_started_at } : {}),
  }
}

/**
 * model.options reply from the facade's /api/models payload.
 * @param {object} payload facade models payload.
 * @returns {object} reply.
 */
export function modelOptionsOf(payload) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  const seen = new Set()
  const providers = []
  for (const group of groups) {
    const slug = String(group?.provider ?? group?.provider_id ?? group?.id ?? '')
    if (slug.length === 0 || seen.has(slug)) continue
    seen.add(slug)
    const models = (Array.isArray(group?.models) ? group.models : [])
      .map(model => (typeof model === 'string' ? model : String(model?.id ?? '')))
      .filter(id => id.length > 0)
    if (models.length === 0) continue
    providers.push({
      slug,
      name: typeof group?.name === 'string' && group.name.length > 0 ? group.name : slug,
      authenticated: true,
      models,
      unavailable_models: [],
      capabilities: {},
    })
  }
  return {
    providers,
    ...(typeof payload?.default_model === 'string' && payload.default_model.length > 0
      ? { model: payload.default_model } : {}),
    ...(typeof payload?.active_provider === 'string' && payload.active_provider.length > 0
      ? { provider: payload.active_provider } : {}),
  }
}

/**
 * commands.catalog reply from the facade's /api/commands payload.
 * @param {object} payload facade commands payload.
 * @returns {object} reply.
 */
export function commandsOf(payload) {
  const raw = Array.isArray(payload?.commands) ? payload.commands : []
  const pairs = []
  const canon = {}
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : (entry?.name ?? entry?.command ?? '')
    const clean = String(name).replace(/^\/+/, '').trim()
    if (clean.length === 0) continue
    const description = typeof entry === 'string' ? '' : String(entry?.description ?? '')
    pairs.push(['/' + clean, description])
    canon['/' + clean] = '/' + clean
    for (const alias of Array.isArray(entry?.aliases) ? entry.aliases : []) {
      const cleanAlias = String(alias).replace(/^\/+/, '').trim()
      if (cleanAlias.length > 0) canon['/' + cleanAlias] = '/' + clean
    }
  }
  return { pairs, canon, skills: [] }
}

/**
 * Map a facade usage object onto the Hermes context-window shape.
 * @param {object} usage facade usage.
 * @returns {object} usage.
 */
export function usageOf(usage) {
  const input = Number.isFinite(usage?.input_tokens) ? usage.input_tokens
    : (Number.isFinite(usage?.input) ? usage.input : 0)
  const output = Number.isFinite(usage?.output_tokens) ? usage.output_tokens
    : (Number.isFinite(usage?.output) ? usage.output : 0)
  const max = Number.isFinite(usage?.context_window) ? usage.context_window
    : (Number.isFinite(usage?.context_max) ? usage.context_max : 0)
  const used = Number.isFinite(usage?.context_used) ? usage.context_used : input + output
  return { input, output, ...(max > 0 ? { context_used: used, context_max: max } : {}) }
}
