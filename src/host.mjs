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
              assistantStream: false,
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
    async ensureSession(sessionId) {
      const value = await invoke('session', 'create', { request: sessionId ? { sessionId } : {} })
      const created = value?.sessionId
      if (typeof created !== 'string' || created.length === 0) throw new Error('session/create returned no sessionId')
      return created
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
      try {
        const value = await invoke('workspace', 'list', {})
        const items = Array.isArray(value?.items) ? value.items : Array.isArray(value?.workspaces) ? value.workspaces : []
        return {
          workspaces: items
            .map(item => (typeof item === 'string' ? { path: item, name: item } : { path: item?.path, name: item?.name ?? item?.path }))
            .filter(item => typeof item.path === 'string'),
        }
      } catch {
        return { workspaces: [] }
      }
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
