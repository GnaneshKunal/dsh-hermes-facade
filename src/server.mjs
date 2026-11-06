/**
 * The hermes-webui-shaped HTTP surface the Hermex client speaks.
 *
 * Bound to loopback on its own port. Nothing here touches dsh's :3080 origin:
 * that origin is published through Tailscale Funnel, and /api there is dsh's
 * own fenced RPC namespace.
 *
 * @module dsh-hermes-facade/src/server
 */

import { createServer } from 'node:http'
import { COOKIE_NAME, createAuth } from './auth.mjs'
import { detailOf, epochSeconds, messagesOf, normaliseEvent, summaryOf } from './map.mjs'
import { openSse } from './sse.mjs'
import { createStreamRegistry } from './streams.mjs'

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

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
    return value !== null && typeof value === 'object' ? value : {}
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
        const chunk = inner.chunk ?? {}
        if (chunk.type === 'text' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          registry.publish(stream, 'token', { text: chunk.text })
        } else if (chunk.type === 'reasoning' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          registry.publish(stream, 'reasoning', { text: chunk.text })
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

  const server = createServer(async (req, res) => {
    const started = Date.now()
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'
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
        sendJson(res, 200, {
          sessions: items.map(summaryOf),
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
        sendJson(res, 200, { session: detailOf(item ?? { sessionId }, messages) })
        return
      }

      if (method === 'POST' && path === '/api/chat/start') {
        const body = await readJson(req)
        const text = typeof body.message === 'string' ? body.message : ''
        if (text.length === 0) { sendJson(res, 400, { detail: 'message required' }); return }
        let sessionId = typeof body.session_id === 'string' && body.session_id.length > 0 ? body.session_id : undefined
        if (sessionId === undefined) sessionId = await host.ensureSession()
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
        const catalog = await host.models()
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
        const value = await host.workspaces()
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
        sendJson(res, 200, {
          effective_effort: 'medium',
          reasoning_effort: 'medium',
          supported_efforts: ['off', 'low', 'medium', 'high'],
          supports_reasoning_effort: true,
        })
        return
      }

      sendJson(res, 404, { error: 'not found', detail: 'not found' })
    } catch (error) {
      const status = Number.isSafeInteger(error?.statusCode) ? error.statusCode : 500
      logger.warn?.('hermes-facade: ' + String(error?.stack ?? error))
      if (!res.headersSent) sendJson(res, status, { detail: String(error?.message ?? 'internal error') })
      else res.end()
    } finally {
      if (config.logRequests) {
        logger.info?.('hermes-facade: ' + (req.method ?? '') + ' ' + (req.url ?? '') + ' ' + String(Date.now() - started) + 'ms')
      }
    }
  })

  return {
    server,
    auth: authService,
    registry,
    /**
     * Start listening.
     * @returns {Promise<{port: number, host: string}>} address.
     */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.bindHost, () => {
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : config.port, host: config.bindHost })
        })
      })
    },
    /**
     * Stop listening.
     * @returns {Promise<void>} resolves when closed.
     */
    close() {
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
    /**
     * Expose epoch helper for tests.
     * @param {unknown} value input.
     * @returns {number|undefined} seconds.
     */
    epochSeconds,
  }
}
