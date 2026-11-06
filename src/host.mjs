/**
 * Host adapter: projects facade calls onto the running DeepSeek Harness.
 *
 * Everything stays in-process. There is no HTTP between the facade and the
 * agent: we hold one owner Peer, call the Typert Remotes through
 * ctx.typertGateway, and answer approvals/questions by participating in the
 * host's cordis waterfalls.
 *
 * @module dsh-hermes-facade/src/host
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How long a pending interaction waits before it is released to the GUI. */
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Create the host adapter.
 * @param {object} options options.
 * @param {object} options.ctx cordis host context.
 * @param {{info: Function, warn: Function}} [options.logger] logger.
 * @returns {object} host surface consumed by the HTTP layer.
 */
export function createDshHost({ ctx, logger = console }) {
  const gateway = ctx.typertGateway
  const connection = ctx.connection
  if (gateway === undefined || connection === undefined) {
    throw new Error('hermes-facade needs the typertGateway and connection host services')
  }

  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  /** Short-lived cache of the workspace baseline. */
  let workspaceCache
  let workspaceCacheAt = 0

  /**
   * Invoke one Host Remote as this facade's peer.
   * @param {string} namespace remote namespace.
   * @param {string} method remote method.
   * @param {object} args call arguments.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<unknown>} result.
   */
  function invoke(namespace, method, args, signal) {
    return gateway.invoke({ namespace, method, args, peer, ...(signal ? { signal } : {}) })
  }

  /** @type {Map<string, {sessionId: string, resolve: Function, reject: Function}>} */
  const pendingApprovals = new Map()
  /** @type {Map<string, {sessionId: string, resolve: Function, reject: Function}>} */
  const pendingQuestions = new Map()
  /** @type {Set<Function>} */
  const interactionListeners = new Set()

  /**
   * Notify façade listeners that an interaction appeared or resolved.
   * @param {object} notice notice payload.
   * @returns {void}
   */
  function notify(notice) {
    for (const listener of interactionListeners) {
      try { listener(notice) } catch { /* a broken listener must not break the host */ }
    }
  }

  // Approvals arrive as a cordis waterfall: prepending means we are asked
  // first, and calling next() hands the question back to the GUI.
  const disposeApproval = ctx.on('approval/request', (request, next) => {
    const sessionId = String(request?.agent?.id ?? '')
    if (!sessionId || !hasStreamClient(sessionId)) return next()
    const approvalId = String(request?.callId ?? request?.approvalId ?? randomUUID())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId)
        resolve(next())
      }, INTERACTION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingApprovals.set(approvalId, {
        sessionId,
        resolve: outcome => { clearTimeout(timer); resolve(outcome) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      notify({
        kind: 'approval',
        sessionId,
        pending: {
          approval_id: approvalId,
          command: typeof request?.toolName === 'string' ? request.toolName : undefined,
          description: typeof request?.displayReason === 'string' ? request.displayReason : request?.reason,
        },
      })
    })
  }, { prepend: true })

  const disposeQuestions = ctx.on('user-questions/request', (request, next) => {
    const sessionId = String(request?.agent?.id ?? '')
    if (!sessionId || !hasStreamClient(sessionId)) return next()
    const clarifyId = String(request?.id ?? randomUUID())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQuestions.delete(clarifyId)
        resolve(next())
      }, INTERACTION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingQuestions.set(clarifyId, {
        sessionId,
        resolve: answers => { clearTimeout(timer); resolve(answers) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
      notify({
        kind: 'clarify',
        sessionId,
        pending: {
          clarify_id: clarifyId,
          question: typeof first?.question === 'string' ? first.question : undefined,
          choices_offered: Array.isArray(first?.options) ? first.options.map(option => option?.label).filter(Boolean) : undefined,
          requested_at: Math.floor(Date.now() / 1000),
        },
      })
    })
  }, { prepend: true })

  /**
   * Whether a session currently has an attached stream (and thus a human).
   * @param {string} sessionId session id.
   * @returns {boolean} has client.
   */
  let hasStreamClient = () => false

  /**
   * Pending approval for a session.
   * @param {string} sessionId session id.
   * @returns {object|undefined} pending payload.
   */
  function pendingApproval(sessionId) {
    for (const [approvalId, entry] of pendingApprovals) {
      if (entry.sessionId === sessionId) {
        return { approval_id: approvalId }
      }
    }
    return undefined
  }

  /**
   * Pending clarification for a session.
   * @param {string} sessionId session id.
   * @returns {object|undefined} pending payload.
   */
  function pendingClarification(sessionId) {
    for (const [clarifyId, entry] of pendingQuestions) {
      if (entry.sessionId === sessionId) return { clarify_id: clarifyId }
    }
    return undefined
  }

  return {
    /**
     * Provide the "is a client attached" predicate.
     * @param {Function} predicate predicate.
     * @returns {void}
     */
    setClientPredicate(predicate) { hasStreamClient = predicate },

    /**
     * Subscribe to interaction notices.
     * @param {Function} listener listener.
     * @returns {Function} dispose.
     */
    onInteraction(listener) {
      interactionListeners.add(listener)
      return () => interactionListeners.delete(listener)
    },

    /**
     * List sessions.
     * @returns {Promise<Array<object>>} rows.
     */
    async listSessions() {
      const value = await invoke('session', 'list', { _request: {} })
      return Array.isArray(value?.items) ? value.items : []
    },

    /**
     * Read one session with its event history.
     * @param {string} sessionId session id.
     * @param {object} [options] options.
     * @param {number} [options.maxMessages] history cap.
     * @returns {Promise<{item: object|undefined, events: Array<object>, projections: object}>} snapshot.
     */
    async readSession(sessionId, options = {}) {
      const controller = new AbortController()
      try {
        // typertGateway.stream() resolves to an AsyncIterable; it is a Promise.
        const stream = await gateway.stream({
          namespace: 'session',
          method: 'follow',
          peer,
          signal: controller.signal,
          args: {
            request: {
              address: { kind: 'session', sessionId },
              // assistantStream is a const-true field in the host schema: sending
              // false fails strict boundary validation, so omit it instead.
              ...(Number.isSafeInteger(options.maxMessages) ? { maxMessages: options.maxMessages } : {}),
            },
          },
        })
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        await iterator.return?.()
        const snapshot = first.done ? undefined : first.value
        const records = Array.isArray(snapshot?.records) ? snapshot.records : []
        const events = records.map(record => record?.event).filter(Boolean)
        return { item: undefined, events, projections: snapshot?.projections ?? {} }
      } finally {
        controller.abort(new Error('snapshot received'))
      }
    },

    /**
     * Ensure a session exists, creating one when needed.
     * @param {string} [sessionId] preferred id.
     * @returns {Promise<string>} the id to use.
     */
    async ensureSession(sessionId, workspacePath) {
      const request = {}
      if (sessionId) request.sessionId = sessionId
      // workspaceId and cwd are EXCLUSIVE in session/create: cwd creates a
      // session that owns a directory but joins no Workspace, which is what
      // the GUI shows as "ungrouped". Joining the Workspace is what groups it.
      if (typeof workspacePath === 'string' && workspacePath.length > 0) {
        request.workspaceId = await this.ensureWorkspace(workspacePath)
      }
      const value = await invoke('session', 'create', { request })
      // The new session joins a Workspace, which changes the baseline. Drop the
      // cache so the very next list read shows the grouping, not five-seconds-ago.
      workspaceCache = undefined
      workspaceCacheAt = 0
      const created = value?.sessionId
      if (typeof created !== 'string' || created.length === 0) throw new Error('session/create returned no sessionId')
      return created
    },

    /**
     * Current model selection of a session, from its projections.
     * @param {string} sessionId session id.
     * @returns {Promise<{provider?: string, model?: string, reasoningEffort?: string}|undefined>} selection.
     */
    async modelSelection(sessionId) {
      const rows = await this.listSessions()
      const row = rows.find(entry => String(entry?.sessionId) === String(sessionId))
      const selection = row?.projections?.values?.modelSelection
      if (selection === undefined || selection === null) return undefined
      const model = selection.model
      return {
        ...(typeof selection.provider === 'string' ? { provider: selection.provider } : {}),
        ...(typeof model === 'string' ? { model } : (typeof model?.id === 'string' ? { model: model.id } : {})),
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    },

    /**
     * Change the reasoning effort of a session.
     *
     * DSH has no separate effort endpoint: effort is part of the model
     * selection, so the current provider/model are replayed with the new effort.
     *
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {string} input.effort effort id.
     * @returns {Promise<{ok: boolean}>} outcome.
     */
    async setReasoningEffort({ sessionId, effort }) {
      const selection = await this.modelSelection(sessionId)
      const request = { sessionId, reasoningEffort: effort }
      if (selection?.provider !== undefined) request.provider = selection.provider
      if (selection?.model !== undefined) request.model = selection.model
      await invoke('session', 'selectModel', { request })
      return { ok: true }
    },

    /**
     * Serve a file referenced by a chat: an absolute path, a session-relative
     * path, or an attachment id from DSH's content-addressed store.
     * @param {string} sessionId session the reference belongs to.
     * @param {string} reference path or attachment id.
     * @returns {Promise<{body: Buffer, contentType: string}|undefined>} file bytes.
     */
    async readMedia(sessionId, reference) {
      const contentTypeFor = file => {
        const ext = String(file).toLowerCase().split('.').pop() ?? ''
        const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', webp2: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' }
        return map[ext] ?? 'application/octet-stream'
      }

      const fromAttachment = async id => {
        const sha = String(id).replace(/^sha256:/, '').replace(/^attachment:/, '')
        if (!/^[a-f0-9]{64}$/i.test(sha)) return undefined
        // Peer-free on purpose: a plugin must not hard-require a host package
        // just to find its own state directory.
        const home = process.env.DSH_HOME || join(homedir(), '.dsh')
        const path = join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
        try {
          const body = await readFile(path)
          return { body, contentType: contentTypeFor(path) }
        } catch {
          return undefined
        }
      }

      const raw = String(reference ?? '')
      if (raw.length === 0) return undefined
      if (raw.startsWith('attachment:') || /^[a-f0-9]{64}$/i.test(raw) || /^sha256:[a-f0-9]{64}$/i.test(raw)) {
        const attachment = await fromAttachment(raw)
        if (attachment !== undefined) return attachment
      }

      let resolved = raw
      if (!raw.startsWith('/')) {
        const cwd = await this.cwdOf(sessionId)
        if (cwd === undefined) return undefined
        resolved = join(cwd, raw)
      }
      try {
        const body = await readFile(resolved)
        return { body, contentType: contentTypeFor(resolved) }
      } catch {
        return undefined
      }
    },

    /**
     * Working directory of a session, used to resolve relative media paths.
     * @param {string} sessionId session id.
     * @returns {Promise<string|undefined>} cwd.
     */
    async cwdOf(sessionId) {
      try {
        const rows = await this.listSessions()
        const row = rows.find(entry => String(entry?.sessionId) === sessionId)
        if (typeof row?.cwd === 'string' && row.cwd.length > 0) return row.cwd
      } catch { /* fall through */ }
      return undefined
    },

    /**
     * Send a user message into a session.
     * @param {object} options options.
     * @param {string} options.sessionId session id.
     * @param {string} options.text message text.
     * @param {'queue'|'steer'} [options.mode] delivery mode.
     * @returns {Promise<{accepted: boolean}>} acceptance.
     */
    async prompt({ sessionId, text, mode = 'queue' }) {
      const value = await invoke('session', 'prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode,
          content: [{ type: 'text', text }],
        },
      })
      return { accepted: value?.accepted !== false }
    },

    /**
     * Cancel the running turn.
     * @param {string} sessionId session id.
     * @returns {Promise<void>} resolves when admission is acknowledged.
     */
    async cancel(sessionId) {
      await invoke('session', 'cancel', { request: { sessionId } })
    },

    /**
     * Stream a session's live frames.
     * @param {string} sessionId session id.
     * @param {object} options options.
     * @param {AbortSignal} options.signal cancellation.
     * @returns {AsyncIterable<object>} frames.
     */
    async *follow(sessionId, { signal }) {
      // stream() resolves to an AsyncIterable, so yield through it rather than
      // handing the promise back to a for-await consumer.
      const iterable = await gateway.stream({
        namespace: 'session',
        method: 'follow',
        peer,
        signal,
        args: {
          request: {
            address: { kind: 'session', sessionId },
            assistantStream: true,
          },
        },
      })
      for await (const frame of iterable) yield frame
    },

    /**
     * Model catalog for the composer.
     * @returns {Promise<object>} catalog.
     */
    async models() {
      try {
        const value = await invoke('session', 'modelCatalog', {})
        // ModelCatalog: { default: {provider, model}, groups: [{id, name, models:[{id,name}]}], failures }
        return value ?? {}
      } catch (error) {
        logger.warn?.('hermes-facade: modelCatalog failed: ' + String(error?.message ?? error))
        return {}
      }
    },

    /**
     * Slash-command catalog. DSH exposes none in this shape; an empty list
     * makes the client hide the menu instead of failing the composer.
     * @returns {Promise<Array<object>>} commands.
     */
    async commands() {
      return []
    },

    /**
     * Workspace list. Falls back to empty when the remote is unavailable.
     * @returns {Promise<{workspaces: Array<object>}>} workspaces.
     */
    async workspaces() {
      // There is no workspace/list Remote: the browser state comes from the
      // workspace/follow baseline. Cached briefly because every session list
      // read wants it.
      if (workspaceCache !== undefined && Date.now() - workspaceCacheAt < 5000) return workspaceCache
      const controller = new AbortController()
      try {
        const iterable = await gateway.stream({
          namespace: 'workspace',
          method: 'follow',
          peer,
          signal: controller.signal,
          args: {},
        })
        const iterator = iterable[Symbol.asyncIterator]()
        const first = await iterator.next()
        await iterator.return?.()
        const baseline = first.done ? undefined : first.value?.value
        const items = Array.isArray(baseline?.items) ? baseline.items : []
        workspaceCache = {
          workspaces: items
            .filter(item => typeof item?.path === 'string' && item.path.length > 0)
            .map(item => ({
              id: String(item.workspaceId ?? item.path),
              name: typeof item.title === 'string' && item.title.length > 0 ? item.title : String(item.path),
              path: String(item.path),
              sessionIds: (Array.isArray(item.sessionIds) ? item.sessionIds : []).map(String),
            })),
        }
        workspaceCacheAt = Date.now()
        return workspaceCache
      } catch (error) {
        logger.warn?.('hermes-facade: workspace/follow failed: ' + String(error?.message ?? error))
        return { workspaces: [] }
      } finally {
        controller.abort(new Error('baseline received'))
      }
    },

    /**
     * Find or create the Workspace for a directory.
     * @param {string} path absolute directory path.
     * @returns {Promise<string>} workspace id.
     */
    async ensureWorkspace(path) {
      // /tmp is a symlink to /private/tmp on macOS and DSH stores the canonical
      // path, so canonicalise before matching or a duplicate workspace appears.
      let wanted = String(path)
      try {
        const { realpath } = await import('node:fs/promises')
        wanted = await realpath(wanted)
      } catch { /* keep the raw path when it does not exist */ }
      const trim = value => value.replace(/\/+$/, '')
      const { workspaces } = await this.workspaces()
      const canonicalOf = async value => {
        try {
          const { realpath } = await import('node:fs/promises')
          return await realpath(value)
        } catch { return value }
      }
      let existing
      for (const workspace of workspaces) {
        if (trim(workspace.path) === trim(wanted) || trim(await canonicalOf(workspace.path)) === trim(wanted)) {
          existing = workspace
          break
        }
      }
      if (existing !== undefined) return existing.id
      const value = await invoke('workspace', 'create', { request: { path: wanted } })
      workspaceCache = undefined
      const created = value?.workspace?.workspaceId
      if (typeof created !== 'string' || created.length === 0) {
        throw new Error('workspace/create returned no workspaceId for ' + wanted)
      }
      return created
    },

    /**
     * Map a session id to the workspace that accounts for it, so Hermex can
     * group sessions into projects.
     * @returns {Promise<Map<string, {id: string, name: string}>>} session -> workspace.
     */
    async workspaceIndex() {
      const { workspaces } = await this.workspaces()
      const index = new Map()
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) {
          index.set(String(sessionId), { id: workspace.id, name: workspace.name })
        }
      }
      return index
    },

    /**
     * Rename a session.
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {string} input.title new title.
     * @returns {Promise<{ok: boolean}>} outcome.
     */
    async renameSession({ sessionId, title }) {
      await invoke('session', 'rename', { request: { sessionId, title } })
      return { ok: true }
    },

    /**
     * Pin or unpin a session (workspace ordering, not execution).
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {boolean} input.pinned desired state.
     * @returns {Promise<{ok: boolean}>} outcome.
     */
    async pinSession({ sessionId, pinned }) {
      await invoke('workspace', pinned ? 'pinSession' : 'unpinSession', { request: { sessionId } })
      return { ok: true }
    },

    /**
     * Archive or unarchive a session.
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {boolean} input.archived desired state.
     * @returns {Promise<{ok: boolean}>} outcome.
     */
    async archiveSession({ sessionId, archived }) {
      await invoke('workspace', archived ? 'archiveSession' : 'unarchiveSession', { request: { sessionId } })
      workspaceCache = undefined
      workspaceCacheAt = 0
      return { ok: true }
    },

    /**
     * Fork a session from its own history (Hermex calls this "branch").
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {number} [input.keepCount] messages to keep.
     * @returns {Promise<{ok: boolean, sessionId?: string}>} outcome.
     */
    async forkSession({ sessionId, keepCount }) {
      const value = await invoke('session', 'fork', {
        request: { sessionId, ...(Number.isSafeInteger(keepCount) ? { keepCount } : {}) },
      })
      const created = typeof value?.sessionId === 'string' ? value.sessionId : undefined
      return { ok: true, ...(created === undefined ? {} : { sessionId: created }) }
    },

    /**
     * Answer a pending approval.
     * @param {object} input input.
     * @param {string} input.approvalId approval id.
     * @param {string} input.choice once|session|always|deny.
     * @returns {{ok: boolean}} outcome.
     */
    respondApproval({ approvalId, choice }) {
      const entry = pendingApprovals.get(approvalId)
      if (entry === undefined) return { ok: false }
      pendingApprovals.delete(approvalId)
      entry.resolve(choice === 'deny' ? 'rejected' : 'allowed-once')
      notify({ kind: 'approval-resolved', sessionId: entry.sessionId })
      return { ok: true }
    },

    /**
     * Answer a pending clarification.
     * @param {object} input input.
     * @param {string} input.clarifyId clarification id.
     * @param {string} input.response free-text or chosen label.
     * @param {string} input.sessionId session id.
     * @returns {{ok: boolean}} outcome.
     */
    respondClarification({ clarifyId, response, sessionId }) {
      const entry = pendingQuestions.get(clarifyId)
      if (entry === undefined) return { ok: false }
      pendingQuestions.delete(clarifyId)
      entry.resolve({ answers: [{ selected: response }] })
      notify({ kind: 'clarify-resolved', sessionId: entry.sessionId })
      return { ok: true }
    },

    pendingApproval,
    pendingClarification,

    /**
     * Dispose host hooks.
     * @returns {void}
     */
    dispose() {
      disposeApproval?.()
      disposeQuestions?.()
      for (const entry of pendingApprovals.values()) entry.reject(new Error('facade shutting down'))
      for (const entry of pendingQuestions.values()) entry.reject(new Error('facade shutting down'))
      pendingApprovals.clear()
      pendingQuestions.clear()
    },
  }
}
