/**
 * Hermes host protocol constants: the status document the client probes, the
 * single-Profile shim, cookies, tickets and the gateway handshake.
 *
 * @module dsh-hermes-facade/src/hermes/protocol
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Version reported to Hermex. The app gate is at least 0.21.3; its pin is 0.22.5. */
export const HERMES_VERSION = '0.22.5'

/** The only Profile DSH has. */
export const PROFILE_NAME = 'default'

/**
 * The terminal backend `session.info` reports. Hermex only offers the in-chat
 * Files and Git entries when it is "local", because a docker/ssh backend's
 * folder is not on this host's filesystem.
 */
export const TERMINAL_BACKEND = 'local'

/** Cookie names the client keeps and replays. */
export const COOKIE_AT = 'hermes_session_at'
export const COOKIE_RT = 'hermes_session_rt'
export const COOKIE_PROVIDER = 'hermes_session_provider'

/** How long one websocket ticket may be redeemed for. */
export const TICKET_TTL_SECONDS = 30

/**
 * Read or create the stable install_id.
 *
 * Hermex trusts a host the first time and refuses a changed one (different
 * host), so this must survive restarts and whole-plugin reloads.
 *
 * @param {string} dir state directory.
 * @returns {string} install id.
 */
export function ensureInstallId(dir) {
  const path = join(dir, 'install-id')
  try {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim()
      if (value.length >= 8) return value
    }
  } catch { /* fall through and mint one */ }
  const value = randomUUID()
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, value + '\n', { mode: 0o600 })
  } catch { /* an unwritable dir still answers with a per-process id */ }
  return value
}

/**
 * Build the public GET /api/status body.
 * @param {object} options options.
 * @param {string} options.installId stable install id.
 * @param {number} [options.activeSessions] sessions currently streaming.
 * @returns {object} status body.
 */
export function statusBody({ installId, activeSessions = 0 }) {
  return {
    version: HERMES_VERSION,
    release_date: '2026-11-05',
    config_version: 51,
    latest_config_version: 51,
    can_update_hermes: false,
    gateway_running: false,
    gateway_state: 'stopped',
    gateway_platforms: {},
    gateway_exit_reason: null,
    gateway_updated_at: null,
    gateway_heartbeat_stale_s: null,
    gateway_shared_with: [],
    active_agents: 0,
    gateway_busy: false,
    gateway_drainable: true,
    restart_drain_timeout: 60,
    active_sessions: activeSessions,
    auth_required: true,
    auth_providers: ['basic'],
    auth_flows: ['cookie'],
    nous_session_valid: false,
    install_id: installId,
    shared_profile_warning: false,
    components: {
      dashboard: { status: 'ok' },
      gateway: { status: 'stopped' },
      platforms: {},
      storage: { status: 'ok' },
    },
    overall: 'ok',
    memory: {
      pressure: 'ok',
      gateway_rss_mb: null,
      system_total_mb: null,
      system_available_mb: null,
      swap_used_mb: null,
      sampled_at: null,
      boot_id: installId,
      last_boot_unclean: false,
      last_boot_suspected_oom: false,
    },
    disk: { pressure: 'ok', free_mb: null, total_mb: null, used_percent: null },
    profiles: [PROFILE_NAME],
    parked_profiles: [],
    desktop_contract: 8,
  }
}

/**
 * One profiles.list row.
 * @returns {object} profile row.
 */
export function profileRow() {
  return {
    name: PROFILE_NAME,
    is_default: true,
    is_active: true,
    home: PROFILE_NAME,
    // Hermex treats this as a host path (it derives <path>/memories/MEMORY.md),
    // so it must be absolute; the gateway maps that exact suffix to the global
    // AGENTS.md rather than opening whatever this path names.
    path: process.env.DSH_HOME || join(homedir(), '.dsh'),
    avatar: null,
    created_at: null,
    session_count: null,
    gateway_running: false,
  }
}

/**
 * profiles.list reply.
 * @returns {object} reply.
 */
export function profilesListBody() {
  return { profiles: [profileRow()], active: PROFILE_NAME, current: PROFILE_NAME }
}

/**
 * GET /api/profiles/active reply.
 * @returns {object} reply.
 */
export function profilesActiveBody() {
  return { active: PROFILE_NAME, current: PROFILE_NAME }
}

/**
 * Issue and redeem single-use websocket tickets.
 * @param {object} [options] options.
 * @param {number} [options.ttlSeconds] lifetime.
 * @returns {object} ticket store.
 */
export function createTicketStore({ ttlSeconds = TICKET_TTL_SECONDS } = {}) {
  const tickets = new Map()

  /**
   * Mint one ticket.
   * @returns {{ticket: string, ttl_seconds: number}} ticket.
   */
  function issue() {
    const now = Date.now()
    for (const [key, expires] of tickets) if (expires <= now) tickets.delete(key)
    const ticket = randomBytes(24).toString('base64url')
    tickets.set(ticket, now + ttlSeconds * 1000)
    return { ticket, ttl_seconds: ttlSeconds }
  }

  /**
   * Redeem one ticket, once.
   * @param {string|undefined} ticket presented ticket.
   * @returns {boolean} accepted.
   */
  function redeem(ticket) {
    if (typeof ticket !== 'string' || ticket.length === 0) return false
    const expires = tickets.get(ticket)
    if (expires === undefined) return false
    tickets.delete(ticket)
    return expires > Date.now()
  }

  return { issue, redeem, size: () => tickets.size }
}

/**
 * Read one cookie by name.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {string} name cookie name.
 * @returns {string|undefined} value.
 */
export function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length === 0) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch { return part.slice(eq + 1).trim() }
  }
  return undefined
}

/**
 * Build the Set-Cookie headers for a signed-in browser.
 * @param {object} options options.
 * @param {string} options.at access cookie value.
 * @param {string} options.rt refresh cookie value.
 * @param {number} options.maxAge seconds.
 * @param {boolean} [options.secure] add Secure.
 * @returns {string[]} header values.
 */
export function sessionCookies({ at, rt, maxAge, secure = false }) {
  const suffix = '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=' + maxAge
  return [
    COOKIE_AT + '=' + at + suffix,
    COOKIE_RT + '=' + rt + suffix,
    COOKIE_PROVIDER + '=basic; Path=/; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=' + maxAge,
  ]
}

/**
 * Build the GET /api/auth/me body.
 * @param {number} expiresAt epoch seconds.
 * @returns {object} body.
 */
export function meBody(expiresAt) {
  return {
    user_id: 'dsh',
    email: '',
    display_name: 'DeepSeek Harness',
    org_id: '',
    provider: 'basic',
    expires_at: expiresAt,
  }
}
