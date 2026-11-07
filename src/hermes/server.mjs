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
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'

import { createBackend } from './backend.mjs'
import { createFileRoutes } from './files.mjs'
import { createPathFence } from './fence.mjs'
import {
  branches, commitContext, commitRepo, fileDiff, findGitRoot, GitRefusal, pushRepo,
  repoStatus, revertFile, revParse, reviewDiff, reviewList, stageFile, switchBranch, unstageFile,
} from './git.mjs'
import { createEventHub } from './events.mjs'
import { createMethods } from './methods.mjs'
import { decodeUpload, sanitizeUploadName } from './uploads.mjs'
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
import { createSessionRegistry } from './sessions.mjs'
import { commandsOf, latestTranscriptWindow, modelOptionsOf, sessionRowOf, transcriptRowOf } from './shapes.mjs'
import { createTurnRunner } from './turn.mjs'
import { acceptUpgrade } from './ws.mjs'

/** Largest accepted JSON body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * The memory section a managed file path addresses, if any. Only the two
 * paths the Memory screen asks for are served; everything else is a 404.
 * @param {string} requested client path.
 * @returns {'memory'|'user'|null} section.
 */
function memoryKindOf(requested) {
  const parts = String(requested ?? '').split('/')
  if (parts.length < 2 || parts[parts.length - 2] !== 'memories') return null
  const file = parts[parts.length - 1]
  if (file === 'MEMORY.md') return 'memory'
  if (file === 'USER.md') return 'user'
  return null
}

/**
 * The global AGENTS.md, or null when it does not exist.
 * @param {string} home DSH home.
 * @returns {Promise<string|null>} text.
 */
