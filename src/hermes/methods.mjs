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

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

import { commandsOf, controlOf, modelOptionsOf, resumeReplyOf, sessionRowOf } from './shapes.mjs'
import { decodeUpload, imageMediaType, sanitizeUploadName } from './uploads.mjs'
import { profilesListBody, profileRow, PROFILE_NAME, TERMINAL_BACKEND } from './protocol.mjs'

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
 * Translate one Hermex `/goal` argument onto DeepSeek Harness's own grammar.
 *
 * Hermex sends the webui's goal vocabulary — `status`, `show`, `pause`,
 * `resume`, `clear`, `done`, `stop`, `wait`, `gate`, `unwait` — while DSH's
 * `/goal` command understands `[<objective>|clear|edit <objective>|pause|resume]`.
 * Forwarding a control verb blindly would make `/goal status` create a goal
 * whose objective is "status", so the exact verbs are translated here and every
 * translated verb still runs through the host's own command. A verb DSH's
 * command does not have is refused instead of being executed as an objective.
 *
 * @param {string} argument exact text after `/goal`.
 * @returns {{line: string}|{refusal: string}} translated line, or the honest refusal.
 */
function goalLineOf(argument) {
  const text = String(argument ?? '').trim()
  const verb = text.toLowerCase()
  if (verb.length === 0 || verb === 'status' || verb === 'show') return { line: '/goal' }
  if (verb === 'pause' || verb === 'resume' || verb === 'clear') return { line: '/goal ' + verb }
  if (verb === 'done' || verb === 'stop' || verb === 'wait' || verb === 'gate' || verb === 'unwait') {
    return {
      refusal: 'DeepSeek Harness has no /goal ' + verb + ' verb; its goal command offers status, pause, resume, clear and edit.',
    }
  }
  // Anything else is an objective, exactly as DSH's command parses it.
  return { line: '/goal ' + text }
}

/**
 * Create the method table.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.hub event hub.
 * @param {object} options.runner turn runner.
 * @param {object} options.requests reverse-request manager.
 * @param {object} [options.host] DSH host adapter, for the surfaces only the
 *   host can answer (slash-command execution and the durable goal projection).
 * @param {object} [options.logger] logger.
 * @returns {{dispatch: Function, unavailable: Set<string>}} methods.
 */
