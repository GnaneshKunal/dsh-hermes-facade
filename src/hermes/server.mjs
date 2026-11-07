/**
 * The Hermes-protocol listener.
 *
 * This is a second, independent port that speaks what the Hermes dashboard
 * speaks: a public /api/status, cookie auth plus a single-use websocket ticket,
 * a JSON-RPC socket (including server-to-client approval and clarify requests),
 * and the REST session surface. Every answer is produced by the webui facade on
 * its own port, reached over loopback with the internal token, so DSH stays
 * integrated in exactly one place.
 *
 * @module dsh-hermes-facade/src/hermes/server
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

import { createBackend } from './backend.mjs'
import { createEventHub } from './events.mjs'
import { createMethods } from './methods.mjs'
import {
  COOKIE_AT,
  COOKIE_PROVIDER,
  COOKIE_RT,
  ensureInstallId,
  meBody,
  profilesActiveBody,
  readCookie,
  sessionCookies,
  statusBody,
  TICKET_TTL_SECONDS,
  createTicketStore,
} from './protocol.mjs'
import { commandsOf, modelOptionsOf, sessionRowOf, transcriptRowOf } from './shapes.mjs'
import { createTurnRunner } from './turn.mjs'
import { acceptUpgrade } from './ws.mjs'

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Send a JSON answer.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {object} body body.
 * @param {object} [headers] extra headers.
 * @returns {void}
 */
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {Promise<object>} parsed body or {}.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Build the gateway.
 * @param {object} options options.
 * @param {object} options.config resolved facade config.
 * @param {string} options.facadeUrl facade origin, for example http://127.0.0.1:9120.
 * @param {object} options.facadeAuth the facade's auth surface (password + cookies).
 * @param {object} [options.logger] logger.
 * @returns {object} gateway.
 */
