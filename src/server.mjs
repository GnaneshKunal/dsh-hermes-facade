/**
 * The hermes-webui-shaped HTTP surface the Hermex client speaks.
 *
 * Bound to loopback on its own port. Nothing here touches dsh's :3080 origin:
 * that origin is published through Tailscale Funnel, and /api there is dsh's
 * own fenced RPC namespace.
 *
 * @module dsh-hermes-facade/src/server
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join as join_dir } from 'node:path'
import { COOKIE_NAME, createAuth, safeEqual } from './auth.mjs'
import { CronRefusal, deliveryTargetsOf, jobOf, parseTiming, runsOf } from './cron.mjs'
import { exportFilename, exportFormat, renderExport } from './exporter.mjs'
import { clip, createRequestLog } from './log.mjs'
import { detailOf, epochSeconds, normaliseEvent, pageMessages, summaryOf, timelineOf } from './map.mjs'
import { openSse } from './sse.mjs'
import { createStreamRegistry } from './streams.mjs'

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * One skill catalogue row in the host's shape.
 * @param {object} skill DSH skill row.
 * @returns {object} host row.
 */
function skillRowOf(skill) {
  return {
    name: String(skill?.name ?? ''),
    description: String(skill?.description ?? ''),
    ...(typeof skill?.category === 'string' ? { category: skill.category } : {}),
    enabled: true,
    ...(typeof skill?.path === 'string' && skill.path.length > 0 ? { path: skill.path } : {}),
  }
}


/**
 * Optional request-body audit hook, set by createFacadeServer when logging is
 * on. Used to see exactly what the iOS client sends on a create.
 * @type {((req: import('node:http').IncomingMessage, body: object) => void) | null}
 */
let auditSink = null

/**
 * Effort levels offered when the model catalog declares none of its own.
 * The catalog is the source of truth: models are declared per provider with
 * their own effort ids (this deployment offers off/low/medium/high/max), and
 * advertising a level the adapter does not accept makes every change fail.
 */
const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max']

/** How long a read-only host call may block a UI request before it gives up. */
const READ_TIMEOUT_MS = 8000

/**
 * How many display messages we ask the host for when a chat opens.
 *
 * Hermex asks for 50 and pages backwards with msg_before. DSH's recent-history
 * snapshot is cheap enough at this size, and reading a window larger than one
 * page lets the facade serve real backwards pages without a second host call
 * per scroll. Raise with config.historyWindow for very long sessions.
 */
const DEFAULT_HISTORY_WINDOW = 800

/** Size of the first transcript page when the client sends no msg_before. */
const DEFAULT_HISTORY_PAGE = 200

/**
 * Transcript window for a session export.
 *
 * An export is meant to be the whole chat, not the page the client happens to
 * have open, so it asks the host for a much wider window than a normal read.
 * The host still bounds its own snapshot; whatever it returns is what travels.
 */
const EXPORT_MAX_MESSAGES = 5000

/**
 * The payload that clears a pending-prompt card on the phone.
 *
 * Hermex treats an approval update as a clear only when `pending_count` is 0
 * (`pending` null alone is "unrecognised"), so a retraction needs both keys.
 */
const CLEARED = { pending: null, pending_count: 0 }

/**
 * Reject when a host call outlives the client's patience.
 *
 * The app shows a transport banner when a request never answers, which reads to
 * the user as "the server is gone" even though the call is merely slow (a cold
 * model catalog or workspace baseline can take seconds). Bounding it turns that
 * into a fast, honest default the app can render.
 *
 * @param {Promise<unknown>} promise host call.
 * @param {number} ms budget.
 * @param {string} label what timed out, for the log.
 * @returns {Promise<unknown>} the value, or a rejection with code "timeout".
 */
function withDeadline(promise, ms, label) {
  let timer
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(label + ' timed out after ' + String(ms) + 'ms'), { code: 'timeout' }))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

/** Login attempts allowed per window per address. */
const LOGIN_LIMIT = 5
/** Login window in milliseconds. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000

/**
 * Shape a DSH ModelCatalog as the client's catalog groups.
 *
 * Shared by `/api/models`, `/api/models/live` and `/api/providers` so all three
 * spell a provider's id the same way. The client fills each option's provider
 * from the group's `provider_id`; without it the picker reports its change with
 * no provider and the facade has to guess the route.
 *
 * @param {object} catalog ModelCatalog value (groups/default/failures).
 * @returns {Array<{name: string, label: string, provider_id: string, models: Array<{id: string, label: string}>}>} groups.
 */
function catalogGroups(catalog) {
  const groups = []
  if (!Array.isArray(catalog?.groups)) return groups
  for (const group of catalog.groups) {
    const entries = Array.isArray(group?.models)
      ? group.models.map(model => ({
          id: String(model?.id ?? ''),
          label: String(model?.name ?? model?.id ?? ''),
        })).filter(model => model.id.length > 0)
      : []
    if (entries.length === 0) continue
    groups.push({
      name: String(group?.name ?? group?.id ?? 'default'),
      label: String(group?.name ?? group?.id ?? 'default'),
      provider_id: String(group?.id ?? group?.name ?? 'default'),
      models: entries,
    })
  }
  return groups
}

/**
 * Read a client flag the way hermes-webui does (`1/true/yes`).
 * @param {string|null} value query value.
 * @returns {boolean} whether the flag is on.
 */
function flagEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

/**
 * Send a non-JSON payload with an explicit content type.
 * @param {object} res response.
 * @param {number} status status code.
 * @param {string} contentType MIME type.
 * @param {string} body payload.
 * @param {Record<string,string>} [headers] extra headers.
 * @returns {void}
 */
function sendBody(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {unknown} body payload.
 * @param {Record<string,string>} [headers] extra headers.
 * @returns {void}
 */
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {Promise<object>} parsed body ({} when empty).
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text)
    const parsed = value !== null && typeof value === 'object' ? value : {}
    if (auditSink !== null) {
      try { auditSink(req, parsed) } catch { /* auditing must never break a request */ }
    }
    return parsed
  } catch {
    throw Object.assign(new Error('invalid json'), { statusCode: 400 })
  }
}

/**
 * Build the facade HTTP server.
 * @param {object} options options.
 * @param {object} options.config resolved config.
 * @param {object} options.host host adapter (see host.mjs or the standalone mock).
 * @param {{info: Function, warn: Function}} [options.logger] logger.
 * @param {object} [options.auth] pre-built auth (tests inject one).
 * @returns {object} server facade.
 */
