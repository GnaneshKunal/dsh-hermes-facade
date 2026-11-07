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
import { COOKIE_NAME, createAuth } from './auth.mjs'
import { clip, createRequestLog } from './log.mjs'
import { detailOf, epochSeconds, messagesOf, normaliseEvent, summaryOf } from './map.mjs'
import { openSse } from './sse.mjs'
import { createStreamRegistry } from './streams.mjs'

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

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

  const registry = createStreamRegistry()
  const loginAttempts = new Map()
  /** @type {Set<Function>} */
  const interactionChannels = new Set()

  host.setClientPredicate(sessionId => registry.forSession(sessionId) !== undefined)

  host.onInteraction?.(notice => {
    for (const deliver of interactionChannels) deliver(notice)
  })

  /**
   * Whether a request carries a valid session cookie.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} authenticated.
   */
  function isAuthed(req) {
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
   * Append one DSH frame to a chat stream, translated to Hermex SSE events.
   * @param {object} stream stream record.
   * @param {object} frame follow frame.
   * @returns {boolean} whether the turn ended on this frame.
   */
  function applyFrame(stream, frame) {
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
      case 'assistant/message':
        // Safety net: if the streaming frames never arrived (or used a chunk
        // type we do not know), still deliver the settled text exactly once.
        if (typeof event.data.text === 'string' && event.data.text.length > 0 && (stream.emittedText ?? 0) === 0) {
          stream.emittedText = event.data.text.length
          registry.publish(stream, 'token', { text: event.data.text })
        }
        return false
      case 'session/title':
        if (typeof event.data.title === 'string') {
          registry.publish(stream, 'title', { session_id: stream.sessionId, title: event.data.title })
        }
        return false
      case 'turn/end':
        registry.publish(stream, 'done', { usage: {}, session: { session_id: stream.sessionId } })
        registry.publish(stream, 'stream_end', {})
        registry.finish(stream, 'completed')
        return true
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
        ended = applyFrame(stream, frame)
        if (ended) break
      }
      if (!ended && stream.terminal === null) {
        registry.publish(stream, 'done', { usage: {}, session: { session_id: stream.sessionId } })
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
        sendJson(res, 200, { status: 'ok' })
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

      if (method === 'GET' && path === '/api/sessions') {
        const items = await host.listSessions()
        const index = typeof host.workspaceIndex === 'function' ? await host.workspaceIndex() : new Map()
        sendJson(res, 200, {
          sessions: items.map(item => summaryOf(item, index.get(String(item?.sessionId)))),
          cli_count: 0,
          archived_count: 0,
          server_time: Math.floor(Date.now() / 1000),
          server_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        return
      }

      if (method === 'GET' && path === '/api/session') {
        const sessionId = url.searchParams.get('session_id') ?? url.searchParams.get('sessionId') ?? ''
        if (!sessionId) { sendJson(res, 400, { detail: 'session_id required' }); return }
        const limitText = url.searchParams.get('msg_limit') ?? url.searchParams.get('message_limit')
        const limit = Number.parseInt(limitText ?? '', 10)
        const snapshot = await host.readSession(sessionId, {
          maxMessages: Number.isSafeInteger(limit) && limit > 0 ? limit : 50,
        })
        const list = await host.listSessions()
        const item = list.find(row => String(row?.sessionId) === sessionId)
        if (item === undefined && snapshot.events.length === 0) {
          sendJson(res, 404, { error: 'not found', detail: 'Session not found' })
          return
        }
        const messages = messagesOf(snapshot.events)
        const index = typeof host.workspaceIndex === 'function' ? await host.workspaceIndex() : new Map()
        sendJson(res, 200, { session: detailOf(item ?? { sessionId }, messages, index.get(String(sessionId))) })
        return
      }

      if (method === 'POST' && path === '/api/session/new') {
        const body = await readJson(req)
        const workspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : defaultWorkspacePath()
        const projectId = typeof body.project_id === 'string' && body.project_id.length > 0 ? body.project_id : undefined
        const created = await host.ensureSession(undefined, workspace, projectId)
        const rows = await host.listSessions()
        const item = rows.find(entry => String(entry?.sessionId) === created)
        const index = typeof host.workspaceIndex === 'function' ? await host.workspaceIndex() : new Map()
        sendJson(res, 200, { session: detailOf(item ?? { sessionId: created }, [], index.get(String(created))) })
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

      // Actions DSH has no equivalent for: answer 200 with an honest error so
      // the app shows a message instead of "the server endpoint was not found".
      if (method === 'POST' && ['/api/session/delete', '/api/session/duplicate', '/api/session/compress', '/api/session/clear', '/api/session/undo', '/api/session/retry', '/api/session/truncate', '/api/session/move', '/api/session/update', '/api/session/export', '/api/session/import_cli'].includes(path)) {
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
        const channel = openSse(res, { onClose: () => interactionChannels.delete(deliver) })
        const deliver = notice => {
          if (notice.sessionId !== sessionId) return
          if (notice.kind === 'approval') channel.send('approval', { pending: notice.pending })
        }
        interactionChannels.add(deliver)
        const pending = host.pendingApproval?.(sessionId)
        if (pending !== undefined) channel.send('initial', { pending })
        return
      }

      if (method === 'POST' && path === '/api/approval/respond') {
        const body = await readJson(req)
        const result = host.respondApproval({
          approvalId: String(body.approval_id ?? body.approvalId ?? ''),
          choice: String(body.choice ?? 'once'),
        })
        sendJson(res, result.ok ? 200 : 200, result.ok ? { ok: true } : { ok: false })
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
        const channel = openSse(res, { onClose: () => interactionChannels.delete(deliver) })
        const deliver = notice => {
          if (notice.sessionId !== sessionId) return
          if (notice.kind === 'clarify') channel.send('clarify', { pending: notice.pending })
        }
        interactionChannels.add(deliver)
        const pending = host.pendingClarification?.(sessionId)
        if (pending !== undefined) channel.send('initial', { pending })
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
        const groups = []
        if (Array.isArray(catalog?.groups)) {
          for (const group of catalog.groups) {
            const entries = Array.isArray(group?.models)
              ? group.models.map(model => ({
                  id: String(model?.id ?? ''),
                  label: String(model?.name ?? model?.id ?? ''),
                })).filter(model => model.id.length > 0)
              : []
            if (entries.length > 0) {
              groups.push({
                name: String(group?.name ?? group?.id ?? 'default'),
                label: String(group?.name ?? group?.id ?? 'default'),
                models: entries,
              })
            }
          }
        }
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
        let file
        try {
          file = await host.readText(sessionId, reference)
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

      // Screens DSH has no data for. Answer with an empty, well-formed payload
      // so the app renders an empty state instead of its 404 banner.
      const NEUTRAL = {
        '/api/projects': { projects: [] }, // replaced below by the live workspaces
        '/api/crons': { crons: [], jobs: [] },
        '/api/crons/recent': { runs: [] },
        '/api/insights': { days: [], totals: {}, sessions: [] },
        '/api/memory': { entries: [], memories: [] },
        '/api/skills': { skills: [], enabled: [] },
        '/api/kanban/boards': { boards: [] },
        '/api/kanban/config': {},
        '/api/settings': {},
        '/api/personalities': { personalities: [], active: null },
        '/api/providers': { providers: [] },
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
