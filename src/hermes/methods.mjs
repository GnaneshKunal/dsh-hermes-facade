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
    // The composer's effort chip is restored from session.info / the resume snapshot,
    // so the current level has to travel with the session.
    try {
      const state = await backend.call('GET', '/api/reasoning', { query: { session_id: sessionId } })
      const effort = state.json?.effective_effort ?? state.json?.effort
      if (typeof effort === 'string' && effort.length > 0) session.reasoning_effort = effort
    } catch { /* the effort is advisory */ }
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
        // Every attach reads this; an empty list is a clear, so a request that
        // survived a reconnect must be replayed here as well as in the replay.
        return { ...resumeReplyOf(detail), open_requests: requests.openFor(sessionId) }
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
        // The replay always carries open_requests, and a missing key clears the
        // client's list, so the unanswered cards must travel with it.
        return {
          ...hub.since(sessionId, Number.isSafeInteger(p.last_seen) ? p.last_seen : 0),
          open_requests: requests.openFor(sessionId),
        }
      }
      case 'approval.respond': {
        const requestId = String(p.request_id ?? '')
        const resolved = requests.resolve(requestId, { choice: String(p.choice ?? 'deny') }, 'resolved')
        return { resolved: resolved ? 1 : 0 }
      }
      case 'request.answer': {
        const id = String(p.id ?? '')
        const result = p.result !== null && typeof p.result === 'object' ? p.result : {}
        const resolved = requests.resolve(id, { answer: result.answer ?? result.value ?? '' }, 'resolved')
        return { status: resolved ? 'ok' : 'expired' }
      }
      case 'clarify.lock': {
        const requestId = String(p.request_id ?? '')
        const resolved = requests.resolve(requestId, { answer: String(p.answer ?? '') }, 'resolved')
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
      case 'projects.tree': {
        // Hermes projects are host folders: DSH workspaces are exactly that, and
        // their session membership is what the client draws its lanes from.
        const reply = await backend.call('GET', '/api/workspaces')
        const workspaces = Array.isArray(reply.json?.workspaces) ? reply.json.workspaces : []
        return {
          projects: workspaces.map(workspace => {
            const id = String(workspace?.id ?? workspace?.path ?? '')
            const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(String) : []
            return {
              id,
              label: String(workspace?.name ?? id),
              path: String(workspace?.path ?? ''),
              sessionIds,
              sessionCount: sessionIds.length,
              isAuto: false,
              isNoProject: false,
            }
          }),
        }
      }
      case 'config.set': {
        // The composer's model, effort, Fast and yolo writes. The client checks
        // that the reply echoes key/scope/value, so a bare acknowledgement reads
        // as an unknown outcome and the picker errors out.
        const sessionId = String(p.session_id ?? '')
        const key = String(p.key ?? '')
        const value = String(p.value ?? '')
        if (key === 'model') {
          if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
          const tokens = value.split(/\s+/).filter(Boolean)
          const model = tokens[0] ?? ''
          if (model.length === 0) throw rpcError(-32602, 'model required')
          let provider
          for (let index = 0; index < tokens.length; index += 1) {
            if (tokens[index] === '--provider' && typeof tokens[index + 1] === 'string') provider = tokens[index + 1]
          }
          const applied = await backend.call('POST', '/api/session/update', {
            body: { session_id: sessionId, model, ...(provider === undefined ? {} : { model_provider: provider }) },
          })
          if (applied.status !== 200 || applied.json?.ok === false) {
            throw rpcError(-32000, String(applied.json?.error ?? 'model change refused'))
          }
          return { ok: true, key: 'model', scope: 'session', value, confirm_required: false, deferred: false }
        }
        if (key === 'reasoning') {
          if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
          const applied = await backend.call('POST', '/api/reasoning', { body: { session_id: sessionId, effort: value } })
          if (applied.status !== 200 || applied.json?.ok !== true) {
            throw rpcError(-32000, String(applied.json?.error ?? 'reasoning change refused'))
          }
          return {
            ok: true,
            key: 'reasoning',
            scope: 'session',
            value,
            effort: String(applied.json?.effective_effort ?? value),
          }
        }
        if (key === 'fast' || key === 'yolo') {
          return { ok: true, key, scope: 'session', value }
        }
        // personality and approvals.mode are Profile-wide host writes DSH has no
        // equivalent for; -32601 hides the control instead of lying.
        throw rpcError(-32601, 'method not found: config.set ' + key)
      }
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