export function createFacadeServer({ config, host, logger = console, auth }) {
  const authService = auth ?? createAuth({ dir: config.dir, ttlSeconds: config.tokenTtlSeconds })

  if (config.logRequests) {
    const logPath = join_dir(config.dir, 'requests.log')
    try { mkdirSync(config.dir, { recursive: true, mode: 0o700 }) } catch { /* exists */ }
    auditSink = (req, body) => {
      // Bounded: enough to see which keys the client sends, never a whole file.
      let text = JSON.stringify(body)
      if (text.length > 4000) text = text.slice(0, 4000) + '…'
      appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        url: req.url,
        body: text,
      }) + '\n')
    }
  }
  // One line per request (access.log) plus one per endpoint the app calls that
  // we do not serve (unknown-endpoints.log). The second file is always on: it is
  // the answer to "why did the app say the endpoint was not found?".
  const requestLog = createRequestLog({ dir: config.dir, logger, enabled: config.logRequests })
  if (config.logRequests) logger.info?.('hermes-facade: access log ' + requestLog.accessPath)
  logger.info?.('hermes-facade: unknown endpoints ' + requestLog.unknownPath)

  // Finished streams stay replayable for the client's reconnect, then prune on
  // the next finish. Config can shorten the window for tests and small hosts.
  const registry = createStreamRegistry(
    Number.isSafeInteger(config.streamRetainMs) && config.streamRetainMs >= 0
      ? { retainMs: config.streamRetainMs }
      : {},
  )

  /** Bounded host transcript window and the initial page size (see constants). */
  const historyWindow = Number.isSafeInteger(config.historyWindow) && config.historyWindow >= 50
    ? config.historyWindow
    : DEFAULT_HISTORY_WINDOW
  const historyPage = Number.isSafeInteger(config.historyPage) && config.historyPage > 0
    ? Math.min(config.historyPage, historyWindow)
    : Math.min(DEFAULT_HISTORY_PAGE, historyWindow)

  const loginAttempts = new Map()
  /** @type {Set<Function>} */
  const interactionChannels = new Set()

  host.setClientPredicate(sessionId => registry.forSession(sessionId) !== undefined)

  /**
   * Mirror one interaction notice into the live chat stream, journal included.
   *
   * The app applies approval/clarify payloads from the chat SSE as well as from
   * the per-session monitor streams, so a resolved prompt must reach both: a
   * clear that only travelled on /api/approval/stream would leave a card up on
   * a phone whose monitor stream is not running.
   * @param {object} notice host interruption notice.
   * @returns {void}
   */
  function publishInteraction(notice) {
    const stream = registry.forSession(notice.sessionId)
    if (stream === undefined) return
    if (notice.kind === 'approval' || notice.kind === 'approval-resolved') {
      // Re-read instead of trusting the notice: a resolved event can race a
      // newer ask for the same session, and a clear would wipe the new card.
      const pending = host.pendingApproval?.(notice.sessionId)
      registry.publish(stream, 'approval', pending === undefined ? CLEARED : { pending })
      return
    }
    if (notice.kind === 'clarify' || notice.kind === 'clarify-resolved') {
      const pending = host.pendingClarification?.(notice.sessionId)
      registry.publish(stream, 'clarify', pending === undefined ? CLEARED : { pending })
    }
  }

  host.onInteraction?.(notice => {
    publishInteraction(notice)
    for (const deliver of interactionChannels) deliver(notice)
  })

  /**
   * Whether a request carries a valid session cookie, or the loopback-only
   * internal token the Hermes-protocol listener presents.
   *
   * The gateway on the second port talks to this listener over 127.0.0.1 and
   * must not hold the user's plaintext password (only its scrypt hash is kept).
   * The token is a 0600 file in the state directory and is refused from
   * anything but loopback, so this cannot widen the auth boundary.
   *
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} authenticated.
   */
  function isAuthed(req) {
    const presented = req.headers['x-facade-internal']
    if (typeof presented === 'string' && presented.length > 0 &&
        typeof config.internalToken === 'string' && config.internalToken.length > 0 &&
        safeEqual(presented, config.internalToken)) {
      const address = req.socket?.remoteAddress ?? ''
      if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
    }
    return authService.verifyCookie(authService.cookieFrom(req))
  }

  /**
   * Workspace to join when the client names none.
   *
   * Hermex sends only {"profile":"default"} on a plain new chat: its project
   * selection does not travel to the server, and webui would fall back to its
   * configured default workspace. We mirror that with the host's own cwd so the
   * session is grouped rather than orphaned.
   * @returns {string} absolute path.
   */
  function defaultWorkspacePath() {
    return config.defaultWorkspace ?? process.cwd()
  }

  /**
   * Project grouping plus the registry's pin/archive sets for one request.
   *
   * All three come from the same workspace/follow baseline: the workspaces carry
   * session membership, and `pinnedSessionIds`/`archivedSessionIds` are
   * registry-global sets layered over that membership. Reading them together
   * means a session row always agrees with its workspace lane.
   *
   * @returns {Promise<{index: Map<string, {id: string, name: string}>, pinned: Set<string>, archived: Set<string>}>} visibility.
   */
  async function sessionVisibility() {
    let value
    try {
      value = await withDeadline(host.workspaces(), READ_TIMEOUT_MS, 'workspace list')
    } catch (error) {
      logger.warn?.('hermes-facade: workspace baseline failed: ' + String(error?.message ?? error))
      value = { workspaces: [], pinnedSessionIds: [], archivedSessionIds: [] }
    }
    const index = new Map()
    for (const workspace of value?.workspaces ?? []) {
      for (const sessionId of workspace.sessionIds ?? []) {
        index.set(String(sessionId), { id: workspace.id, name: workspace.name })
      }
    }
    return {
      index,
      pinned: new Set((value?.pinnedSessionIds ?? []).map(String)),
      archived: new Set((value?.archivedSessionIds ?? []).map(String)),
    }
  }

  /**
   * Apply the model the client named on a create/update/send, when it differs
   * from what the session already uses.
   *
   * Hermex changes models with `POST /api/session/update`, and also repeats the
   * chosen model on `session/new` and `chat/start`. Before this, the facade
   * ignored all three, so the chip showed a model the next turn would not use.
   * @param {string} sessionId session id.
   * @param {object} body request body (snake_case or camelCase).
   * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}|undefined>} applied selection.
   */
  async function applyRequestedModel(sessionId, body) {
    const model = typeof body?.model === 'string' ? body.model.trim() : ''
    if (model.length === 0) return undefined
    const rawProvider = typeof body?.model_provider === 'string' && body.model_provider.trim().length > 0
      ? body.model_provider.trim()
      : (typeof body?.modelProvider === 'string' && body.modelProvider.trim().length > 0 ? body.modelProvider.trim() : undefined)
    const current = typeof host.modelSelection === 'function'
      ? await host.modelSelection(sessionId).catch(() => undefined)
      : undefined
    // A provider can travel inside the model id ("@provider:model"); compare it
    // too, or a same-model request would skip selectModel and silently keep the
    // old provider.
    const at = model.startsWith('@') ? model.lastIndexOf(':') : -1
    const providerFromId = at > 1 ? model.slice(1, at) : undefined
    const bareModel = at > 1 ? model.slice(at + 1) : model
    const requestedProvider = rawProvider ?? providerFromId
    const sameModel = current?.model === bareModel
    const sameProvider = requestedProvider === undefined || current?.provider === requestedProvider
    if (sameModel && sameProvider) return undefined
    return await host.selectModel({
      sessionId,
      model,
      ...(rawProvider === undefined ? {} : { provider: rawProvider }),
    })
  }

  /**
   * Current reasoning-effort state for a session, never throwing.
   *
   * The effort the chip shows must be the one the host will actually use, and
   * the levels offered must be the model's own: DSH models declare their effort
   * ids per provider (this deployment offers off/low/medium/high/max), so a
   * hard-coded list makes the picker send an id the adapter rejects.
   *
   * @param {string} sessionId session id (may be empty before a chat exists).
   * @param {object} [overrides] explicit provider/model from the query string.
   * @returns {Promise<{effort: string, supportedEfforts: string[], provider?: string, model?: string}>} state.
   */
  async function reasoningState(sessionId, overrides = {}) {
    const fallback = { effort: 'medium', supportedEfforts: EFFORT_LEVELS }
    if (typeof host.reasoning !== 'function') {
      let effort = fallback.effort
      try {
        const selection = sessionId.length > 0 && typeof host.modelSelection === 'function'
          ? await host.modelSelection(sessionId)
          : undefined
        if (typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) effort = selection.reasoningEffort
      } catch { /* keep the default */ }
      return { ...fallback, effort }
    }
    try {
      const info = await withDeadline(host.reasoning({ sessionId, ...overrides }), READ_TIMEOUT_MS, 'reasoning lookup')
      return {
        effort: typeof info?.effort === 'string' && info.effort.length > 0 ? info.effort : fallback.effort,
        supportedEfforts: Array.isArray(info?.supportedEfforts) && info.supportedEfforts.length > 0
          ? info.supportedEfforts.map(String)
          : fallback.supportedEfforts,
        ...(typeof info?.provider === 'string' && info.provider.length > 0 ? { provider: info.provider } : {}),
        ...(typeof info?.model === 'string' && info.model.length > 0 ? { model: info.model } : {}),
      }
    } catch {
      return fallback
    }
  }

  /**
   * Rate-limit login attempts per remote address.
   * @param {string} address remote address.
   * @returns {boolean} allowed.
   */
  function loginAllowed(address) {
    const now = Date.now()
    const entry = loginAttempts.get(address)
    if (entry === undefined || now > entry.resetAt) {
      loginAttempts.set(address, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
      return true
    }
    entry.count += 1
    return entry.count <= LOGIN_LIMIT
  }

  /**
   * Build the Set-Cookie header for a successful login.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {string} header value.
   */
  function sessionCookie(req) {
    const secure = req.headers['x-forwarded-proto'] === 'https'
    const value = authService.issueCookie()
    const parts = [
      COOKIE_NAME + '=' + encodeURIComponent(value),
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + String(config.tokenTtlSeconds),
    ]
    if (secure) parts.push('Secure')
    return parts.join('; ')
  }

  /**
   * The session's usage for the Legacy snapshot, never throwing.
   * @param {string} sessionId session id.
   * @returns {Promise<object>} usage `{input_tokens, output_tokens, context_length, last_prompt_tokens}`.
   */
  async function usageFor(sessionId) {
    if (typeof host.sessionUsage !== 'function') return {}
    try { return await host.sessionUsage(sessionId) } catch { return {} }
  }

  /**
   * Append one DSH frame to a chat stream, translated to Hermex SSE events.
   * @param {object} stream stream record.
   * @param {object} frame follow frame.
   * @returns {Promise<boolean>} whether the turn ended on this frame.
   */
  async function applyFrame(stream, frame) {
    if (frame?.type === 'assistant-stream') {
      const inner = frame.frame
      if (inner?.type === 'chunk') {
        // StreamChunk types are text-delta / reasoning-delta (dsh-llm); the bare
        // text / reasoning spellings are accepted defensively.
        const chunk = inner.chunk ?? {}
        const text = typeof chunk.text === 'string' ? chunk.text : ''
        if (text.length > 0 && (chunk.type === 'text-delta' || chunk.type === 'text')) {
          stream.emittedText = (stream.emittedText ?? 0) + text.length
          registry.publish(stream, 'token', { text })
        } else if (text.length > 0 && (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning')) {
          registry.publish(stream, 'reasoning', { text })
        }
      }
      return false
    }
    if (frame?.type !== 'event') return false
    const event = normaliseEvent(frame.event)
    switch (event.type) {
      case 'tool/call':
        registry.publish(stream, 'tool', {
          event_type: 'start',
          name: String(event.data.name ?? ''),
          preview: '',
          args: safeArgs(event.data.arguments),
          tid: String(event.data.callId ?? ''),
        })
        return false
      case 'tool/result':
        registry.publish(stream, 'tool_complete', {
          event_type: 'complete',
          name: '',
          preview: String(event.data.preview ?? ''),
          is_error: event.data.isError === true,
          tid: String(event.data.callId ?? ''),
        })
        return false
      case 'assistant/message': {
        // Safety net: if the streaming frames never arrived (or used a chunk
        // type we do not know), still deliver the settled text exactly once.
        if (typeof event.data.text === 'string' && event.data.text.length > 0 && (stream.emittedText ?? 0) === 0) {
          stream.emittedText = event.data.text.length
          registry.publish(stream, 'token', { text: event.data.text })
        }
        // The provider usage is now in the projections: an `usage` frame lets
        // both clients fill the context ring before the turn ends (the Legacy
        // parser ignores an unknown event; the gateway maps it to session.usage).
        const usage = await usageFor(stream.sessionId)
        if (Object.keys(usage).length > 0) registry.publish(stream, 'usage', usage)
        return false
      }
      case 'session/title':
        if (typeof event.data.title === 'string') {
          registry.publish(stream, 'title', { session_id: stream.sessionId, title: event.data.title })
        }
        return false
      case 'turn/end': {
        // The turn is over and DSH says why. Hermex knows one completion and two
        // failure terminals: `error` (the run failed) and `cancel` (it was
        // stopped). Reporting every turn as `done` is what made the phone show a
        // provider error, a blocked turn or the Stop button as a success.
        const outcome = event.data.outcome ?? { status: 'completed' }
        if (stream.terminal !== null) return true
        if (outcome.status === 'cancelled') {
          // cancel/error are closing frames for the client — it tears the
          // transport down on them — so no trailing `stream_end`: that would land
          // as a second, completing teardown of a run that did not complete.
          registry.publish(stream, 'cancel', {})
          registry.finish(stream, 'cancelled')
          return true
        }
        if (outcome.status === 'failed') {
          registry.publish(stream, 'error', { message: String(outcome.message ?? 'The turn failed.') })
          registry.finish(stream, 'failed')
          return true
        }
        registry.publish(stream, 'done', {
          usage: await usageFor(stream.sessionId),
          session: { session_id: stream.sessionId },
        })
        registry.publish(stream, 'stream_end', {})
        registry.finish(stream, 'completed')
        return true
      }
      default:
        return false
    }
  }

  /**
   * Parse a tool-call argument payload into an object.
   * @param {unknown} value raw arguments (DSH stores a JSON string).
   * @returns {object} parsed arguments.
   */
  function safeArgs(value) {
    if (value !== null && typeof value === 'object') return value
    if (typeof value === 'string' && value.length > 0) {
      try {
        const parsed = JSON.parse(value)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    return {}
  }

  /**
   * Run one turn: prompt the host, stream its frames, terminate the stream.
   * @param {object} stream stream record.
   * @param {string} text user message.
   * @returns {Promise<void>} resolves when the stream is finished.
   */
  async function runTurn(stream, text) {
    const controller = new AbortController()
    stream.controller = controller
    try {
      await host.prompt({ sessionId: stream.sessionId, text })
      let ended = false
      for await (const frame of host.follow(stream.sessionId, { signal: controller.signal })) {
        if (stream.terminal !== null) break
        ended = await applyFrame(stream, frame)
        if (ended) break
      }
      if (!ended && stream.terminal === null) {
        registry.publish(stream, 'done', {
          usage: await usageFor(stream.sessionId),
          session: { session_id: stream.sessionId },
        })
        registry.publish(stream, 'stream_end', {})
        registry.finish(stream, 'completed')
      }
    } catch (error) {
      if (stream.terminal === null) {
        registry.publish(stream, 'error', { message: String(error?.message ?? error) })
        registry.publish(stream, 'stream_end', {})
        registry.finish(stream, 'failed')
      }
    }
  }

  const handler = async (req, res) => {
    const started = Date.now()
    const method = req.method ?? 'GET'
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      url = new URL('/', 'http://127.0.0.1')
    }
    const path = url.pathname
    const query = url.search.length > 1 ? url.search.slice(1) : ''

    // Annotations gathered while routing and written by the access log: this is
    // how a stubbed or unserved endpoint stays visible instead of looking like a
    // plain 200, and how a client-side timeout shows up as client_gone.
    const notes = { unknown: null, stub: null, effort: null, error: null }
    let settled = false

    /**
     * Write the access-log line once the response is over.
     * @param {boolean} gone whether the client vanished before the response ended.
     * @returns {void}
     */
    const settle = gone => {
      if (settled) return
      settled = true
      const userAgent = req.headers['user-agent']
      requestLog.request({
        method,
        path,
        ...(query.length > 0 ? { query } : {}),
        status: res.statusCode,
        ms: Date.now() - started,
        ...(gone ? { client_gone: true } : {}),
        ...(userAgent === undefined ? {} : { ua: clip(String(userAgent), 200) }),
        ...(notes.unknown === null ? {} : { unknown: notes.unknown }),
        ...(notes.stub === null ? {} : { stub: notes.stub }),
        ...(notes.effort === null ? {} : { effort: notes.effort }),
        ...(notes.error === null ? {} : { error: notes.error }),
      })
    }
    res.on('finish', () => settle(false))
    res.on('close', () => settle(!res.writableFinished))

    /**
     * Record a call the facade does not implement, in its own log file.
     * @param {string} kind how the call was handled.
     * @param {object} [extra] response status, request body, or detail.
     * @returns {void}
     */
    const noteUnknown = (kind, extra = {}) => {
      notes.unknown = kind
      requestLog.unknown({
        method,
        path,
        ...(query.length > 0 ? { query } : {}),
        kind,
        ...(extra.status === undefined ? {} : { status: extra.status }),
        ...(extra.body === undefined ? {} : { body: clip(JSON.stringify(extra.body)) }),
        ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      })
    }

    try {
      if (config.logRequests) logger.info?.('hermes-facade: ' + method + ' ' + path)

      // ---- public endpoints -------------------------------------------------
      if (method === 'GET' && path === '/health') {
        // Extra fields are ignored by the client's HealthResponse decoder. They
        // exist so an external check (and the hot-reload script) can tell which
        // build is live and whether a turn is currently streaming.
        sendJson(res, 200, {
          status: 'ok',
          active_streams: registry.activeCount(),
          features: ['history-paging', 'tool-results', 'model-switch', 'session-export', 'pin-archive', 'providers', 'approval-retract', 'clarify-markers'],
          history: { page: historyPage, window: historyWindow },
        })
        return
      }

      if (method === 'GET' && path === '/api/auth/status') {
        sendJson(res, 200, {
          auth_enabled: true,
          logged_in: isAuthed(req),
          password_auth_enabled: true,
          oidc_enabled: false,
          trusted_auth_enabled: false,
        })
        return
      }

      if (method === 'POST' && path === '/api/auth/login') {
        const address = req.socket.remoteAddress ?? 'unknown'
        if (!loginAllowed(address)) {
          sendJson(res, 429, { ok: false, error: 'too many attempts' })
          return
        }
        const body = await readJson(req)
        if (!authService.verifyPassword(body.password)) {
          sendJson(res, 401, { ok: false, error: 'invalid password' })
          return
        }
        loginAttempts.delete(address)
        sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req) })
        return
      }

      if (method === 'POST' && path === '/api/auth/logout') {
        sendJson(res, 200, { ok: true }, {
          'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        })
        return
      }

      // ---- everything below needs the cookie --------------------------------
      if (path.startsWith('/api/') && !isAuthed(req)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }

      if (method === 'GET' && path === '/api/sessions/search') {
        // Hermex's list search: id matches first, then message-content hits, then
        // title matches, one row per session. The same reply carries the Hermes
        // host's `results` (V2) and the webui's `sessions` (Legacy); both decoders
        // ignore the other key. DSH carries no session provenance, so a source
        // filter we cannot satisfy (e.g. `sources=cron`) honestly matches nothing.
        const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
        if (q.length === 0) {
          sendJson(res, 200, { results: [], sessions: [], query: '', count: 0 })
          return
        }
        const limitParsed = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
        const limit = Number.isSafeInteger(limitParsed) && limitParsed > 0 ? Math.min(limitParsed, 100) : 20
        const content = url.searchParams.get('content') === null
          ? true
          : flagEnabled(url.searchParams.get('content'))
        const csv = value => (value ?? '').split(',').map(part => part.trim()).filter(Boolean)
        const single = (url.searchParams.get('source') ?? '').trim()
        const includeSources = new Set(single.length > 0 ? [single] : csv(url.searchParams.get('sources')))
        const excludeSources = new Set(csv(url.searchParams.get('exclude_sources')))
        const items = (await host.listSessions()).filter(item => item?.origin !== 'subagent')
        const visibility = await sessionVisibility()
        const entries = items.map(item => {
          const sessionId = String(item?.sessionId ?? '')
          return {
            row: summaryOf(item, visibility.index.get(sessionId), {
              pinned: visibility.pinned.has(sessionId),
              archived: visibility.archived.has(sessionId),
            }),
            source: 'gui',
          }
        })
        const byId = new Map(entries.map(entry => [entry.row.session_id, entry]))
        const allowed = entry => !excludeSources.has(entry.source)
          && (includeSources.size === 0 || includeSources.has(entry.source))
        const results = []
        const sessions = []
        const seen = new Set()
        const add = (sessionId, snippet, role, matchType) => {
          if (results.length >= limit || seen.has(String(sessionId))) return
          const entry = byId.get(String(sessionId))
          if (entry === undefined || !allowed(entry)) return
          seen.add(String(sessionId))
          const row = entry.row
          const text = String(snippet ?? '')
          const matchPreview = text.length > 124 ? text.slice(0, 124) : text
          const summary = {
            ...row,
            session_id: row.session_id,
            id: row.session_id,
            // DSH has one id per conversation (branches are their own sessions), so
            // each result is its own lineage root.
            lineage_root: row.session_id,
            source: entry.source,
            match_type: matchType,
            last_active: row.last_message_at,
            session_started: row.created_at,
            started_at: row.created_at,
            archived: row.archived === true,
            profile: 'default',
          }
          // Hermex's host decoder only keeps a snippet when it also knows the
          // author, and DSH's search API exposes no role. So the host shape
          // carries no excerpt; the webui shape keeps match_preview for Legacy.
          results.push({ ...summary, snippet: null, role: null })
          sessions.push({ ...summary, snippet: text, role: role ?? null, match_preview: matchPreview })
        }
        const needle = q.toLowerCase()
        for (const entry of entries) {
          if (entry.row.session_id.toLowerCase().includes(needle)) {
            add(entry.row.session_id, 'Session ID: ' + entry.row.session_id, null, 'id')
          }
        }
        if (content) {
          try {
            const found = await host.searchSessions(q)
            for (const hit of found.items) add(hit.sessionId, String(hit?.snippet ?? ''), hit?.role, 'content')
          } catch (error) {
            logger.warn?.('hermes-facade: session search failed: ' + String(error?.message ?? error))
          }
        }
        for (const entry of entries) {
          const title = typeof entry.row.title === 'string' ? entry.row.title : ''
          if (title.length > 0 && title.toLowerCase().includes(needle)) add(entry.row.session_id, title, null, 'title')
        }
        sendJson(res, 200, { results, sessions, query: q, count: results.length })
        return
      }

      if (method === 'GET' && path === '/api/sessions') {
        const items = (await host.listSessions()).filter(item => item?.origin !== 'subagent')
        const visibility = await sessionVisibility()
        // Archived rows are hidden from the default response, exactly as the
        // webui does: the app's main list never asks for them, and its Archived
        // screen opts in with include_archived=1. archived_count is always the
        // full set, so the list can still offer the Archived entry.
        const rows = items.map(item => {
          const sessionId = String(item?.sessionId ?? '')
          return summaryOf(item, visibility.index.get(sessionId), {
            pinned: visibility.pinned.has(sessionId),
            archived: visibility.archived.has(sessionId),
          })
        })
        const archivedRows = rows
          .filter(row => row.archived)
          .sort((left, right) => (right.updated_at ?? 0) - (left.updated_at ?? 0))
        const includeArchived = flagEnabled(url.searchParams.get('include_archived'))
        const archivedLimitParsed = Number.parseInt(url.searchParams.get('archived_limit') ?? '', 10)
        const archivedLimit = Number.isSafeInteger(archivedLimitParsed) && archivedLimitParsed > 0
          ? Math.min(archivedLimitParsed, 2000)
          : undefined
        const visible = includeArchived
          // Archiving is mutually exclusive with pinning in DSH, so appending the
          // archived rows after the active ones cannot split a pinned group.
          ? [...rows.filter(row => !row.archived), ...archivedRows.slice(0, archivedLimit ?? archivedRows.length)]
          : rows.filter(row => !row.archived)
        sendJson(res, 200, {
          sessions: visible,
          cli_count: 0,
          archived_count: archivedRows.length,
          // The webui echoes the flag it acted on; the app ignores the key but a
          // probe of the wire does not have to guess whether the opt-in landed.
          include_archived: includeArchived,
          ...(archivedLimit === undefined ? {} : { archived_limit: archivedLimit }),
          server_time: Math.floor(Date.now() / 1000),
          server_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        return
      }

      if (method === 'GET' && path === '/api/session') {
        const sessionId = url.searchParams.get('session_id') ?? url.searchParams.get('sessionId') ?? ''
        if (!sessionId) { sendJson(res, 400, { detail: 'session_id required' }); return }
        const limitText = url.searchParams.get('msg_limit') ?? url.searchParams.get('message_limit')
        const limitParsed = Number.parseInt(limitText ?? '', 10)
        const limit = Number.isSafeInteger(limitParsed) && limitParsed > 0 ? limitParsed : 50
        const beforeParsed = Number.parseInt(url.searchParams.get('msg_before') ?? '', 10)
        const before = Number.isSafeInteger(beforeParsed) && beforeParsed > 0 ? beforeParsed : undefined
        // Read a bounded recent window, then serve one page from it. A client
        // that pages back gets the chunk immediately before its cursor; the
        // cursor is the index of the page's first message, so scrolling stops
        // exactly at index 0.
        const list = await host.listSessions()
        const item = list.find(row => String(row?.sessionId) === sessionId)
        let snapshot
        try {
          snapshot = await host.readSession(sessionId, { maxMessages: historyWindow })
        } catch (error) {
          if (error?.code === 'subagent-session') {
            sendJson(res, 400, { detail: String(error.message) })
            return
          }
          throw error
        }
        if (item === undefined && snapshot.events.length === 0) {
          sendJson(res, 404, { error: 'not found', detail: 'Session not found' })
          return
        }
        const timeline = timelineOf(snapshot.events)
        const page = pageMessages(timeline.messages, { limit, before, initial: historyPage })
        const visibility = await sessionVisibility()
        const detail = detailOf(
          item ?? { sessionId },
          page.messages,
          visibility.index.get(String(sessionId)),
          page,
          timeline.toolCalls,
          {
            pinned: visibility.pinned.has(String(sessionId)),
            archived: visibility.archived.has(String(sessionId)),
          },
        )
        // The app rebuilds its context ring from this detail after every turn
        // (loadMessages), so the snapshot must carry the usage too — otherwise
        // the ring fills on `done` and empties on the follow-up refresh.
        Object.assign(detail, await usageFor(sessionId))
        sendJson(res, 200, { session: detail })
        return
      }

      if (method === 'GET' && path === '/api/session/export') {
        const sessionId = url.searchParams.get('session_id') ?? url.searchParams.get('sessionId') ?? ''
        if (sessionId.length === 0) { sendJson(res, 400, { error: 'session_id required' }); return }
        const format = exportFormat(url.searchParams.get('format'))
        if (format === undefined) {
          sendJson(res, 400, {
            error: 'unsupported format',
            detail: 'format must be json, html or markdown',
          })
          return
        }
        const snapshot = await host.readSession(sessionId, { maxMessages: EXPORT_MAX_MESSAGES })
        const list = await host.listSessions()
        const item = list.find(row => String(row?.sessionId) === sessionId)
        if (item === undefined && snapshot.events.length === 0) {
          sendJson(res, 404, { error: 'Session not found', detail: 'Session not found' })
          return
        }
        // Same mapping as GET /api/session, so the file and the open chat agree.
        const timeline = timelineOf(snapshot.events)
        const visibility = await sessionVisibility()
        const detail = detailOf(
          item ?? { sessionId },
          timeline.messages,
          visibility.index.get(String(sessionId)),
          {},
          timeline.toolCalls,
          {
            pinned: visibility.pinned.has(String(sessionId)),
            archived: visibility.archived.has(String(sessionId)),
          },
        )
        Object.assign(detail, await usageFor(sessionId))
        const document = renderExport({
          format,
          session: detail,
          messages: timeline.messages,
          toolCalls: timeline.toolCalls,
        })
        sendBody(res, 200, document.contentType, document.body, {
          'content-disposition': 'attachment; filename="' + exportFilename(sessionId, document.extension) + '"',
        })
        return
      }

      if (path === '/api/cron/jobs' || path === '/api/cron/delivery-targets' || path.startsWith('/api/cron/jobs/')) {
        const sendEditResult = result => {
          if (result?.code === 'schedule_not_found') throw new CronRefusal(404, 'Task not found')
          if (result?.code === 'schedule_conflict') throw new CronRefusal(409, 'This Task changed since it was read.')
          sendJson(res, 200, jobOf(result))
        }
        const rejectUnsupported = fields => {
          const deliver = typeof fields.deliver === 'string' ? fields.deliver.trim() : ''
          if (deliver.length > 0 && deliver !== 'local') {
            throw new CronRefusal(400, 'Delivery is local only: this host delivers into a DSH session.')
          }
          if (Array.isArray(fields.skills) && fields.skills.length > 0) {
            throw new CronRefusal(400, 'Skills are not configurable on a DSH schedule.')
          }
          for (const key of ['model', 'provider']) {
            if (typeof fields[key] === 'string' && fields[key].trim().length > 0) {
              throw new CronRefusal(400, 'Model and provider are not configurable on a DSH schedule.')
            }
          }
        }
        try {
          if (method === 'GET' && path === '/api/cron/jobs') {
            sendJson(res, 200, (await host.listSchedules()).map(jobOf))
            return
          }
          if (method === 'GET' && path === '/api/cron/delivery-targets') {
            sendJson(res, 200, deliveryTargetsOf())
            return
          }
          if (method === 'POST' && path === '/api/cron/jobs') {
            const body = await readJson(req)
            const prompt = String(body.prompt ?? '').trim()
            if (prompt.length === 0) throw new CronRefusal(400, 'prompt is required')
            const timing = parseTiming(body.schedule)
            rejectUnsupported(body)
            const title = String(body.name ?? '').trim() || prompt.slice(0, 60)
            const entry = await host.createSchedule({ title, prompt, timing, target: { kind: 'new' } })
            sendJson(res, 200, jobOf(entry))
            return
          }
          const match = /^\/api\/cron\/jobs\/([^/]+)(?:\/(runs|pause|resume|trigger))?$/.exec(path)
          if (match === null) { sendJson(res, 404, { detail: 'Not Found' }); return }
          const id = decodeURIComponent(match[1])
          const action = match[2] ?? ''
          if (action === 'runs' && method === 'GET') {
            const parsed = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
            const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 100
            const page = await host.scheduleHistory(id, limit)
            if (page?.code === 'schedule_not_found') throw new CronRefusal(404, 'Task not found')
            sendJson(res, 200, runsOf(page))
            return
          }
          if (method === 'DELETE' && action === '') {
            const result = await host.editSchedule({ id, action: 'delete' })
            if (result?.code === 'schedule_not_found') throw new CronRefusal(404, 'Task not found')
            sendJson(res, 200, { ok: result?.deleted === true })
            return
          }
          if (method === 'PUT' && action === '') {
            const body = await readJson(req)
            const updates = body.updates !== null && typeof body.updates === 'object' ? body.updates : {}
            rejectUnsupported(updates)
            const patch = {}
            if (typeof updates.prompt === 'string') patch.prompt = updates.prompt
            if (typeof updates.name === 'string' && updates.name.trim().length > 0) patch.title = updates.name.trim()
            if (typeof updates.schedule === 'string' && updates.schedule.trim().length > 0) patch.timing = parseTiming(updates.schedule)
            if (Object.keys(patch).length === 0) throw new CronRefusal(400, 'no supported update fields')
            sendEditResult(await host.editSchedule({ id, action: 'update', patch }))
            return
          }
          if (method === 'POST' && (action === 'pause' || action === 'resume')) {
            const result = await host.editSchedule({ id, action: 'update', patch: { active: action === 'resume' } })
            sendEditResult(result)
            return
          }
          if (method === 'POST' && action === 'trigger') {
            const result = await host.runSchedule(id)
            if (result?.code === 'schedule_not_found') throw new CronRefusal(404, 'Task not found')
            if (result?.code === 'schedule_execution_pending') throw new CronRefusal(409, 'This Task is already running.')
            sendJson(res, 200, jobOf(result))
            return
          }
          sendJson(res, 405, { detail: 'Method Not Allowed' })
          return
        } catch (error) {
          if (error instanceof CronRefusal) { sendJson(res, error.status, { detail: error.detail }); return }
          // DSH's schedule service refuses invalid input with a RemoteError; the
          // phone shows its detail as the editor's error, not an opaque 500.
          if (error?.code === 'schedule/input-invalid') {
            sendJson(res, 400, { detail: String(error?.message ?? 'The schedule is invalid.') })
            return
          }
          if (error?.code === 'schedule/target-archived') {
            sendJson(res, 409, { detail: String(error?.message ?? 'The target session is archived.') })
            return
          }
          // readJson refuses a malformed or oversized body with its own status;
          // forward it instead of turning a 400/413 into an opaque 500.
          if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
            sendJson(res, error.statusCode, { detail: String(error?.message ?? 'Invalid request') })
            return
          }
          logger.warn?.('hermes-facade: cron request failed: ' + String(error?.message ?? error))
          sendJson(res, 500, { detail: 'Task operation failed' })
          return
        }
      }
      if (method === 'POST' && path === '/api/session/new') {
        const body = await readJson(req)
        const workspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : defaultWorkspacePath()
        const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : undefined
        const created = await host.ensureSession(undefined, workspace, projectId)
        let selected
        try {
          selected = await applyRequestedModel(created, body)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const rows = await host.listSessions()
        const item = rows.find(entry => String(entry?.sessionId) === created)
        const visibility = await sessionVisibility()
        const detail = detailOf(item ?? { sessionId: created }, [], visibility.index.get(String(created)))
        if (selected !== undefined) {
          detail.model = selected.model
          if (typeof selected.provider === 'string') detail.model_provider = selected.provider
        }
        sendJson(res, 200, { session: detail })
        return
      }

      if (method === 'POST' && path === '/api/session/rename') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        const title = String(body.title ?? '')
        if (!sessionId || !title) { sendJson(res, 400, { ok: false, error: 'session_id and title required' }); return }
        try {
          await host.renameSession({ sessionId, title })
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (method === 'POST' && path === '/api/session/pin') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        if (!sessionId) { sendJson(res, 400, { ok: false, error: 'session_id required' }); return }
        try {
          await host.pinSession({ sessionId, pinned: body.pinned !== false })
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (method === 'POST' && path === '/api/session/archive') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        if (!sessionId) { sendJson(res, 400, { ok: false, error: 'session_id required' }); return }
        try {
          await host.archiveSession({ sessionId, archived: body.archived !== false })
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (method === 'POST' && path === '/api/session/branch') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        if (!sessionId) { sendJson(res, 400, { ok: false, error: 'session_id required' }); return }
        try {
          const forked = await host.forkSession({ sessionId, keepCount: body.keep_count })
          sendJson(res, 200, { ok: true, session_id: forked.sessionId ?? null })
        } catch (error) {
          // A session with no completed turn cannot be forked: say so, do not 500.
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (method === 'POST' && path === '/api/session/yolo') {
        sendJson(res, 200, { ok: true, yolo_enabled: false })
        return
      }

      if (method === 'GET' && path === '/api/session/status') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const stream = registry.forSession(sessionId)
        sendJson(res, 200, { active: stream !== undefined, session_id: sessionId })
        return
      }

      // The composer's model picker calls this; the folder picker reuses it with
      // a workspace. The model is applied through session/selectModel so the
      // next turn actually uses it; the workspace is adopted as project
      // membership (DSH cannot change a started session's cwd).
      if (method === 'POST' && path === '/api/session/update') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? body.sessionId ?? '')
        if (!sessionId) { sendJson(res, 400, { ok: false, error: 'session_id required' }); return }
        let selected
        try {
          selected = await applyRequestedModel(sessionId, body)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const workspace = typeof body.workspace === 'string' && body.workspace.trim().length > 0
          ? body.workspace.trim()
          : undefined
        if (workspace !== undefined && typeof host.adoptSession === 'function') {
          try {
            await host.adoptSession({ sessionId, workspacePath: workspace })
          } catch (error) {
            logger.warn?.('hermes-facade: could not adopt session into workspace: ' + String(error?.message ?? error))
          }
        }
        const rows = await host.listSessions()
        const item = rows.find(row => String(row?.sessionId) === sessionId)
        if (item === undefined) { sendJson(res, 404, { error: 'not found', detail: 'Session not found' }); return }
        const visibility = await sessionVisibility()
        const detail = detailOf(item, [], visibility.index.get(sessionId), {}, [], {
          pinned: visibility.pinned.has(String(sessionId)),
          archived: visibility.archived.has(String(sessionId)),
        })
        if (selected !== undefined) {
          detail.model = selected.model
          if (typeof selected.provider === 'string') detail.model_provider = selected.provider
        }
        if (workspace !== undefined) detail.workspace = workspace
        sendJson(res, 200, { ok: true, session: detail })
        return
      }

      // Actions DSH has no equivalent for: answer 200 with an honest error so
      // the app shows a message instead of "the server endpoint was not found".
      if (method === 'POST' && ['/api/session/delete', '/api/session/duplicate', '/api/session/compress', '/api/session/clear', '/api/session/undo', '/api/session/retry', '/api/session/truncate', '/api/session/move', '/api/session/export', '/api/session/import_cli'].includes(path)) {
        notes.stub = 'session-action'
        sendJson(res, 200, { ok: false, error: 'Not supported by DeepSeek Harness' })
        return
      }

      if (method === 'POST' && path === '/api/chat/start') {
        const body = await readJson(req)
        const text = typeof body.message === 'string' ? body.message : ''
        if (text.length === 0) { sendJson(res, 400, { detail: 'message required' }); return }
        let sessionId = typeof body.session_id === 'string' && body.session_id.length > 0 ? body.session_id : undefined
        const requestedWorkspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : undefined
        if (sessionId !== undefined && requestedWorkspace !== undefined && typeof host.adoptSession === 'function') {
          // The app creates the session first and names the project only here,
          // so file the session under that workspace before the turn starts.
          try {
            await host.adoptSession({ sessionId, workspacePath: requestedWorkspace })
          } catch (error) {
            logger.warn?.('hermes-facade: could not adopt session into workspace: ' + String(error?.message ?? error))
          }
        }
        if (sessionId === undefined) {
          const workspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : defaultWorkspacePath()
          const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : undefined
          sessionId = await host.ensureSession(undefined, workspace, projectId)
        }
        // A model chosen before the session existed only ever travels on the
        // send; apply it (when different) so the run uses what the chip says.
        try {
          await applyRequestedModel(sessionId, body)
        } catch (error) {
          sendJson(res, 400, { detail: String(error?.message ?? error) })
          return
        }
        const stream = registry.create({ sessionId })
        const pendingStartedAt = Date.now() / 1000
        sendJson(res, 200, {
          stream_id: stream.streamId,
          session_id: sessionId,
          pending_started_at: pendingStartedAt,
        })
        void runTurn(stream, text)
        return
      }

      if (method === 'GET' && path === '/api/chat/stream') {
        const streamId = url.searchParams.get('stream_id') ?? ''
        const stream = registry.get(streamId)
        if (stream === undefined) {
          sendJson(res, 404, { error: 'stream not found', detail: 'stream not found' })
          return
        }
        const replay = url.searchParams.get('replay') === '1'
        const afterSeq = Number.parseInt(url.searchParams.get('after_seq') ?? '', 10)
        const channel = openSse(res, { onClose: () => stream.channels.delete(channel) })
        stream.channels.add(channel)
        // A stream that already finished is replayed rather than 404'd: the run
        // can complete between chat/start and this connection, and replaying
        // still hands the client the full answer. Only unknown ids 404.
        if (stream.terminal !== null || replay) {
          const from = Number.isSafeInteger(afterSeq) ? afterSeq : 0
          for (const entry of stream.journal) {
            if (entry.seq > from) channel.send(entry.event, entry.data, entry.seq)
          }
        }
        const approval = host.pendingApproval?.(stream.sessionId)
        if (approval !== undefined) channel.send('approval', { pending: approval })
        const clarify = host.pendingClarification?.(stream.sessionId)
        if (clarify !== undefined) channel.send('clarify', { pending: clarify })
        if (stream.terminal !== null) channel.close()
        return
      }

      if (method === 'GET' && path === '/api/chat/stream/status') {
        const streamId = url.searchParams.get('stream_id') ?? ''
        const stream = registry.get(streamId)
        if (stream === undefined) {
          sendJson(res, 200, {
            active: false,
            stream_id: streamId,
            replay_available: false,
            journal: { terminal: true, terminal_state: 'unknown' },
          })
          return
        }
        sendJson(res, 200, {
          active: stream.terminal === null,
          stream_id: stream.streamId,
          replay_available: stream.journal.length > 0,
          journal: { terminal: stream.terminal !== null, terminal_state: stream.terminal },
        })
        return
      }

      if (method === 'POST' && path === '/api/chat/steer') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        const text = String(body.text ?? body.message ?? '')
        if (!sessionId || !text) { sendJson(res, 400, { accepted: false, error: 'session_id and text required' }); return }
        try {
          const result = await host.prompt({ sessionId, text, mode: 'steer' })
          sendJson(res, 200, { accepted: result.accepted !== false })
        } catch (error) {
          // The app maps these to "queued" / "run ended" instead of an error.
          sendJson(res, 200, { accepted: false, fallback: 'not_running', error: String(error?.message ?? error) })
        }
        return
      }

      if (method === 'GET' && path === '/api/chat/cancel') {
        const streamId = url.searchParams.get('stream_id') ?? ''
        const stream = registry.get(streamId)
        if (stream === undefined) { sendJson(res, 404, { detail: 'stream not found' }); return }
        await host.cancel(stream.sessionId)
        if (stream.terminal === null) {
          registry.publish(stream, 'cancel', {})
          registry.publish(stream, 'stream_end', {})
          registry.finish(stream, 'cancelled')
        }
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && path === '/api/approval/pending') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const pending = host.pendingApproval?.(sessionId)
        sendJson(res, 200, { pending: pending ?? null, pending_count: pending ? 1 : 0 })
        return
      }

      if (method === 'GET' && path === '/api/approval/stream') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const deliver = notice => {
          if (notice.sessionId !== sessionId) return
          if (notice.kind !== 'approval' && notice.kind !== 'approval-resolved') return
          // Send the state we actually hold, not the notice's guess: a clear
          // must never wipe a card for a newer ask in the same session.
          const pending = host.pendingApproval?.(sessionId)
          channel.send('approval', pending === undefined ? CLEARED : { pending })
        }
        const channel = openSse(res, { onClose: () => interactionChannels.delete(deliver) })
        interactionChannels.add(deliver)
        const pending = host.pendingApproval?.(sessionId)
        if (pending !== undefined) {
          channel.send('initial', { pending })
        } else {
          // Nothing pending means any card this client still draws is stale
          // (resolved while it was away, or answered in the GUI): clear it.
          channel.send('approval', CLEARED)
        }
        return
      }

      if (method === 'POST' && path === '/api/approval/respond') {
        const body = await readJson(req)
        const result = host.respondApproval({
          approvalId: String(body.approval_id ?? body.approvalId ?? ''),
          // No default: an empty/unknown choice must not become a grant.
          choice: String(body.choice ?? ''),
        })
        if (result?.stale === true) {
          // The prompt already resolved (answered elsewhere or timed out):
          // Hermex reads 409 {"stale":true} as "expired" and dismisses the card.
          sendJson(res, 409, { stale: true })
          return
        }
        if (result?.ok !== true) {
          // 200 {ok:false} keeps the card up and shows the message.
          sendJson(res, 200, { ok: false, error: result?.error ?? 'approval not accepted' })
          return
        }
        sendJson(res, 200, { ok: true, ...(result.choice === undefined ? {} : { choice: result.choice }) })
        return
      }

      if (method === 'GET' && path === '/api/clarify/pending') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const pending = host.pendingClarification?.(sessionId)
        sendJson(res, 200, { pending: pending ?? null, pending_count: pending ? 1 : 0 })
        return
      }

      if (method === 'GET' && path === '/api/clarify/stream') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const deliver = notice => {
          if (notice.sessionId !== sessionId) return
          if (notice.kind !== 'clarify' && notice.kind !== 'clarify-resolved') return
          const pending = host.pendingClarification?.(sessionId)
          channel.send('clarify', pending === undefined ? CLEARED : { pending })
        }
        const channel = openSse(res, { onClose: () => interactionChannels.delete(deliver) })
        interactionChannels.add(deliver)
        const pending = host.pendingClarification?.(sessionId)
        if (pending !== undefined) {
          // question/choices_offered travel with it so `initial` classifies as
          // a clarification instead of an approval card.
          channel.send('initial', { pending })
        } else {
          channel.send('clarify', CLEARED)
        }
        return
      }

      if (method === 'POST' && path === '/api/clarify/respond') {
        const body = await readJson(req)
        const result = host.respondClarification({
          clarifyId: String(body.clarify_id ?? body.clarifyId ?? ''),
          response: String(body.response ?? ''),
          sessionId: String(body.session_id ?? ''),
        })
        sendJson(res, 200, result.ok ? { ok: true } : { ok: false })
        return
      }

      if (method === 'GET' && path === '/api/models') {
        // A cold catalog queries every provider, which can outlast the client's
        // patience; answer with what we have instead of going silent.
        const catalog = await withDeadline(host.models(), READ_TIMEOUT_MS, 'model catalog').catch(error => {
          notes.error = String(error?.message ?? error)
          return {}
        })
        const groups = catalogGroups(catalog)
        const models = groups.flatMap(group => group.models)
        const selection = catalog?.default ?? {}
        sendJson(res, 200, {
          models,
          groups,
          default_model: String(selection.model ?? catalog?.defaultModel ?? models[0]?.id ?? ''),
          active_provider: String(selection.provider ?? catalog?.provider ?? ''),
        })
        return
      }

      // The picker's live overlay. The app re-reads this when a picker opens and
      // replaces the matching cached group's models with it, so it must use the
      // same group spelling /api/models does (provider id included) and echo
      // back the provider it resolved. There is no separate DSH "live" list:
      // the catalog cache is the freshest read the host has.
      if (method === 'GET' && path === '/api/models/live') {
        const catalog = await withDeadline(host.models(), READ_TIMEOUT_MS, 'live model catalog').catch(error => {
          notes.error = String(error?.message ?? error)
          return {}
        })
        const groups = catalogGroups(catalog)
        const selection = catalog?.default ?? {}
        const requested = (url.searchParams.get('provider') ?? '').trim()
        const active = String(selection.provider ?? catalog?.provider ?? '').trim()
        const provider = requested.length > 0 ? requested : (active.length > 0 ? active : String(groups[0]?.provider_id ?? ''))
        const group = groups.find(entry => entry.provider_id === provider)
        const models = group === undefined ? [] : group.models
        sendJson(res, 200, { provider, models, count: models.length })
        return
      }

      // Settings > Providers. DSH exposes provider groups (and isolated provider
      // failures) but no credential inventory here, so the list is derived from
      // the model catalog: a group means the provider is routable, which is the
      // question the screen answers ("what can I pick?").
      if (method === 'GET' && path === '/api/providers') {
        const catalog = await withDeadline(host.models(), READ_TIMEOUT_MS, 'provider catalog').catch(error => {
          notes.error = String(error?.message ?? error)
          return {}
        })
        const selection = catalog?.default ?? {}
        const providers = catalogGroups(catalog).map(group => ({
          id: group.provider_id,
          display_name: group.label,
          has_key: true,
          configurable: false,
          is_self_hosted: false,
          base_url: '',
          is_plugin_provider: false,
          is_oauth: false,
          is_custom: false,
          key_source: 'config',
          models: group.models,
          models_total: group.models.length,
        }))
        // A provider the catalog could not list is still configured; report it
        // with the host's own message instead of hiding it entirely.
        for (const failure of Array.isArray(catalog?.failures) ? catalog.failures : []) {
          const id = String(failure?.id ?? '')
          if (id.length === 0 || providers.some(provider => provider.id === id)) continue
          providers.push({
            id,
            display_name: String(failure?.name ?? id),
            has_key: false,
            configurable: false,
            is_self_hosted: false,
            base_url: '',
            is_plugin_provider: false,
            is_oauth: false,
            is_custom: false,
            key_source: 'none',
            auth_error: String(failure?.message ?? 'the host could not list this provider'),
            models: [],
            models_total: 0,
          })
        }
        sendJson(res, 200, {
          providers,
          active_provider: String(selection.provider ?? catalog?.provider ?? ''),
        })
        return
      }

      if (method === 'GET' && path === '/api/commands') {
        sendJson(res, 200, { commands: await host.commands() })
        return
      }

      if (method === 'GET' && path === '/api/workspaces') {
        const value = await withDeadline(host.workspaces(), READ_TIMEOUT_MS, 'workspace list').catch(error => {
          notes.error = String(error?.message ?? error)
          return { workspaces: [] }
        })
        sendJson(res, 200, { workspaces: value.workspaces, last: value.workspaces[0]?.path ?? '' })
        return
      }

      if (method === 'GET' && path === '/api/profiles') {
        sendJson(res, 200, {
          profiles: [{ name: 'default', label: 'default' }],
          active: 'default',
          single_profile_mode: true,
        })
        return
      }

      if (method === 'GET' && path === '/api/reasoning') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const queryModel = url.searchParams.get('model') ?? ''
        const queryProvider = url.searchParams.get('provider') ?? ''
        const state = await reasoningState(sessionId, {
          ...(queryModel.length > 0 ? { model: queryModel } : {}),
          ...(queryProvider.length > 0 ? { provider: queryProvider } : {}),
        })
        notes.effort = { mode: 'get', effort: state.effort, ...(state.model === undefined ? {} : { model: state.model }) }
        sendJson(res, 200, {
          ok: true,
          effort: state.effort,
          reasoning_effort: state.effort,
          effective_effort: state.effort,
          supported_efforts: state.supportedEfforts,
          supports_reasoning_effort: true,
          supports_thinking_toggle: true,
          show_reasoning: true,
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(state.provider === undefined ? {} : { provider: state.provider }),
        })
        return
      }

      if (method === 'POST' && path === '/api/reasoning') {
        const body = await readJson(req)
        const sessionId = String(body.session_id ?? '')
        if (typeof body.effort === 'string' && body.effort.length > 0) {
          if (sessionId.length === 0) {
            const state = await reasoningState('')
            notes.effort = { mode: 'set', requested: body.effort, error: 'session_id required' }
            logger.warn?.('hermes-facade: reasoning change without a session_id: ' + body.effort)
            sendJson(res, 200, {
              ok: false,
              error: 'session_id required',
              effort: state.effort,
              reasoning_effort: state.effort,
              effective_effort: state.effort,
              supported_efforts: state.supportedEfforts,
              supports_reasoning_effort: true,
            })
            return
          }
          try {
            const applied = await withDeadline(
              host.setReasoningEffort({ sessionId, effort: body.effort }),
              READ_TIMEOUT_MS,
              'reasoning change',
            )
            const effort = typeof applied?.effort === 'string' && applied.effort.length > 0 ? applied.effort : body.effort
            const supported = Array.isArray(applied?.supportedEfforts) && applied.supportedEfforts.length > 0
              ? applied.supportedEfforts.map(String)
              : await reasoningState(sessionId).then(state => state.supportedEfforts)
            notes.effort = { mode: 'set', requested: body.effort, applied: effort, ...(effort === body.effort ? {} : { coerced: true }) }
            sendJson(res, 200, {
              ok: true,
              effort,
              reasoning_effort: effort,
              effective_effort: effort,
              supported_efforts: supported,
              supports_reasoning_effort: true,
              ...(typeof applied?.model === 'string' ? { model: applied.model } : {}),
              ...(typeof applied?.provider === 'string' ? { provider: applied.provider } : {}),
            })
          } catch (error) {
            // 200 + ok:false is how this surface reports a refused action; the
            // app shows the message and keeps the picker usable.
            const message = String(error?.message ?? error)
            const state = await reasoningState(sessionId)
            notes.effort = { mode: 'set', requested: body.effort, error: message }
            logger.warn?.('hermes-facade: reasoning effort ' + JSON.stringify(body.effort) + ' for session ' + sessionId + ' failed: ' + message)
            sendJson(res, 200, {
              ok: false,
              error: message,
              effort: state.effort,
              reasoning_effort: state.effort,
              effective_effort: state.effort,
              supported_efforts: state.supportedEfforts,
              supports_reasoning_effort: true,
              ...(state.model === undefined ? {} : { model: state.model }),
              ...(state.provider === undefined ? {} : { provider: state.provider }),
            })
            notes.error = message
          }
          return
        }
        // Reasoning *display* toggle (show/hide thinking): nothing to persist.
        const state = await reasoningState(sessionId)
        sendJson(res, 200, {
          ok: true,
          show_reasoning: body.display !== 'hidden',
          supported_efforts: state.supportedEfforts,
          supports_reasoning_effort: true,
          effort: state.effort,
          reasoning_effort: state.effort,
          effective_effort: state.effort,
        })
        return
      }

      // DSH keeps its default model in configuration, not in a Remote: this is
      // an acknowledgement so the model sheet does not show an endpoint error.
      if (method === 'POST' && path === '/api/default-model') {
        const body = await readJson(req)
        notes.stub = 'default-model'
        logger.info?.('hermes-facade: default-model asked for ' + String(body.model ?? '') +
          ' (managed in dsh config; not persisted by the facade)')
        sendJson(res, 200, {
          ok: true,
          default_model: body.model ?? '',
          provider: body.provider ?? '',
          persisted: false,
          note: 'the default model lives in dsh configuration',
        })
        return
      }

      if (method === 'POST' && (path === '/api/profile/switch' || path === '/api/profile/create')) {
        notes.stub = 'profiles'
        sendJson(res, 200, { ok: false, error: 'Profiles are not supported by DeepSeek Harness' })
        return
      }

      if (method === 'POST' && path === '/api/personality/set') {
        notes.stub = 'personalities'
        sendJson(res, 200, { ok: false, error: 'Personalities are not supported by DeepSeek Harness' })
        return
      }

      // Workspace file browser: opening a project reads a directory listing, and
      // opening a file reads its text. Both were 404s, which the app renders as
      // "the server endpoint was not found".
      if (method === 'GET' && path === '/api/list') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const reference = url.searchParams.get('path') ?? ''
        let listing
        try {
          listing = await host.listDir(sessionId, reference)
        } catch (error) {
          notes.error = String(error?.message ?? error)
        }
        if (listing === undefined) {
          sendJson(res, 404, { error: 'not found', detail: 'directory not found', path: reference })
          return
        }
        sendJson(res, 200, listing)
        return
      }

      if (method === 'GET' && path === '/api/file') {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const reference = url.searchParams.get('path') ?? ''
        const maxBytesRaw = Number.parseInt(url.searchParams.get('max_bytes') ?? '', 10)
        const maxBytes = Number.isSafeInteger(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : undefined
        let file
        try {
          file = await host.readText(sessionId, reference, maxBytes === undefined ? undefined : { maxBytes })
        } catch (error) {
          notes.error = String(error?.message ?? error)
        }
        if (file === undefined) {
          sendJson(res, 404, { error: 'not found', detail: 'file not found', path: reference })
          return
        }
        sendJson(res, 200, file)
        return
      }

      if (method === 'GET' && (path === '/api/media' || path === '/api/file/raw')) {
        const sessionId = url.searchParams.get('session_id') ?? ''
        const reference = url.searchParams.get('path') ?? ''
        const file = await host.readMedia(sessionId, reference)
        if (file === undefined) {
          sendJson(res, 404, { error: 'not found', detail: 'file not found' })
          return
        }
        res.writeHead(200, {
          'content-type': file.contentType,
          'content-length': file.body.length,
          'cache-control': 'private, max-age=300',
        })
        res.end(file.body)
        return
      }

      if (method === 'GET' && path === '/api/projects') {
        const { workspaces } = await withDeadline(host.workspaces(), READ_TIMEOUT_MS, 'workspace list').catch(error => {
          notes.error = String(error?.message ?? error)
          return { workspaces: [] }
        })
        sendJson(res, 200, {
          projects: workspaces.map(workspace => ({
            project_id: workspace.id,
            name: workspace.name,
            color: null,
            created_at: null,
            session_count: (workspace.sessionIds ?? []).length,
          })),
        })
        return
      }

      // Usage/Insights: token and session aggregates from DSH's cached session
      // projections. DSH has no per-day ledger or price table, so a session's
      // cumulative tokens land on its last active day and cost stays absent.
      if (method === 'GET' && (path === '/api/analytics/usage' || path === '/api/analytics/models')) {
        const parsed = Number.parseInt(url.searchParams.get('days') ?? '', 10)
        const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 30
        const report = await host.usageReport(days)
        sendJson(res, 200, path.endsWith('/models') ? report.models : report.usage)
        return
      }
      // Skills: a read-only catalogue and SKILL.md from DSH's per-session
      // catalog. DSH has no disable primitive, so the toggle is refused.
      if (method === 'GET' && path === '/api/skills') {
        const rows = await host.listSkills()
        sendJson(res, 200, { skills: rows.map(skillRowOf) })
        return
      }
      if (method === 'GET' && path === '/api/skills/content') {
        const name = (url.searchParams.get('name') ?? '').trim()
        const detail = await host.readSkill(name)
        if (detail === null) { sendJson(res, 404, { detail: 'Skill not found.' }); return }
        sendJson(res, 200, detail)
        return
      }
      if ((method === 'PUT' || method === 'POST') && path === '/api/skills/toggle') {
        sendJson(res, 400, { detail: 'Skills cannot be disabled on this host: DSH has no skill toggle.' })
        return
      }
      // Screens DSH has no data for. Answer with an empty, well-formed payload
      // so the app renders an empty state instead of its 404 banner.
      const NEUTRAL = {
        '/api/projects': { projects: [] }, // replaced below by the live workspaces
        '/api/crons': { crons: [], jobs: [] },
        '/api/crons/recent': { runs: [] },
        '/api/insights': { days: [], totals: {}, sessions: [] },
        '/api/memory': { entries: [], memories: [] },
        '/api/kanban/boards': { boards: [] },
        '/api/kanban/config': {},
        '/api/settings': {},
        '/api/personalities': { personalities: [], active: null },
      }
      if (method === 'GET' && Object.hasOwn(NEUTRAL, path)) {
        notes.stub = 'neutral'
        sendJson(res, 200, NEUTRAL[path])
        return
      }
      if (path.startsWith('/api/git') || path.startsWith('/api/kanban')) {
        notes.stub = 'unsupported-domain'
        sendJson(res, 200, { ok: false, error: 'Not supported by DeepSeek Harness' })
        return
      }

      // Nothing else under /api is a 404 we want the app to see: a write that
      // DSH cannot satisfy answers 200 ok:false, so the sheet shows a message
      // instead of "the server endpoint was not found". The call is logged with
      // its body, because an unknown write is the hardest kind to diagnose.
      if (method === 'POST' && path.startsWith('/api/')) {
        let body
        try {
          body = await readJson(req)
        } catch { /* unreadable body is not a reason to hide the endpoint */ }
        noteUnknown('unsupported-write', { status: 200, body })
        sendJson(res, 200, { ok: false, error: 'Not supported by DeepSeek Harness', endpoint: path })
        return
      }

      noteUnknown('no-route', { status: 404 })
      sendJson(res, 404, { error: 'not found', detail: 'not found' })
    } catch (error) {
      const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500
      notes.error = String(error?.message ?? error)
      logger.warn?.('hermes-facade: ' + String(error?.stack ?? error))
      if (!res.headersSent) sendJson(res, status, { detail: String(error?.message ?? 'internal error') })
      else res.end()
    } finally {
      if (config.logRequests) {
        logger.info?.('hermes-facade: ' + (req.method ?? '') + ' ' + (req.url ?? '') + ' ' + String(Date.now() - started) + 'ms')
      }
    }
  }

  const server = createServer(handler)
  /** Additional listeners beyond the primary one (LAN / Tailscale addresses). */
  const extra = []

  /**
   * Addresses to bind in addition to the primary one.
   * @returns {string[]} host addresses.
   */
  function extraHosts() {
    const lanHost = config.lanHost
    if (lanHost === undefined) return []
    if (lanHost !== 'auto') return lanHost === config.bindHost ? [] : [lanHost]
    const hosts = []
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue
        if (String(entry.family) !== 'IPv4' && String(entry.family) !== '4') continue
        if (!hosts.includes(entry.address)) hosts.push(entry.address)
      }
    }
    return hosts.filter(host => host !== config.bindHost)
  }

  const facade = {
    server,
    auth: authService,
    registry,
    /** JSONL log writers; paths are useful in a bug report. */
    log: requestLog,
    paths: { access: requestLog.accessPath, unknown: requestLog.unknownPath },
    /**
     * Start listening.
     * @returns {Promise<{port: number, host: string}>} address.
     */
    async listen() {
      const hosts = [config.bindHost, ...extraHosts()]
      const addresses = []
      for (const host of hosts) {
        const instance = host === config.bindHost ? server : createServer(handler)
        const port = await new Promise((resolve, reject) => {
          instance.once('error', reject)
          instance.listen(config.port, host, () => {
            const bound = instance.address()
            resolve(bound !== null && typeof bound === 'object' ? bound.port : config.port)
          })
        })
        if (instance !== server) extra.push(instance)
        addresses.push({ host, port })
      }
      facade.addresses = addresses
      return addresses[0]
    },
    /**
     * Stop listening.
     * @returns {Promise<void>} resolves when closed.
     */
    close() {
      const instances = [server, ...extra]
      return Promise.all(instances.map(instance => new Promise(resolve => {
        instance.close(() => resolve())
        instance.closeAllConnections?.()
      }))).then(() => undefined)
    },
    /**
     * Expose epoch helper for tests.
     * @param {unknown} value input.
     * @returns {number|undefined} seconds.
     */
    epochSeconds,
  }

  return facade
}