export function createMethods({ backend, hub, runner, requests, sessions, uploadsDir, host, bumpRevision = () => {}, logger = console }) {
  const unavailable = new Set()

  /**
   * Find the app's appended image reference blocks and resolve them to staged
   * files inside the uploads root. The text is left exactly as the app sent it:
   * Hermex parses the same two-line reference into an attachment chip, so the
   * history row keeps it while DSH receives the bytes as a native image part.
   * A path that resolves outside the uploads root (including a symlink) is
   * ignored; an unrecognized block stays text.
   * @param {string} text prompt text.
   * @returns {Promise<{text: string, images: Array<{path: string, mediaType: string, name: string}>}>} text and staged files.
   */
  async function extractImages(text) {
    const images = []
    const root = await realpath(uploadsDir).catch(() => null)
    if (root === null) return { text, images }
    const pattern = /\[The user attached an image: ([^\]\n]*)\]\n\[Examine it with the vision_analyze tool using image_url: ([^\]\n]+)\]/g
    for (const match of [...text.matchAll(pattern)]) {
      const target = await realpath(match[2]).catch(() => null)
      if (target === null || !target.startsWith(root + sep)) continue
      const mediaType = imageMediaType(target)
      if (mediaType === null) continue
      images.push({ path: target, mediaType, name: basename(target) })
    }
    return { text, images }
  }
  /** Cached catalog/reasoning defaults for chats that have no DSH session yet. */
  let defaultsCache

  /**
   * Fetch one session detail, or throw the host's not-found.
   * @param {string} sessionId session id.
   * @returns {Promise<object>} detail.
   */
  async function detailOf(sessionId) {
    const backendId = sessions.resolve(sessionId)
    const reply = await backend.call('GET', '/api/session', { query: { session_id: backendId, msg_limit: 1 } })
    if (reply.status === 404) throw rpcError(-32000, 'Session not found')
    if (reply.status !== 200) throw rpcError(-32000, 'Session read failed (HTTP ' + reply.status + ')')
    const session = reply.json?.session
    if (session === null || typeof session !== 'object') throw rpcError(-32000, 'Session read failed')
    // The phone holds the draft id for this chat, so the reply speaks it.
    session.session_id = String(sessionId)
    // The composer's effort chip is restored from session.info / the resume snapshot,
    // so the current level has to travel with the session.
    try {
      const state = await backend.call('GET', '/api/reasoning', { query: { session_id: backendId } })
      const effort = state.json?.effective_effort ?? state.json?.effort
      if (typeof effort === 'string' && effort.length > 0) session.reasoning_effort = effort
    } catch { /* the effort is advisory */ }
    return session
  }

  /**
   * The host's defaults for a chat that has no session yet: the catalog's
   * selected model and the effort a new session runs at, so the composer's chips
   * are populated instead of empty.
   * @returns {Promise<{model?: string, provider?: string, effort?: string}>} defaults.
   */
  async function defaultState() {
    if (defaultsCache !== undefined && Date.now() - defaultsCache.at < 5000) return defaultsCache.value
    const value = {}
    try {
      const models = await backend.call('GET', '/api/models')
      if (typeof models.json?.default_model === 'string' && models.json.default_model.length > 0) {
        value.model = models.json.default_model
      }
      if (typeof models.json?.active_provider === 'string' && models.json.active_provider.length > 0) {
        value.provider = models.json.active_provider
      }
    } catch { /* the catalog is advisory */ }
    try {
      const reasoning = await backend.call('GET', '/api/reasoning')
      const effort = reasoning.json?.effective_effort ?? reasoning.json?.effort
      if (typeof effort === 'string' && effort.length > 0) value.effort = effort
    } catch { /* the effort is advisory */ }
    defaultsCache = { at: Date.now(), value }
    return value
  }

  /**
   * The working folder a new chat starts in: DSH's own current workspace, which
   * is what the webui host used when the app sent no project with the create.
   * @returns {Promise<string|undefined>} folder.
   */
  async function defaultWorkspace() {
    try {
      const reply = await backend.call('GET', '/api/workspaces')
      const last = reply.json?.last
      if (typeof last === 'string' && last.length > 0) return last
      const workspaces = Array.isArray(reply.json?.workspaces) ? reply.json.workspaces : []
      const path = workspaces[0]?.path
      if (typeof path === 'string' && path.length > 0) return path
    } catch { /* fall back to no folder */ }
    return undefined
  }

  /**
   * The info block for a draft (a chat whose DSH session does not exist yet).
   * @param {object} draft draft record.
   * @param {object} defaults catalog/reasoning defaults.
   * @returns {object} info.
   */
  function draftInfo(draft, defaults) {
    const title = typeof draft.title === 'string' && draft.title.length > 0 ? draft.title : undefined
    const model = typeof draft.model === 'string' && draft.model.length > 0 ? draft.model : defaults.model
    const provider = typeof draft.provider === 'string' && draft.provider.length > 0 ? draft.provider : defaults.provider
    const effort = typeof draft.effort === 'string' && draft.effort.length > 0 ? draft.effort : defaults.effort
    return {
      session_id: draft.id,
      running: false,
      stored_session_id: draft.id,
      session_key: draft.id,
      ...(title === undefined ? {} : { title }),
      ...(typeof draft.cwd === 'string' && draft.cwd.length > 0 ? { cwd: draft.cwd } : {}),
      ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
      ...(typeof provider === 'string' && provider.length > 0 ? { provider } : {}),
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoning_effort: effort } : {}),
      yolo: false,
      terminal_backend: TERMINAL_BACKEND,
    }
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
   * The session keys one live chat answers to.
   *
   * The client-facing id is what every frame for the chat already speaks. Once
   * a draft has been promoted, the DSH session id is also what the chat's row
   * carries in session.list, and the list maps a live state onto a row by
   * exactly that key, so both name the same conversation and both are listed.
   * The client keeps one state per key and lets Input win, so an alias can
   * never weaken the state.
   *
   * @param {string} sessionId client-facing id.
   * @returns {string[]} keys.
   */
  function activeKeysOf(sessionId) {
    const backendId = sessions.resolve(sessionId)
    return backendId === sessionId ? [sessionId] : [sessionId, backendId]
  }

  /**
   * The live sessions for session.active_list.
   *
   * Idle sessions are omitted: the client draws only Working (a turn runs) and
   * Input/Needs you (an approval or question is unanswered).
   *
   * @returns {Array<{session_key: string, status: string}>} rows.
   */
  function activeRows() {
    /** Client ids with an unanswered approval/clarify. */
    const asked = new Set()
    for (const entry of requests.open.values()) {
      if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) asked.add(entry.sessionId)
    }
    /** key -> status; waiting is the more urgent state of one conversation. */
    const states = new Map()
    for (const sessionId of new Set([...runner.active.keys(), ...asked])) {
      const status = asked.has(sessionId) ? 'waiting' : 'streaming'
      for (const key of activeKeysOf(sessionId)) {
        if (status === 'waiting' || states.get(key) === undefined) states.set(key, status)
      }
    }
    return [...states].map(([session_key, status]) => ({ session_key, status }))
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
      case 'insights.get':
        // DSH exposes no message count; the Usage screen marks its Messages total
        // approximate, and 0 is the honest value rather than a fabricated count.
        return { messages: 0 }
      case 'session.most_recent':
        return { ok: true }
      case 'session.list': {
        const list = await rows()
        // The row shape the list decodes, not just id/title: the Bot Chat lookup
        // needs resolved_id, and a row without its title/timestamps sorts badly.
        return { sessions: list.map(row => ({ ...sessionRowOf(row), resolved_id: null })) }
      }
      case 'session.active_list':
        // The list's live-state read; the contract maps streaming to Working
        // and waiting to Input, and the rest to no state at all.
        return { sessions: activeRows() }
      case 'session.create': {
        // A draft: DSH bakes a session's cwd at creation and validates workspace
        // membership against it, so creating it now would lock the folder before
        // the composer can pick one. promote() creates it on the first prompt.
        const requestedCwd = typeof p.cwd === 'string' && p.cwd.trim().length > 0 ? p.cwd.trim() : undefined
        const draft = sessions.createDraft({ cwd: requestedCwd ?? await defaultWorkspace() })
        if (typeof p.title === 'string' && p.title.length > 0) sessions.noteTitle(draft.id, p.title)
        // /clear opens a chat on its old folder and model; a plain new chat takes
        // the host's defaults, so the composer's chips start populated.
        if (typeof p.model === 'string' && p.model.length > 0) sessions.update(draft.id, { model: p.model })
        if (typeof p.provider === 'string' && p.provider.length > 0) sessions.update(draft.id, { provider: p.provider })
        const defaults = await defaultState()
        return {
          session_id: draft.id,
          stored_session_id: draft.id,
          session_key: draft.id,
          message_count: 0,
          messages: [],
          info: draftInfo(draft, defaults),
        }
      }
      case 'session.resume': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        const draft = sessions.draft(sessionId)
        // An unpromoted draft has no DSH session yet: answer from the draft so
        // the attach completes and the composer can still pick a folder.
        if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
          const info = draftInfo(draft, await defaultState())
          return {
            session_id: sessionId,
            stored_session_id: sessionId,
            session_key: sessionId,
            message_count: 0,
            messages: [],
            messages_omitted: true,
            info,
            running: false,
            open_requests: requests.openFor(sessionId),
          }
        }
        const detail = await detailOf(sessionId)
        // Every attach reads this; an empty list is a clear, so a request that
        // survived a reconnect must be replayed here as well as in the replay.
        return { ...resumeReplyOf(detail), open_requests: requests.openFor(sessionId) }
      }
      case 'session.title': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        // The contract's read form: omitting the title asks for the current one.
        if (typeof p.title !== 'string' || p.title.trim().length === 0) {
          const resolvedId = sessions.resolve(sessionId)
          const draft = sessions.draft(sessionId)
          if (draft !== undefined && resolvedId === sessionId) {
            return { title: typeof draft.title === 'string' ? draft.title : null, session_key: sessionId }
          }
          const detail = await detailOf(sessionId)
          return { title: typeof detail.title === 'string' ? detail.title : null, session_key: sessionId }
        }
        const title = p.title.trim()
        const resolved = sessions.resolve(sessionId)
        if (sessions.draft(sessionId) !== undefined && resolved === sessionId) {
          // An unpromoted draft: remember the title and write it when promoted.
          sessions.noteTitle(sessionId, title)
          return { title, session_key: sessionId }
        }
        const reply = await backend.call('POST', '/api/session/rename', { body: { session_id: resolved, title } })
        if (reply.json?.ok !== true) throw rpcError(-32000, reply.json?.error ?? 'Rename refused')
        return { title, session_key: sessionId }
      }
      case 'session.delete':
        throw rpcError(-32000, 'Session delete is not supported by DeepSeek Harness')
      case 'session.branch': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        const reply = await backend.call('POST', '/api/session/branch', {
          body: { session_id: sessions.resolve(sessionId), ...(Number.isSafeInteger(p.count) ? { keep_count: p.count } : {}) },
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
      case 'session.workspace.move': {
        // A chat nothing has been sent in yet is still a draft: record the folder
        // and create the DSH session there on the first prompt. Once a session
        // exists, DSH cannot change its cwd (workspace membership is validated
        // against the creation folder), so refuse instead of silently reverting.
        const sessionId = String(p.session_key ?? p.session_id ?? '')
        const cwd = String(p.cwd ?? '').trim()
        if (sessionId.length === 0 || cwd.length === 0) throw rpcError(-32602, 'session_key and cwd required')
        const draft = sessions.draft(sessionId)
        if (draft !== undefined && sessions.resolve(sessionId) === sessionId) {
          // The host answers 4017 for a folder it cannot open, and the client has
          // a message for exactly that code.
          try {
            if (statSync(cwd).isDirectory() !== true) throw new Error('not a directory')
          } catch {
            throw rpcError(4017, 'the working folder does not exist')
          }
          sessions.update(sessionId, { cwd })
          return { cwd, branch: null, git_repo_root: null }
        }
        throw rpcError(-32000, "DeepSeek Harness cannot change a session's folder after its first message; start a new chat in that folder")
      }
      case 'session.interrupt':
        return runner.interrupt(String(p.session_id ?? ''))
      case 'session.steer':
        return runner.steer(String(p.session_id ?? ''), String(p.text ?? ''))
      case 'session.close':
        return { ok: true }
      case 'prompt.submit': {
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
        const { text, images } = await extractImages(typeof p.text === 'string' ? p.text : '')
        // Validate before promoting: an empty prompt used to create the DSH
        // session first and then fail, burning the draft's id for nothing.
        if (text.trim().length === 0 && images.length === 0) throw rpcError(-32602, 'text required')
        // The first prompt is when a draft becomes a real DSH session, in the
        // folder the composer picked (or the host default when it picked none).
        try {
          await sessions.promote(sessionId)
        } catch (error) {
          throw rpcError(-32000, String(error?.message ?? error))
        }
        const accepted = await runner.start({ sessionId, text, images })
        bumpRevision(sessionId)
        return accepted
      }
      case 'file.attach': {
        // A document is staged under the facade's uploads directory; its
        // absolute path travels in the prompt as @file:<path>, and the app's
        // preview reads the same path through /api/fs/download.
        const decoded = decodeUpload(p.data_url, 25 * 1024 * 1024)
        if (decoded === null) throw rpcError(-32602, 'data_url required')
        await mkdir(uploadsDir, { recursive: true, mode: 0o700 })
        const target = join(uploadsDir, randomUUID() + '-' + sanitizeUploadName(p.name, 'upload'))
        await writeFile(target, decoded.bytes, { mode: 0o600 })
        // Hermex's @file parser stops at whitespace; pick a quote absent from the path.
        const quote = /\s/.test(target) ? ['`', '"', "'"].find(char => !target.includes(char)) : undefined
        const ref = quote === undefined ? '@file:' + target : '@file:' + quote + target + quote
        return { attached: true, path: target, ref_text: ref }
      }
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
        const options = modelOptionsOf(reply.json ?? {})
        // The picker's active tick comes from this reply, not from session.info,
        // so a chat must answer with the model the session actually runs.
        const sessionId = String(p.session_id ?? '')
        if (sessionId.length > 0) {
          try {
            const detail = await detailOf(sessionId)
            if (typeof detail.model === 'string' && detail.model.length > 0) options.model = detail.model
            if (typeof detail.model_provider === 'string' && detail.model_provider.length > 0) {
              options.provider = detail.model_provider
            }
          } catch { /* fall back to the catalog default */ }
        }
        return options
      }
      case 'commands.catalog': {
        const reply = await backend.call('GET', '/api/commands')
        return commandsOf(reply.json ?? {})
      }
      case 'command.dispatch': {
        // Hermex drives its /goal controls (and skill dispatch) through this
        // call. The host owns the command grammar and the domain state behind
        // it; only the webui's goal vocabulary is translated below.
        const name = typeof params.name === 'string' ? params.name.trim().replace(/^\/+/, '') : ''
        if (name.length === 0 || /\s/.test(name)) throw rpcError(-32602, 'command.dispatch needs a command name')
        const sessionId = typeof params.session_id === 'string' && params.session_id.length > 0 ? params.session_id : undefined
        if (sessionId === undefined) throw rpcError(-32602, 'command.dispatch needs a session_id')
        if (typeof host?.executeCommand !== 'function') {
          // A host without the command service refuses every dispatch instead of
          // pretending one ran; the phone shows this message.
          throw rpcError(-32000, 'Command dispatch is not available on this host')
        }
        const argument = typeof params.arg === 'string' ? params.arg : ''
        // The host's parser owns the grammar, so only the wire vocabulary is
        // translated: an objective travels as written.
        let line = '/' + name + (argument.length > 0 ? ' ' + argument : '')
        if (name === 'goal') {
          const translated = goalLineOf(argument)
          if (translated.refusal !== undefined) throw rpcError(-32000, translated.refusal)
          line = translated.line
        }
        const execution = await host.executeCommand({ sessionId, line })
        if (execution === undefined) throw rpcError(-32000, 'Unknown command: /' + name)
        const text = typeof execution.result?.text === 'string' ? execution.result.text : ''
        // A command the host refused is a refusal. Answering "exec" would show
        // the refusal in the transcript as if it had succeeded.
        if (execution.result.kind === 'error') throw rpcError(-32000, text.length > 0 ? text : 'The command was refused.')
        // DSH's command handlers and their domain own the next physical action:
        // /goal creates the goal and the goal round driver continues it, so the
        // phone must not also submit a kickoff prompt ("send").
        return { type: 'exec', output: text }
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
          const draftModel = sessions.draft(sessionId)
          if (draftModel !== undefined && sessions.resolve(sessionId) === sessionId) {
            sessions.update(sessionId, { model, ...(provider === undefined ? {} : { provider }) })
            return { ok: true, key: 'model', scope: 'session', value, confirm_required: false, deferred: false }
          }
          const applied = await backend.call('POST', '/api/session/update', {
            body: { session_id: sessions.resolve(sessionId), model, ...(provider === undefined ? {} : { model_provider: provider }) },
          })
          if (applied.status !== 200 || applied.json?.ok === false) {
            throw rpcError(-32000, String(applied.json?.error ?? 'model change refused'))
          }
          return { ok: true, key: 'model', scope: 'session', value, confirm_required: false, deferred: false }
        }
        if (key === 'reasoning') {
          if (sessionId.length === 0) throw rpcError(-32602, 'session_id required')
          const draftEffort = sessions.draft(sessionId)
          if (draftEffort !== undefined && sessions.resolve(sessionId) === sessionId) {
            sessions.update(sessionId, { effort: value })
            return { ok: true, key: 'reasoning', scope: 'session', value, effort: value }
          }
          const applied = await backend.call('POST', '/api/reasoning', { body: { session_id: sessions.resolve(sessionId), effort: value } })
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
        // Fast mode and yolo are not DSH settings. Echoing success used to make
        // the phone display a state the host never stored; a key-level refusal
        // keeps config.set itself available and lets those controls revert.
        if (key === 'fast') {
          throw rpcError(-32000, 'config.set fast is not supported by DeepSeek Harness')
        }
        if (key === 'yolo') {
          throw rpcError(-32000, 'config.set yolo is not supported by DeepSeek Harness')
        }
        // personality and approvals.mode are Profile-wide host writes DSH has no
        // equivalent for. A key-level error keeps this write failing without
        // marking config.set itself unavailable, which would disable the model,
        // effort and Fast controls on every chat of the connection.
        throw rpcError(-32000, 'config.set ' + key + ' is not supported by DeepSeek Harness')
      }
      case 'session.control.read': {
        const sessionId = typeof params.session_id === 'string' && params.session_id.length > 0 ? params.session_id : undefined
        if (sessionId === undefined) throw rpcError(-32602, 'session.control.read needs a session_id')
        // Without the host read there is nothing honest to report, so the method
        // stays unavailable and the phone hides the control.
        if (typeof host?.sessionGoal !== 'function') throw rpcError(-32601, 'session.control.read is not available on this host')
        // The goal only: DSH has no loop or heartbeat domain, so their keys are
        // absent (never empty objects) and the phone offers no Pause/Resume.
        return controlOf(await host.sessionGoal(sessionId))
      }
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