export function createGatewayServer({ config, facadeUrl, facadeAuth, logger = console }) {
  const installId = ensureInstallId(config.dir)
  const replayEpoch = randomUUID()
  const tickets = createTicketStore({ ttlSeconds: TICKET_TTL_SECONDS })
  const backend = createBackend({ baseUrl: facadeUrl, token: config.internalToken })
  const hub = createEventHub({ epochOf: () => replayEpoch })
  const connections = new Set()

  /**
   * Reverse requests: one JSON-RPC request to every socket, first answer wins.
   * @returns {object} manager.
   */
  function createRequestManager() {
    const pending = new Map()
    let counter = 0

    /**
     * Ask the clients one question.
     * @param {string} method approval or clarify.
     * @param {object} params params.
     * @param {object} [options] options.
     * @returns {Promise<object|null>} the answer, or null when withdrawn.
     */
    function call(method, params, options = {}) {
      if (connections.size === 0) return Promise.resolve(null)
      const id = 'srv-' + (++counter) + '-' + randomUUID().slice(0, 8)
      const frame = { jsonrpc: '2.0', id, method, params }
      for (const connection of connections) {
        try { connection.sendJson(frame) } catch { connections.delete(connection) }
      }
      return new Promise(resolve => {
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000
        const entry = { sessionId: options.sessionId, keys: [id] }
        const settle = value => {
          clearTimeout(timer)
          for (const key of entry.keys) pending.delete(key)
          resolve(value)
        }
        const timer = setTimeout(() => {
          for (const key of entry.keys) pending.delete(key)
          hub.publish('request.cancel', { request_id: id, reason: 'timeout' }, options.sessionId)
          resolve(null)
        }, timeoutMs)
        timer.unref?.()
        entry.resolve = settle
        pending.set(id, entry)
        // The client answers an approval or a clarification by the id in its
        // params (the queue id), not by the envelope id, so both must address
        // the same pending entry.
        const answerId = params !== null && typeof params === 'object' ? params.request_id : undefined
        if (typeof answerId === 'string' && answerId.length > 0 && answerId !== id) {
          entry.keys.push(answerId)
          pending.set(answerId, entry)
        }
      })
    }

    /**
     * Settle one pending request.
     * @param {string} id request id.
     * @param {object} value answer.
     * @returns {boolean} whether it was pending.
     */
    function resolve(id, value) {
      const entry = pending.get(String(id))
      if (entry === undefined) return false
      entry.resolve(value)
      return true
    }

    /**
     * Withdraw every request for one session (its turn ended or the prompt was
     * retracted by the facade).
     * @param {string} sessionId session id.
     * @returns {void}
     */
    function cancelSession(sessionId) {
      const seen = new Set()
      for (const [id, entry] of [...pending]) {
        if (entry.sessionId !== sessionId || seen.has(entry)) continue
        seen.add(entry)
        entry.resolve(null)
        hub.publish('request.cancel', { request_id: id, reason: 'cancelled' }, sessionId)
      }
    }

    return { call, resolve, cancelSession, pending }
  }

  const requests = createRequestManager()
  requests.call.cancelSession = sessionId => requests.cancelSession(sessionId)

  const runner = createTurnRunner({
    backend,
    hub,
    requestClient: requests.call,
    logger,
  })
  const methods = createMethods({ backend, hub, runner, requests, logger })

  /** Password attempts per address, for the login rate limit. */
  const attempts = new Map()

  /**
   * Whether a login may be attempted from this address.
   * @param {string} address peer address.
   * @returns {boolean} allowed.
   */
  function loginAllowed(address) {
    const entry = attempts.get(address)
    if (entry === undefined) return true
    if (Date.now() - entry.first > 15 * 60 * 1000) { attempts.delete(address); return true }
    return entry.count < 5
  }

  /**
   * Record one failed login.
   * @param {string} address peer address.
   * @returns {void}
   */
  function noteFailure(address) {
    const now = Date.now()
    const entry = attempts.get(address)
    if (entry === undefined || now - entry.first > 15 * 60 * 1000) attempts.set(address, { first: now, count: 1 })
    else entry.count += 1
  }

  /**
   * Whether a request carries the signed-in cookie.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} signed in.
   */
  function isAuthed(req) {
    return facadeAuth.verifyCookie(readCookie(req, COOKIE_AT))
  }

  /**
   * Whether the connection arrived over TLS (a tailscale serve proxy says so).
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {boolean} secure.
   */
  function isSecure(req) {
    return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
  }

  /**
   * Answer a login.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {Promise<void>} resolves when answered.
   */
  async function login(req, res) {
    const address = req.socket?.remoteAddress ?? 'unknown'
    if (!loginAllowed(address)) { sendJson(res, 429, { detail: 'Too many attempts' }); return }
    const body = await readJson(req)
    if (facadeAuth.verifyPassword(body.password) !== true) {
      noteFailure(address)
      sendJson(res, 401, { detail: 'Unauthorized' })
      return
    }
    attempts.delete(address)
    const maxAge = config.tokenTtlSeconds
    const cookie = facadeAuth.issueCookie()
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': sessionCookies({ at: cookie, rt: cookie, maxAge, secure: isSecure(req) }),
    })
    res.end(JSON.stringify({ ok: true, next: '/' }))
  }

  /**
   * The session page for GET /api/sessions.
   * @param {URL} url request url.
   * @returns {Promise<object>} body.
   */
  async function sessionPage(url) {
    const archived = url.searchParams.get('archived') ?? 'exclude'
    const order = url.searchParams.get('order') ?? 'recent'
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 0), 100)
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
    if (url.searchParams.get('scheduled') === '1' || (url.searchParams.get('sources') ?? '').includes('cron')) {
      return { sessions: [], total: 0, limit, offset, storage: {} }
    }
    const reply = await backend.call('GET', '/api/sessions', { query: { include_archived: 1 } })
    if (reply.status !== 200) throw new Error('session list failed (HTTP ' + reply.status + ')')
    let rows = Array.isArray(reply.json?.sessions) ? reply.json.sessions : []
    if (archived === 'exclude') rows = rows.filter(row => row.archived !== true)
    else if (archived === 'only') rows = rows.filter(row => row.archived === true)
    if (order === 'created') {
      rows = [...rows].sort((left, right) => Number(left.created_at ?? 0) - Number(right.created_at ?? 0))
    } else {
      rows = [...rows].sort((left, right) =>
        Number(right.last_message_at ?? right.updated_at ?? 0) - Number(left.last_message_at ?? left.updated_at ?? 0))
    }
    const total = rows.length
    return {
      sessions: rows.slice(offset, offset + limit).map(sessionRowOf),
      total,
      limit,
      offset,
      storage: {},
    }
  }

  /**
   * One page of a session's transcript.
   * @param {string} sessionId session id.
   * @param {URL} url request url.
   * @returns {Promise<object|null>} body, or null when the session is unknown.
   */
  async function messagePage(sessionId, url) {
    const order = url.searchParams.get('order') === 'oldest' ? 'oldest' : 'latest'
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 500)
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
    const reply = await backend.call('GET', '/api/session', {
      query: { session_id: sessionId, msg_limit: config.historyWindow },
    })
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new Error('session read failed (HTTP ' + reply.status + ')')
    const messages = Array.isArray(reply.json?.session?.messages) ? reply.json.session.messages : []
    const slice = order === 'latest'
      ? messages.slice(Math.max(0, messages.length - offset - limit), Math.max(0, messages.length - offset))
      : messages.slice(offset, offset + limit)
    return {
      session_id: sessionId,
      profile: 'default',
      messages: slice.map(transcriptRowOf),
      pagination: { limit, offset, order, returned: slice.length },
    }
  }

  /**
   * One session row for GET /api/sessions/{id}.
   * @param {string} sessionId session id.
   * @returns {Promise<object|null>} row, or null.
   */
  async function sessionRow(sessionId) {
    const reply = await backend.call('GET', '/api/session', { query: { session_id: sessionId, msg_limit: 1 } })
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new Error('session read failed (HTTP ' + reply.status + ')')
    const detail = reply.json?.session
    if (detail === null || typeof detail !== 'object') return null
    return sessionRowOf(detail)
  }

  /**
   * Apply one PATCH to a session through the facade's webui routes.
   * @param {string} sessionId session id.
   * @param {object} body patch body.
   * @returns {Promise<object>} reply body.
   */
  async function patchSession(sessionId, body) {
    const base = { session_id: sessionId }
    if (typeof body.title === 'string' && body.title.length > 0) {
      const reply = await backend.call('POST', '/api/session/rename', { body: { ...base, title: body.title } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'rename refused')
      return { title: body.title }
    }
    if (typeof body.pinned === 'boolean') {
      const reply = await backend.call('POST', '/api/session/pin', { body: { ...base, pinned: body.pinned } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'pin refused')
      return { pinned: body.pinned }
    }
    if (typeof body.archived === 'boolean') {
      const reply = await backend.call('POST', '/api/session/archive', { body: { ...base, archived: body.archived } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'archive refused')
      return { archived: body.archived }
    }
    return { ok: true }
  }

  /**
   * Route one HTTP request.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {Promise<void>} resolves when answered.
   */
  async function handle(req, res) {
    let url
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { sendJson(res, 400, { detail: 'Bad request' }); return }
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && (path === '/api/health' || path === '/health')) {
      sendJson(res, 200, { status: 'ok', version: '0.22.5' })
      return
    }
    if (method === 'GET' && path === '/api/status') {
      sendJson(res, 200, statusBody({ installId, activeSessions: runner.active.size }))
      return
    }
    if (method === 'POST' && path === '/auth/password-login') {
      await login(req, res)
      return
    }
    if (method === 'POST' && path === '/auth/logout') {
      res.writeHead(302, {
        location: '/login',
        'set-cookie': [COOKIE_AT + '=; Path=/; Max-Age=0', COOKIE_RT + '=; Path=/; Max-Age=0', COOKIE_PROVIDER + '=; Path=/; Max-Age=0'],
      })
      res.end()
      return
    }
    if (!isAuthed(req)) { sendJson(res, 401, { detail: 'Unauthorized' }); return }

    if (method === 'GET' && path === '/api/auth/me') {
      sendJson(res, 200, meBody(Math.floor(Date.now() / 1000) + config.tokenTtlSeconds))
      return
    }
    if (method === 'POST' && path === '/api/auth/ws-ticket') {
      sendJson(res, 200, tickets.issue())
      return
    }
    if (method === 'GET' && path === '/api/auth/providers') {
      sendJson(res, 200, { providers: ['basic'], basic: { enabled: true } })
      return
    }
    if (method === 'GET' && path === '/api/profiles/active') {
      sendJson(res, 200, profilesActiveBody())
      return
    }
    if (method === 'GET' && path === '/api/profiles') {
      sendJson(res, 200, { profiles: [profilesActiveBody().active], active: 'default' })
      return
    }
    if (method === 'GET' && path === '/api/config') {
      sendJson(res, 200, { platform_hints: {}, profile: 'default' })
      return
    }
    if (method === 'GET' && path === '/api/models') {
      const reply = await backend.call('GET', '/api/models')
      sendJson(res, 200, modelOptionsOf(reply.json ?? {}))
      return
    }
    if (method === 'GET' && path === '/api/commands') {
      const reply = await backend.call('GET', '/api/commands')
      sendJson(res, 200, commandsOf(reply.json ?? {}))
      return
    }
    if (method === 'GET' && path === '/api/sessions') {
      sendJson(res, 200, await sessionPage(url))
      return
    }
    if (method === 'POST' && path === '/api/sessions/import') {
      sendJson(res, 400, { detail: 'Session import is not supported by DeepSeek Harness' })
      return
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path)
    if (method === 'GET' && messagesMatch !== null) {
      const body = await messagePage(decodeURIComponent(messagesMatch[1]), url)
      if (body === null) { sendJson(res, 404, { detail: 'Session not found' }); return }
      sendJson(res, 200, body)
      return
    }
    const exportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(path)
    if (method === 'GET' && exportMatch !== null) {
      const sessionId = decodeURIComponent(exportMatch[1])
      const reply = await backend.call('GET', '/api/session/export', {
        query: { session_id: sessionId, format: url.searchParams.get('format') ?? 'json' },
        accept: '*/*',
      })
      if (reply.status !== 200) { sendJson(res, reply.status, { detail: 'Export failed' }); return }
      res.writeHead(200, {
        'content-type': reply.headers.get('content-type') ?? 'application/json',
        'content-disposition': reply.headers.get('content-disposition') ?? 'attachment; filename="hermes-' + sessionId + '.json"',
        'content-length': Buffer.byteLength(reply.text),
      })
      res.end(reply.text)
      return
    }
    const rowMatch = /^\/api\/sessions\/([^/]+)$/.exec(path)
    if (rowMatch !== null) {
      const sessionId = decodeURIComponent(rowMatch[1])
      if (method === 'GET') {
        const row = await sessionRow(sessionId)
        if (row === null) { sendJson(res, 404, { detail: 'Session not found' }); return }
        sendJson(res, 200, row)
        return
      }
      if (method === 'PATCH') {
        const body = await readJson(req)
        try {
          sendJson(res, 200, await patchSession(sessionId, body))
        } catch (error) {
          sendJson(res, 400, { detail: String(error?.message ?? error) })
        }
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 400, { detail: 'Session delete is not supported by DeepSeek Harness' })
        return
      }
    }

    sendJson(res, 404, { detail: 'Not Found' })
  }

  /**
   * Build one HTTP listener with the shared handlers.
   * @returns {import('node:http').Server} server.
   */
  function makeServer() {
    const instance = createServer((req, res) => {
      void handle(req, res).catch(error => {
        logger.warn?.('hermes-gateway: ' + String(error?.stack ?? error))
        try { sendJson(res, 500, { detail: 'Internal error' }) } catch { /* answered */ }
      })
    })
    instance.on('upgrade', onUpgrade)
    return instance
  }

  /**
   * Handle one WebSocket upgrade.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:net').Socket} socket raw socket.
   * @param {Buffer} head bytes past the request head.
   * @returns {void}
   */
  function onUpgrade(req, socket, head) {
    const connection = acceptUpgrade(req, socket, head, {
      authorize: ticket => tickets.redeem(ticket),
      rejectStatus: 401,
    })
    if (connection === undefined) return
    connections.add(connection)
    hub.attach(connection)
    connection.on('close', () => connections.delete(connection))
    connection.sendJson({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'gateway.ready',
        seq: 0,
        payload: {
          replay_epoch: replayEpoch,
          session_authority: false,
          protocol: 'hermes-gateway-v1',
          server_version: '0.22.5',
        },
      },
    })
    connection.on('message', text => { void onFrame(connection, text) })
  }

  const server = makeServer()

  /**
   * Handle one inbound socket frame.
   * @param {object} connection websocket connection.
   * @param {string} text frame text.
   * @returns {Promise<void>} resolves once answered.
   */
  async function onFrame(connection, text) {
    let frame
    try { frame = JSON.parse(text) } catch { return }
    if (frame === null || typeof frame !== 'object') return
    // A JSON-RPC response to a server-to-client request.
    if (typeof frame.method !== 'string') {
      if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
        requests.resolve(String(frame.id), frame.result ?? null)
      }
      return
    }
    if (frame.id === undefined) return
    try {
      const result = await methods.dispatch(frame.method, frame.params ?? {})
      connection.sendJson({ jsonrpc: '2.0', id: frame.id, result })
    } catch (error) {
      connection.sendJson({
        jsonrpc: '2.0',
        id: frame.id,
        error: {
          code: Number.isInteger(error?.rpcCode) ? error.rpcCode : -32000,
          message: String(error?.message ?? error),
        },
      })
    }
  }

  const activeServers = []

  const gateway = {
    installId,
    replayEpoch,
    hub,
    runner,
    methods,
    requests,
    backend,
    /**
     * Start listening.
     * @returns {Promise<{host: string, port: number}>} bound address.
     */
    async listen() {
      const hosts = [config.gatewayBindHost]
      if (config.gatewayLanHost === 'auto') {
        for (const entries of Object.values(networkInterfaces())) {
          for (const entry of entries ?? []) {
            if (entry.internal) continue
            if (String(entry.family) !== 'IPv4' && String(entry.family) !== '4') continue
            if (!hosts.includes(entry.address)) hosts.push(entry.address)
          }
        }
      } else if (typeof config.gatewayLanHost === 'string' && !hosts.includes(config.gatewayLanHost)) {
        hosts.push(config.gatewayLanHost)
      }
      let first
      for (const host of hosts) {
        const instance = host === config.gatewayBindHost ? server : makeServer()
        const port = await new Promise((resolve, reject) => {
          instance.once('error', reject)
          instance.listen(config.gatewayPort, host, () => {
            const bound = instance.address()
            resolve(bound !== null && typeof bound === 'object' ? bound.port : config.gatewayPort)
          })
        })
        activeServers.push(instance)
        if (first === undefined) first = { host, port }
      }
      return first
    },
    /**
     * Stop listening and drop every connection.
     * @returns {Promise<void>} resolves when closed.
     */
    close() {
      runner.dispose()
      for (const connection of connections) {
        try { connection.close(1001, 'server stopping') } catch { /* already gone */ }
      }
      connections.clear()
      return Promise.all(activeServers.map(instance => new Promise(resolve => {
        instance.close(() => resolve())
        instance.closeAllConnections?.()
      }))).then(() => undefined)
    },
    /** Session ids with a turn running. */
    get activeSessions() { return runner.active.size },
  }

  return gateway
}