async function readMemoryText(home) {
  try {
    return await readFile(join(home, 'AGENTS.md'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}


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
async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('body too large')
      error.statusCode = 413
      throw error
    }
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
export function createGatewayServer({ config, facadeUrl, facadeAuth, memoryHome: memoryHomeOverride, uploadsDir, logger = console }) {
  /** Absolute uploads root shared by image-upload and file.attach. */
  const uploads = uploadsDir ?? join(homedir(), '.hermes-uploads')
  const installId = ensureInstallId(config.dir)
  const replayEpoch = randomUUID()
  const tickets = createTicketStore({ ttlSeconds: TICKET_TTL_SECONDS })
  const backend = createBackend({ baseUrl: facadeUrl, token: config.internalToken })
  const hub = createEventHub({ epochOf: () => replayEpoch })
  const connections = new Set()

  /**
   * Sockets that advertised `client.capabilities {server_requests:true}`.
   *
   * The contract only sends approval/clarify to such a client; a socket that
   * never advertised must not receive a question it did not offer to answer.
   * It can still learn about open requests from session.resume /
   * session.events.since (`open_requests`) and answer them.
   *
   * @type {WeakSet<object>}
   */
  const serverRequests = new WeakSet()

  /**
   * Reverse requests: one JSON-RPC request to every socket, first answer wins.
   *
   * A request is registered whether or not a socket is connected. A phone that
   * left mid-turn reattaches and restores the card from session.resume /
   * session.events.since (open_requests) instead of leaving the turn blocked
   * until the request times out. The withdrawal frame is the host's
   * {id, method, reason} -- not {request_id} -- because that is what the client
   * matches on.
   *
   * @returns {object} manager.
   */
  function createRequestManager() {
    /** id and answer id -> entry. */
    const pending = new Map()
    /** envelope id -> entry, for open_requests and replay. */
    const open = new Map()
    let counter = 0

    /**
     * Publish the host's withdrawal frame.
     * @param {object} entry request entry.
     * @param {string} reason interrupted|resolved|timeout.
     * @returns {void}
     */
    function emitCancel(entry, reason) {
      hub.publish('request.cancel', { id: entry.id, method: entry.method, reason }, entry.sessionId)
    }

    /**
     * Settle one entry exactly once.
     * @param {object} entry request entry.
     * @param {object|null} value answer.
     * @returns {boolean} whether this call settled it.
     */
    function settle(entry, value) {
      if (entry.settled === true) return false
      entry.settled = true
      clearTimeout(entry.timer)
      for (const key of entry.keys) pending.delete(key)
      open.delete(entry.id)
      entry.resolve(value)
      return true
    }

    /**
     * Ask the clients one question.
     * @param {string} method approval or clarify.
     * @param {object} params params.
     * @param {object} [options] options.
     * @returns {Promise<object|null>} the answer, or null when withdrawn.
     */
    function call(method, params, options = {}) {
      const id = 'srv-' + (++counter) + '-' + randomUUID().slice(0, 8)
      const frame = { jsonrpc: '2.0', id, method, params }
      let release
      const answer = new Promise(resolve => { release = resolve })
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000
      const entry = {
        id,
        method,
        params,
        sessionId: options.sessionId,
        keys: [id],
        settled: false,
        resolve: release,
      }
      entry.timer = setTimeout(() => {
        if (settle(entry, null)) emitCancel(entry, 'timeout')
      }, timeoutMs)
      entry.timer.unref?.()
      pending.set(id, entry)
      open.set(id, entry)
      // The client answers an approval or a clarification by the id in its
      // params (the queue id), not by the envelope id, so both must address
      // the same pending entry.
      const answerId = params !== null && typeof params === 'object' ? params.request_id : undefined
      if (typeof answerId === 'string' && answerId.length > 0 && answerId !== id) {
        entry.keys.push(answerId)
        pending.set(answerId, entry)
      }
      for (const connection of connections) {
        if (!serverRequests.has(connection)) continue
        try { connection.sendJson(frame) } catch { connections.delete(connection) }
      }
      return answer
    }

    /**
     * Settle one pending request.
     * @param {string} id envelope or answer id.
     * @param {object} value answer.
     * @param {string} [reason] withdrawal reason to emit.
     * @returns {boolean} whether it was pending.
     */
    function resolve(id, value, reason) {
      const entry = pending.get(String(id))
      if (entry === undefined) return false
      if (!settle(entry, value)) return false
      if (typeof reason === 'string') emitCancel(entry, reason)
      return true
    }

    /**
     * Withdraw every request of one session (its turn ended, was stopped, or the
     * facade retracted the prompt).
     * @param {string} sessionId session id.
     * @param {string} [reason] interrupted|resolved.
     * @returns {number} how many were open.
     */
    function cancelSession(sessionId, reason = 'interrupted') {
      let count = 0
      for (const entry of [...open.values()]) {
        if (entry.sessionId !== sessionId) continue
        if (!settle(entry, null)) continue
        emitCancel(entry, reason)
        count += 1
      }
      return count
    }

    /**
     * The session's unanswered requests, in the host's open_requests shape.
     * @param {string} sessionId session id.
     * @returns {object[]} rows.
     */
    function openFor(sessionId) {
      return [...open.values()]
        .filter(entry => entry.sessionId === sessionId)
        .map(entry => ({ id: entry.id, method: entry.method, params: entry.params }))
    }

    return { call, resolve, cancelSession, openFor, pending, open }
  }

  const requests = createRequestManager()
  requests.call.cancelSession = (sessionId, reason) => requests.cancelSession(sessionId, reason)

  const sessions = createSessionRegistry({ backend, dir: config.dir, logger })

  /**
   * Per-session revision counters for the client's write fence.
   *
   * Hermex reads GET /api/sessions/{id}/mutation-snapshot before every session
   * write and sends the revision back as expected_revision. A snapshot that
   * answers anything but 200 (or the host's "old server" 404 wording) makes the
   * write fail, which is why every rename/pin/archive from the list was refused
   * on :9121 before this route existed.
   *
   * The revision is seeded from the session's own activity timestamp, so a
   * restarted process still compares sensibly, and advanced by every write and
   * turn the gateway performs. A snapshot records the value it handed out, so
   * the following write compares equal.
   *
   * @type {Map<string, number>}
   */
  const revisions = new Map()

  /**
   * The revision to report for a session.
   * @param {string} sessionId client id.
   * @param {number} [seed] fallback epoch seconds.
   * @returns {number} revision.
   */
  function revisionOf(sessionId, seed = 0) {
    const base = Number.isFinite(seed) ? Math.floor(seed) : 0
    return Math.max(base, revisions.get(sessionId) ?? 0)
  }

  /**
   * Record one change to a session: the next write must carry the new revision.
   * @param {string} sessionId client id.
   * @returns {void}
   */
  function bumpRevision(sessionId) {
    revisions.set(String(sessionId), revisionOf(sessionId) + 1)
  }

  /**
   * Read and record a session's current revision.
   * @param {string} sessionId client id.
   * @returns {Promise<number>} revision.
   */
  async function sessionRevision(sessionId) {
    const draft = sessions.draft(sessionId)
    if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
      const revision = revisionOf(sessionId, draft.createdAt)
      revisions.set(sessionId, revision)
      return revision
    }
    let seed = 0
    try {
      const reply = await backend.call('GET', '/api/session', {
        query: { session_id: sessions.resolve(sessionId), msg_limit: 1 },
      })
      const detail = reply.json?.session
      if (reply.status === 200 && detail !== null && typeof detail === 'object') {
        const last = Number(detail.last_message_at ?? detail.updated_at)
        if (Number.isFinite(last)) seed = last
      }
    } catch { /* the fence is advisory when the read fails */ }
    const revision = revisionOf(sessionId, seed)
    revisions.set(sessionId, revision)
    return revision
  }

  const runner = createTurnRunner({
    backend,
    hub,
    requestClient: requests.call,
    resolveBackendSession: id => sessions.resolve(id),
    onSettled: id => bumpRevision(id),
    logger,
  })
  const methods = createMethods({ backend, hub, runner, requests, sessions, uploadsDir: uploads, bumpRevision, logger })

  /**
   * Directories the in-chat Files browser may read.
   *
   * The chat's folder is the boundary: DSH workspaces, the working folder of
   * every known session, and the folder a draft chat picked before its first
   * message. Hermex sends absolute host paths, so the fence is what turns "any
   * path the phone names" into "any path inside a folder this account chats in".
   * @returns {Promise<string[]>} roots.
   */
  async function fileRoots() {
    const roots = new Set()
    if (typeof config.defaultWorkspace === 'string' && config.defaultWorkspace.length > 0) {
      roots.add(config.defaultWorkspace)
    }
    try {
      const reply = await backend.call('GET', '/api/workspaces')
      for (const workspace of Array.isArray(reply.json?.workspaces) ? reply.json.workspaces : []) {
        if (typeof workspace?.path === 'string' && workspace.path.length > 0) roots.add(workspace.path)
      }
      if (typeof reply.json?.last === 'string' && reply.json.last.length > 0) roots.add(reply.json.last)
    } catch { /* the workspace list is advisory */ }
    try {
      const reply = await backend.call('GET', '/api/sessions', { query: { include_archived: 1 } })
      for (const row of Array.isArray(reply.json?.sessions) ? reply.json.sessions : []) {
        if (typeof row?.workspace === 'string' && row.workspace.length > 0) roots.add(row.workspace)
      }
    } catch { /* the session folders are advisory */ }
    for (const cwd of sessions.cwds()) roots.add(cwd)
    // Uploaded images/documents are readable by the app's preview and by the agent.
    roots.add(uploads)
    return [...roots]
  }

  // Never serve the facade's own state (internal token, password, drafts) or a
  // known secret directory, even if a workspace were created inside one.
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // The global AGENTS.md is the agent's memory. It lives in $DSH_HOME, which the
  // file fence denies to the in-chat Files browser, so Memory reads it here
  // through a path allowlist rather than through /api/fs/*.
  const memoryHome = memoryHomeOverride ?? dshHome
  // App uploads live outside the facade state (which is fenced off) and outside
  // $DSH_HOME, so the app's preview and the agent can read them by absolute path.
  const fence = createPathFence({
    deny: [
      config.dir,
      dshHome,
      join(homedir(), '.ssh'),
      join(homedir(), '.aws'),
      join(homedir(), '.gnupg'),
    ],
  })

  /**
   * A session's working folder, for resolving a relative MEDIA path before the
   * fence sees it.
   * @param {string} sessionId client id.
   * @returns {Promise<string|undefined>} folder.
   */
  async function sessionCwd(sessionId) {
    const id = String(sessionId ?? '')
    if (id.length === 0) return undefined
    const draft = sessions.draft(id)
    if (draft !== undefined && typeof draft.cwd === 'string' && draft.cwd.length > 0) return draft.cwd
    try {
      const reply = await backend.call('GET', '/api/session', {
        query: { session_id: sessions.resolve(id), msg_limit: 1 },
      })
      const workspace = reply.json?.session?.workspace
      if (typeof workspace === 'string' && workspace.length > 0) return workspace
    } catch { /* the folder is advisory */ }
    return undefined
  }

  const files = createFileRoutes({ backend, fence, rootsOf: fileRoots, cwdOf: sessionCwd })

  /**
   * The deny-root check for Git rows and files: the state dir, `$DSH_HOME` and
   * the usual secret directories stay unreadable even when a repository root
   * contains them (a home-level dotfiles repo, for example).
   * @param {string} target absolute path.
   * @returns {Promise<boolean>} denied.
   */
  const gitGuard = target => fence.isDenied(target)

  /**
   * Resolve the repository a Git route may read, from the client's absolute path.
   *
   * The Git menu resolves the root from a chat folder, then names that root on
   * every read — and the root is normally *above* the chat folder. So a path is
   * accepted when it is inside a chat folder, or when it is the repository root
   * of one (an ancestor of an allowed folder that really is a git top-level).
   * A credential file is never served, and the state/secret directories stay
   * denied.
   * @param {string} requested client path.
   * @returns {Promise<{cwd?: string, root?: string, status?: number, detail?: string}>} scope.
   */
  async function gitScope(requested) {
    const target = String(requested ?? '').trim()
    if (target.length === 0) return { status: 400, detail: 'path required' }
    if (!target.startsWith('/')) return { status: 400, detail: 'path must be absolute' }
    const roots = await fileRoots()
    const verdict = await fence.check(target, roots)
    if (verdict.ok === true) return { cwd: verdict.path, root: await findGitRoot(verdict.path) }
    if (verdict.missing === true) return { status: 404, detail: 'Path not found' }
    if (verdict.sensitive === true) return { status: 403, detail: 'Access to sensitive files is not allowed' }
    // The repository root above a chat folder is the Git surface's boundary.
    let real
    try { real = await realpath(target) } catch { return { status: 404, detail: 'Path not found' } }
    if (await fence.isDenied(real)) return { status: 403, detail: 'Path is outside the session workspace' }
    // Compare realpaths: a chat folder under /tmp is reached through /private on
    // macOS, and the root git reports is the real path.
    const resolvedRoots = await Promise.all(roots
      .filter(root => typeof root === 'string' && root.length > 0)
      .map(root => realpath(root).catch(() => resolve(root))))
    const ancestor = resolvedRoots.some(root => root !== real && root.startsWith(real + sep))
    if (!ancestor) return { status: 403, detail: 'Path is outside the session workspace' }
    const root = await findGitRoot(real)
    if (root === undefined || resolve(root) !== real) {
      return { status: 403, detail: 'Path is outside the session workspace' }
    }
    return { cwd: real, root }
  }

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
   * The address the login rate limit is keyed on.
   *
   * Behind `tailscale serve` every request arrives from loopback, so keying on
   * the peer alone let one device's failed attempts lock out every client. A
   * forwarded client is trusted only when the peer is loopback, so a direct
   * client cannot spoof its way around the limit.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {string} address.
   */
  function loginAddress(req) {
    const peer = req.socket?.remoteAddress ?? 'unknown'
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
    if (!loopback) return peer
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    return forwarded.length > 0 ? forwarded : peer
  }

  /**
   * Answer a login.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @returns {Promise<void>} resolves when answered.
   */
  async function login(req, res) {
    const address = loginAddress(req)
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
    // `?limit=0` is a legal page size (no rows); the old `|| 20` turned it into
    // the default. `sources` is CSV of source names, matched exactly, so a value
    // that merely contains "cron" no longer empties the whole list.
    const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 0), 100) : 20
    const parsedOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0
    const sources = (url.searchParams.get('sources') ?? '').split(',').map(value => value.trim()).filter(Boolean)
    if (url.searchParams.get('scheduled') === '1' || sources.includes('cron')) {
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
    // A chat the user has not sent in yet has no DSH session; its transcript is
    // empty rather than a 404, which the client would treat as a failed read.
    if (sessions.isDraft(sessionId) && sessions.resolve(sessionId) === sessionId) {
      return {
        session_id: sessionId,
        profile: 'default',
        messages: [],
        pagination: { limit: 0, offset: 0, order: 'latest', returned: 0 },
      }
    }
    const order = url.searchParams.get('order') === 'oldest' ? 'oldest' : 'latest'
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 500)
    const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
    const reply = await backend.call('GET', '/api/session', {
      query: { session_id: sessions.resolve(sessionId), msg_limit: config.historyWindow },
    })
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new Error('session read failed (HTTP ' + reply.status + ')')
    const messages = Array.isArray(reply.json?.session?.messages) ? reply.json.session.messages : []
    // A transcript page is the oldest-first window `limit` rows back from `offset`
    // rows before the newest, so the row ids stay stable while older pages load.
    // The newest page also reaches the closest visible row: a tool-only page gives
    // Hermex's history projection no anchor, which used to look like an empty chat.
    const end = order === 'latest' ? Math.max(0, messages.length - offset) : messages.length
    const start = order === 'latest' ? latestTranscriptWindow(messages, limit, offset).start : offset
    const slice = order === 'latest'
      ? messages.slice(start, end)
      : messages.slice(start, Math.min(start + limit, end))
    return {
      session_id: sessionId,
      profile: 'default',
      messages: slice.map((message, index) => transcriptRowOf(message, start + index)),
      pagination: { limit, offset, order, returned: slice.length },
    }
  }

  /**
   * One session row for GET /api/sessions/{id}.
   * @param {string} sessionId session id.
   * @returns {Promise<object|null>} row, or null.
   */
  async function sessionRow(sessionId) {
    const draft = sessions.draft(sessionId)
    if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
      return sessionRowOf({
        session_id: sessionId,
        message_count: 0,
        ...(typeof draft.cwd === 'string' ? { workspace: draft.cwd } : {}),
        ...(typeof draft.title === 'string' ? { title: draft.title } : {}),
        created_at: draft.createdAt,
      })
    }
    const reply = await backend.call('GET', '/api/session', {
      query: { session_id: sessions.resolve(sessionId), msg_limit: 1 },
    })
    if (reply.status === 404) return null
    if (reply.status !== 200) throw new Error('session read failed (HTTP ' + reply.status + ')')
    const detail = reply.json?.session
    if (detail === null || typeof detail !== 'object') return null
    return { ...sessionRowOf(detail), id: String(sessionId) }
  }

  /**
   * The mutation snapshot a client reads before writing a session.
   * @param {string} sessionId client id.
   * @returns {Promise<object>} snapshot body.
   */
  async function mutationSnapshot(sessionId) {
    const draft = sessions.draft(sessionId)
    if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
      const revision = revisionOf(sessionId, draft.createdAt)
      revisions.set(sessionId, revision)
      return { session_id: sessionId, exists: true, runtime_revision: revision }
    }
    const reply = await backend.call('GET', '/api/session', {
      query: { session_id: sessions.resolve(sessionId), msg_limit: 1 },
    })
    const detail = reply.json?.session
    if (reply.status === 404 || detail === null || typeof detail !== 'object') {
      // The client reads exists:false as a 404 of its own; answering a made-up
      // revision would let it write to a session that is not there.
      return { session_id: sessionId, exists: false, runtime_revision: 0 }
    }
    const last = Number(detail.last_message_at ?? detail.updated_at)
    const revision = revisionOf(sessionId, Number.isFinite(last) ? last : 0)
    revisions.set(sessionId, revision)
    return { session_id: sessionId, exists: true, runtime_revision: revision }
  }

  /**
   * The write identity a PATCH may carry, and its error when only half is sent.
   * @param {object} body PATCH body.
   * @returns {{expectedRevision?: number, error?: string}} identity.
   */
  function writeIdentityOf(body) {
    const hasRequest = typeof body?.request_id === 'string' && body.request_id.length > 0
    const hasRevision = Number.isFinite(body?.expected_revision)
    if (hasRequest !== hasRevision) return { error: 'mutation_identity_required' }
    return hasRevision ? { expectedRevision: Math.floor(body.expected_revision) } : {}
  }

  /**
   * Apply one PATCH to a session through the facade's webui routes.
   * @param {string} sessionId session id.
   * @param {object} body patch body.
   * @returns {Promise<object>} reply body.
   */
  async function patchSession(sessionId, body) {
    // DeepSeek Harness has no unread flag. Refuse the whole body instead of
    // applying the rest and clearing a badge the host never remembered.
    if (typeof body.unread === 'boolean') throw new Error('unread is not supported by DeepSeek Harness')
    const draft = sessions.draft(sessionId)
    // An unpromoted draft has no DSH row to write; keep what the rename says and
    // apply it when the first prompt creates the session.
    if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
      const pending = {}
      if (typeof body.title === 'string' && body.title.trim().length > 0) {
        sessions.noteTitle(sessionId, body.title)
        pending.title = body.title
      }
      if (typeof body.pinned === 'boolean' || typeof body.archived === 'boolean') {
        // It is not in the store yet, so there is no row to pin or archive.
        throw new Error('a chat with no messages cannot be pinned or archived')
      }
      return Object.keys(pending).length > 0 ? pending : { ok: true }
    }
    const base = { session_id: sessions.resolve(sessionId) }
    // Every field the body names is applied, not just the first: a PATCH with a
    // title and a pin used to silently drop the pin.
    const applied = {}
    if (typeof body.title === 'string' && body.title.trim().length > 0) {
      const reply = await backend.call('POST', '/api/session/rename', { body: { ...base, title: body.title } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'rename refused')
      applied.title = body.title
    }
    if (typeof body.pinned === 'boolean') {
      const reply = await backend.call('POST', '/api/session/pin', { body: { ...base, pinned: body.pinned } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'pin refused')
      applied.pinned = body.pinned
    }
    if (typeof body.archived === 'boolean') {
      const reply = await backend.call('POST', '/api/session/archive', { body: { ...base, archived: body.archived } })
      if (reply.json?.ok !== true) throw new Error(reply.json?.error ?? 'archive refused')
      applied.archived = body.archived
    }
    return Object.keys(applied).length > 0 ? applied : { ok: true }
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
      // Only the memory flags are read by the Memory screen; this host has no
      // user-profile store and no per-profile memory directory.
      sendJson(res, 200, {
        platform_hints: {},
        profile: profilesActiveBody().active,
        memory: {
          memory_enabled: true,
          user_profile_enabled: false,
          memory_char_limit: 200000,
          user_char_limit: 0,
        },
      })
      return
    }
    // Skills: the facade owns the catalogue, and this listener answers with the
    // bare array the Hermes client decodes rather than the webui {skills} envelope.
    if (method === 'GET' && path === '/api/skills') {
      const reply = await backend.call('GET', '/api/skills')
      if (reply.status !== 200 || !Array.isArray(reply.json?.skills)) {
        sendJson(res, reply.status === 200 ? 500 : reply.status, reply.json ?? { detail: 'Skill catalogue unavailable' })
        return
      }
      sendJson(res, 200, reply.json.skills.map(row => ({
        name: row?.name,
        description: row?.description,
        ...(typeof row?.category === 'string' ? { category: row.category } : {}),
        enabled: row?.enabled !== false,
      })))
      return
    }
    if (method === 'GET' && path === '/api/skills/content') {
      const reply = await backend.call('GET', '/api/skills/content', { query: Object.fromEntries(url.searchParams) })
      sendJson(res, reply.status, reply.json ?? { detail: 'Skill not found.' })
      return
    }
    if (method === 'PUT' && path === '/api/skills/toggle') {
      const body = await readJson(req)
      const reply = await backend.call('PUT', '/api/skills/toggle', { body })
      sendJson(res, reply.status, reply.json ?? { detail: 'Skills cannot be disabled on this host.' })
      return
    }
    // A composer image is staged under the uploads root; the app then names its
    // path in the vision-reference block, and prompt.submit turns it into a
    // native image part.
    if (method === 'POST' && path === '/api/chat/image-upload') {
      // A 20 MiB image is ~27 MiB of base64 before JSON; the route has its own
      // bound rather than the 4 MiB general request cap.
      const body = await readJson(req, 32 * 1024 * 1024)
      const decoded = decodeUpload(body.data_url, 20 * 1024 * 1024)
      if (decoded === null || !new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).has(decoded.mime)) {
        sendJson(res, 400, { detail: 'data_url must be a base64 PNG, JPEG, WebP or GIF' })
        return
      }
      const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[decoded.mime]
      // The leaf extension must follow the declared MIME, not the client name:
      // DSH compares the native part's media type with the decoded bytes.
      let leaf = sanitizeUploadName(body.filename, 'image')
      const suppliedExtension = extname(leaf).toLowerCase()
      if (new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']).has(suppliedExtension)) leaf = leaf.slice(0, -suppliedExtension.length)
      leaf = (leaf.length > 0 ? leaf : 'image') + extension
      await mkdir(uploads, { recursive: true, mode: 0o700 })
      const target = join(uploads, randomUUID() + '-' + leaf)
      await writeFile(target, decoded.bytes, { mode: 0o600 })
      sendJson(res, 200, { ok: true, path: target, name: basename(target), bytes: decoded.bytes.length, mime_type: decoded.mime })
      return
    }
    // The Memory screen's managed file routes. Only the two paths its Profile
    // row turns into are served: MEMORY.md is the global AGENTS.md, USER.md is
    // absent. Nothing here opens the requested path, so no other file is reachable.
    if (method === 'GET' && path === '/api/files/read') {
      const kind = memoryKindOf(url.searchParams.get('path'))
      if (kind === null || kind === 'user') { sendJson(res, 404, { detail: 'Not Found' }); return }
      const content = await readMemoryText(memoryHome)
      if (content === null) { sendJson(res, 404, { detail: 'Not Found' }); return }
      sendJson(res, 200, { data_url: 'data:text/plain;base64,' + Buffer.from(content, 'utf8').toString('base64') })
      return
    }
    if (method === 'POST' && path === '/api/files/upload') {
      const body = await readJson(req)
      if (memoryKindOf(body.path) === null) { sendJson(res, 404, { detail: 'Not Found' }); return }
      sendJson(res, 400, { detail: 'Memory is read-only on this host; edit AGENTS.md in the DSH home or the workspace.' })
      return
    }
    const soulMatch = /^\/api\/profiles\/([^/]+)\/soul$/.exec(path)
    if (soulMatch !== null) {
      const name = decodeURIComponent(soulMatch[1])
      if (name !== profilesActiveBody().active) { sendJson(res, 404, { detail: 'Not Found' }); return }
      if (method === 'GET') { sendJson(res, 200, { content: '', exists: false }); return }
      if (method === 'PUT') {
        sendJson(res, 400, { detail: 'This host has no SOUL.md; memory lives in AGENTS.md.' })
        return
      }
      sendJson(res, 405, { detail: 'Method Not Allowed' })
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
    // The in-chat Files browser. Every route fences the client's absolute path
    // against the chat folders before reading anything.
    if (method === 'GET' && path === '/api/fs/list') {
      const reply = await files.list(url)
      sendJson(res, reply.status, reply.body)
      return
    }
    if (method === 'GET' && path === '/api/fs/read-text') {
      const reply = await files.readText(url)
      sendJson(res, reply.status, reply.body)
      return
    }
    if (method === 'GET' && path === '/api/fs/download') {
      const reply = await files.download(url)
      if (reply.bytes === undefined) { sendJson(res, reply.status, reply.body); return }
      res.writeHead(reply.status, reply.headers)
      res.end(reply.bytes)
      return
    }

    // The in-chat Git menu, read-only. The client resolves the repository root
    // from the chat folder, then names that root on every read.
    if (method === 'GET' && path === '/api/fs/git-root') {
      const target = String(url.searchParams.get('path') ?? '').trim()
      if (target.length === 0) { sendJson(res, 400, { detail: 'path required' }); return }
      if (!target.startsWith('/')) { sendJson(res, 400, { detail: 'path must be absolute' }); return }
      const verdict = await fence.check(target, await fileRoots())
      if (verdict.ok !== true) {
        if (verdict.missing === true) { sendJson(res, 200, { root: null }); return }
        sendJson(res, 403, {
          detail: verdict.sensitive === true
            ? 'Access to sensitive files is not allowed'
            : 'Path is outside the session workspace',
        })
        return
      }
      sendJson(res, 200, { root: (await findGitRoot(verdict.path)) ?? null })
      return
    }

    const gitRead = method === 'GET' && (
      path === '/api/git/status' ||
      path === '/api/git/branches' ||
      path === '/api/git/review/list' ||
      path === '/api/git/review/diff' ||
      path === '/api/git/file-diff' ||
      path === '/api/git/review/rev-parse' ||
      path === '/api/git/review/commit-context'
    )
    if (gitRead) {
      const scope = await gitScope(url.searchParams.get('path'))
      if (scope.status !== undefined) { sendJson(res, scope.status, { detail: scope.detail }); return }
      const root = scope.root
      try {
        if (path === '/api/git/status') {
          sendJson(res, 200, root === undefined ? null : await repoStatus(root, gitGuard))
          return
        }
        if (path === '/api/git/branches') {
          sendJson(res, 200, { branches: root === undefined ? [] : await branches(root) })
          return
        }
        if (path === '/api/git/review/rev-parse') {
          sendJson(res, 200, { sha: root === undefined ? null : await revParse(root, url.searchParams.get('ref') ?? undefined) })
          return
        }
        if (path === '/api/git/review/commit-context') {
          sendJson(res, 200, root === undefined
            ? { diff: '', recent: '', branch: null, truncated: false }
            : await commitContext(root, gitGuard))
          return
        }
        const file = url.searchParams.get('file') ?? ''
        const scopeName = url.searchParams.get('scope') ?? 'uncommitted'
        if (!['uncommitted', 'branch', 'lastTurn'].includes(scopeName)) {
          sendJson(res, 400, { detail: 'unknown scope' })
          return
        }
        if (path === '/api/git/review/list') {
          sendJson(res, 200, root === undefined
            ? { files: [], base: null }
            : await reviewList(root, scopeName, url.searchParams.get('base') ?? undefined, gitGuard))
          return
        }
        if (path === '/api/git/review/diff') {
          const staged = url.searchParams.get('staged') === 'true'
          sendJson(res, 200, {
            diff: root === undefined ? '' : await reviewDiff(root, {
              file, scope: scopeName, base: url.searchParams.get('base') ?? undefined, staged,
            }, gitGuard),
          })
          return
        }
        // /api/git/file-diff
        sendJson(res, 200, { diff: root === undefined ? '' : await fileDiff(root, file, gitGuard) })
        return
      } catch (error) {
        if (error instanceof GitRefusal) { sendJson(res, error.status, { detail: error.detail }); return }
        logger.warn?.('hermes-gateway: git read failed: ' + String(error?.message ?? error))
        sendJson(res, 400, { detail: 'git read failed' })
        return
      }
    }

    // Git writes. Every one is refused while any turn is running: staging or
    // committing under a live agent can race its own edits, and the client's
    // idle check is only a hint.
    const gitWrite = method === 'POST' && (
      path === '/api/git/review/stage' ||
      path === '/api/git/review/unstage' ||
      path === '/api/git/review/revert' ||
      path === '/api/git/review/commit' ||
      path === '/api/git/review/push' ||
      path === '/api/git/branch/switch'
    )
    if (gitWrite) {
      if (runner.active.size > 0) {
        sendJson(res, 409, { detail: 'A turn is running; wait for it to finish before changing git' })
        return
      }
      const body = await readJson(req)
      const scope = await gitScope(body.path)
      if (scope.status !== undefined) { sendJson(res, scope.status, { detail: scope.detail }); return }
      if (scope.root === undefined) { sendJson(res, 400, { detail: 'not a git repository' }); return }
      const root = scope.root
      try {
        if (path === '/api/git/review/stage') {
          await stageFile(root, body.file, gitGuard)
          sendJson(res, 200, { ok: true, git: await repoStatus(root, gitGuard) })
          return
        }
        if (path === '/api/git/review/unstage') {
          await unstageFile(root, body.file, gitGuard)
          sendJson(res, 200, { ok: true, git: await repoStatus(root, gitGuard) })
          return
        }
        if (path === '/api/git/review/revert') {
          await revertFile(root, body.file, gitGuard)
          sendJson(res, 200, { ok: true, git: await repoStatus(root, gitGuard) })
          return
        }
        if (path === '/api/git/review/commit') {
          sendJson(res, 200, await commitRepo(root, { message: body.message, push: body.push === true }, gitGuard))
          return
        }
        if (path === '/api/git/review/push') {
          sendJson(res, 200, await pushRepo(root, gitGuard))
          return
        }
        sendJson(res, 200, await switchBranch(root, body.branch, gitGuard))
        return
      } catch (error) {
        if (error instanceof GitRefusal) { sendJson(res, error.status, { detail: error.detail }); return }
        logger.warn?.('hermes-gateway: git write failed: ' + String(error?.message ?? error))
        sendJson(res, 400, { detail: 'git write failed' })
        return
      }
    }
    // Writes and the gh-backed routes are refused with a reason; the Git menu
    // stays read-only until the write guard is reviewed.
    if (path.startsWith('/api/git/')) {
      if (path === '/api/git/review/ship-info') { sendJson(res, 200, { pr: null }); return }
      if (path === '/api/git/gh-auth') { sendJson(res, 200, { available: false, authenticated: false }); return }
      if (path === '/api/git/worktrees') { sendJson(res, 200, { worktrees: [] }); return }
      sendJson(res, 400, { detail: 'Git writes are not supported by this DeepSeek Harness host yet' })
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
      if (sessions.isDraft(sessionId) && sessions.resolve(sessionId) === sessionId) {
        sendJson(res, 404, { detail: 'This chat has no transcript yet' })
        return
      }
      const reply = await backend.call('GET', '/api/session/export', {
        query: { session_id: sessions.resolve(sessionId), format: url.searchParams.get('format') ?? 'json' },
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
    if (path.startsWith('/api/analytics/')) {
      const query = Object.fromEntries(url.searchParams)
      const reply = await backend.call('GET', path, { query })
      sendJson(res, reply.status, reply.json ?? { detail: 'Analytics unavailable' })
      return
    }
    if (path === '/api/cron' || path.startsWith('/api/cron/')) {
      // Tasks/cron is one mapping, done by the facade (which also serves the
      // Legacy listener's future callers), so the gateway only forwards it.
      const query = {}
      for (const [key, value] of url.searchParams) query[key] = value
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readJson(req)
      const reply = await backend.call(method, path, {
        query,
        ...(body === undefined ? {} : { body }),
      })
      sendJson(res, reply.status, reply.json ?? { detail: 'Task operation failed' })
      return
    }
    if (method === 'GET' && path === '/api/sessions/search') {
      // The facade builds the host result rows (id, title, snippet, recency) and
      // the Legacy session rows in one reply; Hermex reads `results`.
      const query = {}
      for (const [key, value] of url.searchParams) query[key] = value
      const reply = await backend.call('GET', '/api/sessions/search', { query })
      if (reply.status !== 200) { sendJson(res, 500, { detail: 'Search failed' }); return }
      sendJson(res, 200, { results: Array.isArray(reply.json?.results) ? reply.json.results : [] })
      return
    }
    if (method === 'GET' && path === '/api/sessions/stats') {
      // Unimplemented collection endpoint: a plain 404 (the row regex below would
      // report "Session not found" for a session literally named "stats").
      sendJson(res, 404, { detail: 'Not Found' })
      return
    }
    const snapshotMatch = /^\/api\/sessions\/([^/]+)\/mutation-snapshot$/.exec(path)
    if (snapshotMatch !== null) {
      if (method !== 'GET') { sendJson(res, 405, { detail: 'Method Not Allowed' }); return }
      const sessionId = decodeURIComponent(snapshotMatch[1])
      sendJson(res, 200, await mutationSnapshot(sessionId))
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
        // The client's write fence: a snapshot read before the write, then a
        // request_id and expected_revision on the PATCH. A write without them is
        // an older client and is applied bare, as it was before the fence.
        const identity = writeIdentityOf(body)
        if (identity.error !== undefined) { sendJson(res, 409, { detail: identity.error }); return }
        if (identity.expectedRevision !== undefined) {
          const current = await sessionRevision(sessionId)
          if (identity.expectedRevision !== current) {
            // "This session changed on the server. Try again." on the phone.
            sendJson(res, 409, { detail: 'revision_conflict' })
            return
          }
        }
        try {
          const result = await patchSession(sessionId, body)
          bumpRevision(sessionId)
          sendJson(res, 200, result)
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
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
        try { sendJson(res, status, { detail: status === 413 ? 'Body too large' : 'Internal error' }) } catch { /* answered */ }
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
    // A JSON-RPC response to a server-to-client request. It settles the request
    // and withdraws it, exactly as the request.answer/approval.respond path does;
    // leaving the cancel frame out left the card to a timeout on the other side.
    if (typeof frame.method !== 'string') {
      if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
        requests.resolve(String(frame.id), frame.result ?? null, 'resolved')
      }
      return
    }
    if (frame.method === 'client.capabilities' && frame.params?.server_requests === true) {
      serverRequests.add(connection)
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
      try {
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
      } catch (error) {
        // One host in gatewayLanHost can be stale or unroutable (EADDRNOTAVAIL).
        // A half-bound gateway would keep serving on the addresses that worked
        // while apply() reports the mount failed, so release every one.
        for (const instance of activeServers.splice(0)) {
          try { instance.close() } catch { /* already closed */ }
        }
        throw error
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
