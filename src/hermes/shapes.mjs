/**
 * Conversions from the facade's webui shapes to the Hermes host's wire shapes.
 *
 * @module dsh-hermes-facade/src/hermes/shapes
 */

import { PROFILE_NAME, TERMINAL_BACKEND } from './protocol.mjs'

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
    // The host's transcript identity is `id`; Hermex's history joins and pages on
    // it and drops a row without one, so emitting only row_id left a reopened
    // chat empty. It must be stable across pages, so the caller passes the row's
    // absolute position in the session, not its position in the page.
    id: index + 1,
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
 * The newest transcript window, widened to include a visible row when the
 * requested page holds only tool/reasoning rows.
 *
 * Hermex's first history read takes one page and decides it reached the start
 * when its row ids are empty; a page of tool-only rows has no anchor to render,
 * so a turn that spent more than a page on tools looked like an empty chat.
 * Including the most recent visible row gives the projection its anchor while
 * keeping the page at least `limit` rows so the app still offers older history.
 *
 * @param {Array<object>} messages session messages, oldest first.
 * @param {number} limit requested page size.
 * @param {number} offset rows before the newest.
 * @returns {{start: number, end: number}} slice bounds.
 */
export function latestTranscriptWindow(messages, limit, offset) {
  const end = Math.max(0, messages.length - offset)
  let start = Math.max(0, end - limit)
  if (offset !== 0 || messages.slice(start, end).some(hasVisibleText)) return { start, end }
  for (let index = end - 1; index >= 0; index -= 1) {
    if (!hasVisibleText(messages[index])) continue
    start = Math.min(start, index)
    break
  }
  return { start, end }
}

/**
 * Whether one session row carries text the transcript can anchor on.
 * @param {object} message session message.
 * @returns {boolean} visible.
 */
function hasVisibleText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(part => part?.type === 'text'
    && typeof part.text === 'string' && part.text.trim().length > 0)
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
    // Hermex shows the in-chat Files and Git entries only for a local backend.
    terminal_backend: TERMINAL_BACKEND,
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
  // The facade's SSE `done`/live usage is the Legacy snapshot shape
  // (`context_length`/`last_prompt_tokens`); the host's own vocabulary uses
  // `context_max`/`context_used`. Accept both.
  const max = Number.isFinite(usage?.context_window) ? usage.context_window
    : (Number.isFinite(usage?.context_max) ? usage.context_max
      : (Number.isFinite(usage?.context_length) ? usage.context_length : 0))
  const used = Number.isFinite(usage?.context_used) ? usage.context_used
    : (Number.isFinite(usage?.last_prompt_tokens) ? usage.last_prompt_tokens : input + output)
  return { input, output, ...(max > 0 ? { context_used: used, context_max: max } : {}) }
}

/** Goal phase to the status vocabulary the phone's goal controls read. */
const GOAL_STATUS = { active: 'active', paused: 'paused', blocked: 'blocked', complete: 'done' }

/**
 * The `session.control.read` snapshot for one session.
 *
 * Only the goal is reported: DSH has a goal domain but no loop or heartbeat
 * domain, so those keys stay absent and the phone offers no Pause/Resume for
 * them. Field names follow the Hermes control row (`title`, `status`,
 * `turns_used`, `max_turns`); values DSH has no equivalent for (a verdict, a
 * pause reason) are omitted rather than invented.
 *
 * @param {object|undefined} projection the session's `goal` projection value.
 * @returns {{control: object}} control snapshot; `{}` when no goal is current.
 */
export function controlOf(projection) {
  const goal = projection?.goal
  const objective = typeof goal?.objective === 'string' ? goal.objective : ''
  if (objective.length === 0) return { control: {} }
  return {
    control: {
      goal: {
        title: objective,
        ...(typeof goal.phase === 'string' ? { status: GOAL_STATUS[goal.phase] ?? goal.phase } : {}),
        ...(Number.isSafeInteger(projection.roundsStarted) ? { turns_used: projection.roundsStarted } : {}),
        ...(Number.isSafeInteger(goal.maxGoalRounds) ? { max_turns: goal.maxGoalRounds } : {}),
      },
    },
  }
}

