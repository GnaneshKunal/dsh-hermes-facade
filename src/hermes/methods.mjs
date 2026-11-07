/**
 * JSON-RPC method table for the Hermes socket.
 *
 * Only the methods Hermex actually sends for chat, sessions and the composer
 * are implemented. Everything else answers -32601, which the client records as
 * an unavailable method and uses to hide the control (it is the same path an
 * older Hermes host takes).
 *
 * @module dsh-hermes-facade/src/hermes/methods
 */

import { commandsOf, modelOptionsOf, resumeReplyOf } from './shapes.mjs'
import { profilesListBody, profileRow, PROFILE_NAME } from './protocol.mjs'

/**
 * Build an RPC error with an explicit JSON-RPC code.
 * @param {number} code code.
 * @param {string} message message.
 * @returns {Error} error.
 */
function rpcError(code, message) {
  const error = new Error(message)
  error.rpcCode = code
  return error
}

/**
 * Create the method table.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.hub event hub.
 * @param {object} options.runner turn runner.
 * @param {object} options.requests reverse-request manager.
 * @param {object} [options.logger] logger.
 * @returns {{dispatch: Function, unavailable: Set<string>}} methods.
 */
export function createMethods({ backend, hub, runner, requests, logger = console }) {
  const unavailable = new Set()

  /**
   * Fetch one session detail, or throw the host's not-found.
   * @param {string} sessionId session id.
   * @returns {Promise<object>} detail.
   */
  async function detailOf(sessionId) {
    const reply = await backend.call('GET', '/api/session', { query: { session_id: sessionId, msg_limit: 1 } })
    if (reply.status === 404) throw rpcError(-32000, 'Session not found')
    if (reply.status !== 200) throw rpcError(-32000, 'Session read failed (HTTP ' + reply.status + ')')
    const session = reply.json?.session
    if (session === null || typeof session !== 'object') throw rpcError(-32000, 'Session read failed')
    return session
  }

  /**
   * List every facade session row.
   * @returns {Promise<object[]>} rows.
   */
  async function rows() {
    const reply = await backend.call('GET', '/api/sessions', { query: { include_archived: 1 } })
    if (reply.status !== 200) throw rpcError(-32000, 'Session list failed (HTTP ' + reply.status + ')')
    return Array.isArray(reply.json?.sessions) ? reply.json.sessions : []
  }

  /**
   * Dispatch one method.
   * @param {string} method method name.
   * @param {object} params params.
   * @returns {Promise<object>} result.
   */
  async function dispatch(method, params = {}) {
    const p = params !== null && typeof params === 'object' ? params : {}
    switch (method) {
      case 'gateway.ping':
        return { ok: true }
      case 'client.capabilities':
        // Acknowledging server_requests is what makes the host send approval and
        // clarify as reverse requests. Refusing it withdraws approvals silently.
        return { ok: true, server_requests: true }
      case 'profiles.list':
        return profilesListBody()
      case 'profiles.describe':
        return profileRow()
      case 'session.most_recent':
        return { ok: true }
      case 'session.list': {
        const list = await rows()
        return { sessions: list.map(row => ({ id: String(row.session_id ?? ''), title: row.title ?? null, resolved_id: null })) }
      }
      case 'session.create': {
        const created = await backend.call('POST', '/api/session/new', {
          body: {
            ...(typeof p.cwd === 'string' && p.cwd.length > 0 ? { workspace: p.cwd } : {}),
            ...(typeof p.model === 'string' ? { model: p.model } : {}),
            ...(typeof p.provider === 'string' ? { provider: p.provider } : {}),
          },
        })
        const detail = created.json?.session
        if (created.status !== 200 || detail === null || typeof detail !== 'object') {
          throw rpcError(-32000, created.json?.error ?? ('Session create failed (HTTP ' + created.status + ')'))
        }
        const id = String(detail.session_id ?? '')
        return {
          session_id: id,
          stored_session_id: id,
          session_key: id,
          message_count: 0,
          messages: [],
          info: { session_id: id, running: false, stored_session_id: id, session_key: id, cwd: detail.workspace, yolo: false },
        }
      }
      case 'session.resume': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        const detail = await detailOf(sessionId)
        return resumeReplyOf(detail)
      }
      case 'session.title': {
        const sessionId = String(p.session_id ?? '')
        const title = String(p.title ?? '')
        if (sessionId.length === 0 || title.length === 0) throw rpcError(-32602, 'session_id and title required')
        const reply = await backend.call('POST', '/api/session/rename', { body: { session_id: sessionId, title } })
        if (reply.json?.ok !== true) throw rpcError(-32000, reply.json?.error ?? 'Rename refused')
        return { title, session_key: sessionId }
      }
      case 'session.delete':
        throw rpcError(-32000, 'Session delete is not supported by DeepSeek Harness')
      case 'session.branch': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        const reply = await backend.call('POST', '/api/session/branch', {
          body: { session_id: sessionId, ...(Number.isSafeInteger(p.count) ? { keep_count: p.count } : {}) },
        })
        if (reply.json?.ok !== true) throw rpcError(-32000, reply.json?.error ?? 'Branch refused')
        const created = String(reply.json.session_id ?? '')
        return {
          session_id: created,
          stored_session_id: created,
          session_key: created,
          title: null,
          parent: sessionId,
          message_count: 0,
          messages: [],
          info: { session_id: created, running: false, session_key: created, yolo: false },
        }
      }
      case 'session.interrupt':
        return runner.interrupt(String(p.session_id ?? ''))
      case 'session.steer':
        return runner.steer(String(p.session_id ?? ''), String(p.text ?? ''))
      case 'session.close':
        return { ok: true }
      case 'prompt.submit':
        return runner.start({ sessionId: String(p.session_id ?? ''), text: String(p.text ?? '') })
      case 'session.events.since': {
        const sessionId = String(p.session_id ?? '')
        return hub.since(sessionId, Number.isSafeInteger(p.last_seen) ? p.last_seen : 0)
      }
      case 'approval.respond': {
        const requestId = String(p.request_id ?? '')
        const resolved = requests.resolve(requestId, { choice: String(p.choice ?? 'deny') })
        return { resolved: resolved ? 1 : 0 }
      }
      case 'request.answer': {
        const id = String(p.id ?? '')
        const result = p.result !== null && typeof p.result === 'object' ? p.result : {}
        const resolved = requests.resolve(id, { answer: result.answer ?? result.value ?? '' })
        return { status: resolved ? 'ok' : 'expired' }
      }
      case 'clarify.lock': {
        const requestId = String(p.request_id ?? '')
        const resolved = requests.resolve(requestId, { answer: String(p.answer ?? '') })
        return { status: resolved ? 'ok' : 'expired' }
      }
      case 'model.options': {
        const reply = await backend.call('GET', '/api/models')
        return modelOptionsOf(reply.json ?? {})
      }
      case 'commands.catalog': {
        const reply = await backend.call('GET', '/api/commands')
        return commandsOf(reply.json ?? {})
      }
      case 'config.set':
        // The client writes its platform hint here. DSH has no agent note, and
        // the write is advisory, so acknowledge without storing.
        return { ok: true, unchanged: true }
      case 'session.control.read':
        throw rpcError(-32601, 'method not found')
      default: {
        if (!unavailable.has(method)) {
          unavailable.add(method)
          logger.info?.('hermes-gateway: unsupported method ' + method + ' answered -32601')
        }
        throw rpcError(-32601, 'method not found: ' + method)
      }
    }
  }

  return { dispatch, unavailable, PROFILE_NAME }
}
