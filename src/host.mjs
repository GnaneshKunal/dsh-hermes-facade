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
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

/** How long a pending interaction waits before it is released to the GUI. */
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The one grant DeepSeek Harness's approval contract accepts
 * (`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`;
 * "allowed-once is the only grant").
 */
const APPROVAL_GRANT = 'allowed-once'

/**
 * Translate the app's four-way approval choice onto the DSH outcome vocabulary.
 *
 * Hermex offers once/session/always/deny, but DeepSeek Harness grants one
 * decision at a time: there is no host-side session or always scope. All three
 * allow choices therefore resolve the pending ask with 'allowed-once', and the
 * wider scope is remembered by the facade (see `sessionGrants`/`alwaysGrants`)
 * so later asks for the same tool are answered without a fresh card. An
 * unrecognised choice is refused rather than silently granted.
 * @param {string} choice app choice: once|session|always|deny.
 * @returns {{outcome: string, scope: string}|undefined} decision, undefined for an unknown choice.
 */
export function approvalDecision(choice) {
  switch (choice) {
    case 'once': return { outcome: APPROVAL_GRANT, scope: 'once' }
    case 'session': return { outcome: APPROVAL_GRANT, scope: 'session' }
    case 'always': return { outcome: APPROVAL_GRANT, scope: 'always' }
    case 'deny': return { outcome: 'rejected', scope: 'deny' }
    default: return undefined
  }
}

/** How long a model catalog read is reused before asking the host again. */
const CATALOG_TTL_MS = 15 * 1000

/** MIME type for one file path. */
function contentTypeFor(file) {
  const ext = String(file).toLowerCase().split('.').pop() ?? ''
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Effort ids one catalog model advertises.
 * @param {object|undefined} entry catalog model or group model entry.
 * @returns {string[]} effort ids, empty when the model declares none.
 */
function effortIdsOf(entry) {
  const efforts = entry?.reasoning?.efforts
  if (!Array.isArray(efforts)) return []
  return efforts
    .map(effort => (typeof effort === 'string' ? effort : String(effort?.id ?? '')))
    .filter(id => id.length > 0)
}

/**
 * Find one model in a ModelCatalog.
 * @param {object} catalog ModelCatalog value.
 * @param {string|undefined} provider provider route.
 * @param {string|undefined} model model id.
 * @returns {{provider: string, model: string, entry: object}|undefined} match.
 */
function catalogModel(catalog, provider, model) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  for (const group of groups) {
    const providerId = String(group?.id ?? group?.name ?? '')
    if (typeof provider === 'string' && provider.length > 0 && providerId !== provider) continue
    for (const entry of Array.isArray(group?.models) ? group.models : []) {
      const modelId = String(entry?.id ?? '')
      if (typeof model === 'string' && model.length > 0 && modelId !== model) continue
      return { provider: providerId, model: modelId, entry }
    }
  }
  return undefined
}

/**
 * Translate one effort id to the vocabulary a model declares.
 *
 * The iOS client ships its own level names; a level the model does not offer is
 * otherwise rejected by the adapter even though both names mean the same thing.
 * @param {string} requested effort from the client.
 * @param {string[]} supported ids the model advertises.
 * @returns {string|undefined} an offered id, or undefined when none matches.
 */
function coerceEffort(requested, supported) {
  if (!Array.isArray(supported) || supported.length === 0) return requested
  if (supported.includes(requested)) return requested
  /** Names different clients use for the same level. */
  const aliases = { none: ['off'], off: ['none'], minimal: ['low'], low: ['minimal'], xhigh: ['max'], max: ['xhigh'] }
  for (const candidate of aliases[requested] ?? []) {
    if (supported.includes(candidate)) return candidate
  }
  return undefined
}

/**
 * Split a client model request into a catalog id and provider route.
 *
 * Hermex sends bare catalog ids plus a `model_provider` it parsed from the
 * picker group, and some hosts send `provider:id` inside the model field for
 * non-default providers; accept both shapes.
 * @param {string} model model id from the client.
 * @param {string|undefined} provider explicit provider from the client.
 * @returns {{model: string, provider?: string}} normalized request.
 */
function parseModelRequest(model, provider) {
  let requestedModel = String(model ?? '').trim()
  let requestedProvider = typeof provider === 'string' && provider.trim().length > 0 ? provider.trim() : undefined
  if (requestedModel.startsWith('@')) {
    const colon = requestedModel.lastIndexOf(':')
    if (colon > 1) {
      requestedProvider = requestedProvider ?? requestedModel.slice(1, colon)
      requestedModel = requestedModel.slice(colon + 1)
    }
  }
  return { model: requestedModel, ...(requestedProvider === undefined ? {} : { provider: requestedProvider }) }
}

/**
 * Unwrap the recorded model-selection projection.
 *
 * DSH projects `values.modelSelection = {lastUsed, next|pending}`
 * (`SessionProjectionMap`); the flat shape is only used by early drafts, so
 * reading it alone makes every effort read look unset and every write send no
 * provider/model.
 * @param {object|undefined} row session list row.
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}|undefined} selection.
 */
function selectionOf(row) {
  const projection = row?.projections?.values?.modelSelection
  if (projection === null || typeof projection !== 'object') return undefined
  const chosen = projection.next ?? projection.pending ?? projection.lastUsed ?? projection
  if (chosen === null || typeof chosen !== 'object') return undefined
  const model = chosen.model
  const selection = {
    ...(typeof chosen.provider === 'string' ? { provider: chosen.provider } : {}),
    ...(typeof model === 'string' ? { model } : (typeof model?.id === 'string' ? { model: model.id } : {})),
    ...(typeof chosen.reasoningEffort === 'string' ? { reasoningEffort: chosen.reasoningEffort } : {}),
  }
  return Object.keys(selection).length > 0 ? selection : undefined
}

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
  /** Short-lived cache of the model catalog: a cold read queries every provider. */
  let catalogCache
  let catalogCacheAt = 0

  /**
   * Model catalog, cached briefly so a composer open does not query every
   * provider. A failed read returns the last good value (or {}) and retries on
   * the next call instead of pinning the failure.
   * @returns {Promise<object>} ModelCatalog value.
   */
  async function modelCatalog() {
    if (catalogCache !== undefined && Date.now() - catalogCacheAt < CATALOG_TTL_MS) return catalogCache
    try {
      const value = await invoke('session', 'modelCatalog', {})
      catalogCache = value ?? {}
      catalogCacheAt = Date.now()
      return catalogCache
    } catch (error) {
      logger.warn?.('hermes-facade: modelCatalog failed: ' + String(error?.message ?? error))
      return catalogCache ?? {}
    }
  }

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

  /**
   * Pending approvals, keyed by the id the phone answers with. The display
   * fields are kept here, not only in the live notice: a phone that re-attaches
   * asks GET /api/approval/pending and must get the command/description back.
   * @type {Map<string, {sessionId: string, toolName: string, pending: object, resolve: Function, reject: Function}>}
   */
  const pendingApprovals = new Map()
  /**
   * Pending clarifications, keyed the same way and kept for the same reason:
   * the app classifies a clarification by its question or choices_offered, so a
   * payload with only clarify_id renders as an approval that can never answer.
   * @type {Map<string, {sessionId: string, questionId?: string, pending: object, resolve: Function, reject: Function}>}
   */
  const pendingQuestions = new Map()
  /** Tool names allowed for the rest of one session, and for the whole process. */
  const sessionGrants = new Map()
  const alwaysGrants = new Set()
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

  /**
   * Whether a standing grant answers this ask without showing a card.
   * @param {string} sessionId session id.
   * @param {string} toolName tool the ask is about.
   * @returns {boolean} granted.
   */
  function standingGrant(sessionId, toolName) {
    if (toolName.length === 0) return false
    if (alwaysGrants.has(toolName)) return true
    return sessionGrants.get(sessionId)?.has(toolName) === true
  }

  /**
   * Remember an "Allow session" / "Always allow" choice.
   * @param {string} sessionId session id.
   * @param {string} toolName tool that was allowed.
   * @param {string} scope session|always.
   * @returns {void}
   */
  function rememberGrant(sessionId, toolName, scope) {
    if (toolName.length === 0) return
    if (scope === 'always') {
      alwaysGrants.add(toolName)
      return
    }
    if (scope !== 'session') return
    const tools = sessionGrants.get(sessionId) ?? new Set()
    tools.add(toolName)
    sessionGrants.set(sessionId, tools)
  }

  // Approvals arrive as a cordis waterfall: prepending means we are asked
  // first, and calling next() hands the question back to the GUI.
  const disposeApproval = ctx.on('approval/request', (request, next) => {
    const sessionId = String(request?.agent?.id ?? '')
    const toolName = typeof request?.toolName === 'string' ? request.toolName.trim() : ''
    // DeepSeek Harness grants one decision at a time ('allowed-once' is the
    // whole grant vocabulary), so "Allow session" and "Always allow" are kept
    // as facade-side standing grants and replayed as 'allowed-once' here. The
    // choice is therefore not collapsed into a one-shot answer: later asks for
    // the same tool are answered without showing the card again.
    if (sessionId.length > 0 && standingGrant(sessionId, toolName)) return Promise.resolve(APPROVAL_GRANT)
    if (!sessionId || !hasStreamClient(sessionId)) {
      // No phone attached: the GUI answers, and any card left from an earlier
      // attach is told the request is no longer the facade's.
      return Promise.resolve(next()).finally(() => {
        notify({ kind: 'approval-resolved', sessionId, reason: 'delegated' })
      })
    }
    const approvalId = String(request?.callId ?? request?.approvalId ?? randomUUID())
    // displayReason is localized copy ({en, …}); the app shows one string, so
    // prefer its English form and fall back to the asker's raw reason.
    const displayReason = request?.displayReason
    const description = typeof displayReason === 'string'
      ? displayReason
      : (typeof displayReason?.en === 'string'
        ? displayReason.en
        : (typeof request?.reason === 'string' ? request.reason : undefined))
    // The phone loses these fields after a reconnect unless the pending record
    // keeps them: GET /api/approval/pending serves this exact object.
    const pending = {
      approval_id: approvalId,
      ...(toolName.length === 0 ? {} : { command: toolName }),
      ...(description === undefined || description.length === 0 ? {} : { description }),
    }
    return new Promise((resolve, reject) => {
      let settled = false
      /**
       * Remove the request and tell the phone its card is over.
       * @param {string} reason timeout|cancelled.
       * @returns {boolean} whether this call withdrew the request.
       */
      const withdraw = reason => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        pendingApprovals.delete(approvalId)
        notify({ kind: 'approval-resolved', sessionId, approvalId, reason })
        return true
      }
      const timer = setTimeout(() => {
        // An unanswered ask expires: retract the card first, then hand the
        // question to the GUI, which is where an abandoned prompt belongs.
        if (!withdraw('timeout')) return
        resolve(next())
      }, INTERACTION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingApprovals.set(approvalId, {
        sessionId,
        toolName,
        pending,
        resolve: outcome => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pendingApprovals.delete(approvalId)
          resolve(outcome)
        },
        reject: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pendingApprovals.delete(approvalId)
          reject(error)
        },
      })
      // A cancelled turn withdraws the ask; the sheet must go with it.
      request?.signal?.addEventListener?.('abort', () => {
        if (!withdraw('cancelled')) return
        resolve('cancelled')
      }, { once: true })
      notify({ kind: 'approval', sessionId, pending })
    })
  }, { prepend: true })

  const disposeQuestions = ctx.on('user-questions/request', (request, next) => {
    const sessionId = String(request?.agent?.id ?? '')
    if (!sessionId || !hasStreamClient(sessionId)) return next()
    const clarifyId = String(request?.id ?? randomUUID())
    const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
    // The app classifies a pending payload by question/choices_offered; a bare
    // clarify_id decodes as an approval, whose respond can never succeed.
    const pending = {
      clarify_id: clarifyId,
      question: typeof first?.question === 'string' ? first.question : '',
      ...(Array.isArray(first?.options)
        ? { choices_offered: first.options.map(option => option?.label).filter(label => typeof label === 'string' && label.length > 0) }
        : {}),
      session_id: sessionId,
      requested_at: Math.floor(Date.now() / 1000),
    }
    return new Promise((resolve, reject) => {
      let settled = false
      /**
       * Remove the question and tell the phone its card is over.
       * @param {string} reason timeout|cancelled.
       * @returns {boolean} whether this call withdrew the question.
       */
      const withdraw = reason => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        pendingQuestions.delete(clarifyId)
        notify({ kind: 'clarify-resolved', sessionId, clarifyId, reason })
        return true
      }
      const timer = setTimeout(() => {
        if (!withdraw('timeout')) return
        resolve(next())
      }, INTERACTION_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      pendingQuestions.set(clarifyId, {
        sessionId,
        ...(typeof first?.id === 'string' && first.id.length > 0 ? { questionId: first.id } : {}),
        pending,
        resolve: answers => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pendingQuestions.delete(clarifyId)
          resolve(answers)
        },
        reject: error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          pendingQuestions.delete(clarifyId)
          reject(error)
        },
      })
      // A cancelled turn withdraws the question; close the sheet with it.
      request?.signal?.addEventListener?.('abort', () => {
        if (!withdraw('cancelled')) return
        const cancelled = Object.assign(
          new Error('the user-questions request was cancelled'),
          { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
        )
        reject(cancelled)
      }, { once: true })
      notify({ kind: 'clarify', sessionId, pending })
    })
  }, { prepend: true })

  /**
   * Whether a session currently has an attached stream (and thus a human).
   * @param {string} sessionId session id.
   * @returns {boolean} has client.
   */
  let hasStreamClient = () => false

  /**
   * Pending approval for a session, with the fields a re-attached phone needs.
   * @param {string} sessionId session id.
   * @returns {object|undefined} pending payload.
   */
  function pendingApproval(sessionId) {
    for (const entry of pendingApprovals.values()) {
      if (entry.sessionId === sessionId) return { ...entry.pending }
    }
    return undefined
  }

  /**
   * Pending clarification for a session, with question and choices_offered.
   * @param {string} sessionId session id.
   * @returns {object|undefined} pending payload.
   */
  function pendingClarification(sessionId) {
    for (const entry of pendingQuestions.values()) {
      if (entry.sessionId === sessionId) return { ...entry.pending }
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
      // DSH subagent sessions are runner-owned and only addressable through
      // their durable parent; a plain chat row would fail when opened. Hide
      // them for now (Hermex's own toggle needs row tagging + parent-address
      // reads, which are future work).
      return (Array.isArray(value?.items) ? value.items : [])
        .filter(item => item?.origin !== 'subagent')
    },

    /**
     * Search visible session content without resuming an agent.
     * @param {string} query literal message-content query.
     * @returns {Promise<{items: Array<{sessionId: string, snippet: string}>, hasMore: boolean}>} hits.
     */
    async searchSessions(query) {
      const value = await invoke('session', 'search', { request: { query: String(query ?? '') } })
      return {
        items: (Array.isArray(value?.items) ? value.items : [])
          .filter(item => typeof item?.sessionId === 'string' && item.sessionId.length > 0)
          .map(item => ({
            sessionId: item.sessionId,
            snippet: typeof item.snippet === 'string' ? item.snippet : '',
          })),
        hasMore: value?.hasMore === true,
      }
    },

    /**
     * The session's token and context usage, read from its projections.
     *
     * DSH reports provider usage in two places: `tokenUsage` accumulates the
     * complete log (uncached input, output, cache reads/writes), and
     * `contextPressure` names the newest request's prompt size and the route's
     * capacity. There is no price or cost projection anywhere.
     * @param {string} sessionId session id.
     * @returns {Promise<{input_tokens?: number, output_tokens?: number, context_length?: number, last_prompt_tokens?: number}>} usage.
     */
    async sessionUsage(sessionId) {
      const value = await invoke('session', 'projections', { request: { sessionId } })
      const values = value?.values ?? {}
      const token = values.tokenUsage
      const pressure = values.contextPressure
      const input = Number.isFinite(token?.uncachedInputTokens)
        ? token.uncachedInputTokens + (Number.isFinite(token.cacheReadTokens) ? token.cacheReadTokens : 0)
          + (Number.isFinite(token.cacheWriteTokens) ? token.cacheWriteTokens : 0)
        : undefined
      const output = Number.isFinite(token?.outputTokens) ? token.outputTokens : undefined
      const max = Number.isFinite(pressure?.contextWindow) ? pressure.contextWindow : undefined
      // last_prompt_tokens is the provider's actual prompt size, the same number
      // the upstream host reports; projectedTokens is a heuristic for the NEXT
      // request, so it is deliberately not a fallback.
      const used = Number.isFinite(pressure?.pressureTokens) ? pressure.pressureTokens : undefined
      return {
        ...(input === undefined ? {} : { input_tokens: input }),
        ...(output === undefined ? {} : { output_tokens: output }),
        ...(max === undefined || max <= 0 ? {} : { context_length: max }),
        ...(used === undefined ? {} : { last_prompt_tokens: used }),
      }
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
      } catch (error) {
        if (/durable parent address|owned by subagent routing/i.test(String(error?.message ?? error))) {
          const rejected = new Error('This is a subagent session; open the parent chat instead.')
          rejected.code = 'subagent-session'
          throw rejected
        }
        throw error
      } finally {
        controller.abort(new Error('snapshot received'))
      }
    },

    /**
     * Ensure a session exists, creating one when needed.
     * @param {string} [sessionId] preferred id.
     * @returns {Promise<string>} the id to use.
     */
    async ensureSession(sessionId, workspacePath, workspaceId) {
      const request = {}
      if (sessionId) request.sessionId = sessionId
      // workspaceId and cwd are EXCLUSIVE in session/create: cwd creates a
      // session that owns a directory but joins no Workspace, which is what
      // the GUI shows as "ungrouped". Joining the Workspace is what groups it.
      //
      // Two callers name the workspace differently: the composer sends a path
      // (workspace), the project lanes send our own project_id, which IS the
      // DSH workspace id. Accept either.
      let target
      if (typeof workspaceId === 'string' && workspaceId.length > 0) {
        const { workspaces } = await this.workspaces()
        target = workspaces.find(workspace => workspace.id === workspaceId)?.id
      }
      if (target === undefined && typeof workspacePath === 'string' && workspacePath.length > 0) {
        target = await this.ensureWorkspace(workspacePath)
      }
      if (target !== undefined) request.workspaceId = target
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
      return selectionOf(row)
    },

    /**
     * Change the model (and keep a compatible reasoning effort) for one session.
     *
     * The client's model picker calls `POST /api/session/update`; applying the
     * pick through `session/selectModel` is what makes the next turn actually
     * use it. The effort is carried over when the new model offers it, otherwise
     * the new model's default (or its first level) is used, so switching models
     * never fails just because the previous effort does not exist there.
     * @param {object} input request.
     * @param {string} input.sessionId session to change.
     * @param {string} input.model model id from the client.
     * @param {string} [input.provider] provider route from the client.
     * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}>} accepted selection.
     */
    async selectModel({ sessionId, model, provider }) {
      const requested = parseModelRequest(model, provider)
      if (requested.model.length === 0) throw new Error('model is required')
      const current = await this.modelSelection(sessionId).catch(() => undefined)
      const catalog = await modelCatalog()
      let match = catalogModel(catalog, requested.provider ?? current?.provider, requested.model)
      if (match === undefined && requested.provider === undefined) {
        match = catalogModel(catalog, undefined, requested.model)
      }
      if (match === undefined) {
        throw new Error('model "' + requested.model + '"' +
          (requested.provider === undefined ? '' : ' for provider "' + requested.provider + '"') +
          ' is not available in the model catalog')
      }
      const offered = effortIdsOf(match.entry)
      let reasoningEffort
      if (offered.length > 0) {
        // Carry the current effort over when the new model offers it (or an
        // alias); otherwise use the new model's declared default, and only then
        // its first level. Falling straight to offered[0] would quietly pick
        // "off"/"low" when the new model declares a higher default.
        const declaredDefault = typeof match.entry?.reasoning?.defaultEffort === 'string'
          && offered.includes(match.entry.reasoning.defaultEffort)
          ? match.entry.reasoning.defaultEffort
          : undefined
        const carried = current?.reasoningEffort === undefined
          ? undefined
          : coerceEffort(String(current.reasoningEffort), offered)
        reasoningEffort = carried ?? declaredDefault ?? offered[0]
      }
      const value = await invoke('session', 'selectModel', {
        request: {
          sessionId,
          provider: match.provider,
          model: match.model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
      })
      const selected = value?.selected ?? {}
      const acceptedProvider = typeof selected.provider === 'string' ? selected.provider : match.provider
      const acceptedModel = typeof selected.model === 'string' ? selected.model : match.model
      const acceptedEffort = typeof selected.reasoningEffort === 'string' ? selected.reasoningEffort : reasoningEffort
      return {
        provider: acceptedProvider,
        model: acceptedModel,
        ...(acceptedEffort === undefined ? {} : { reasoningEffort: acceptedEffort }),
      }
    },

    /**
     * Reasoning-effort state of a session.
     *
     * The effort in force is the session's recorded selection; the levels on
     * offer are the ones the selected model declares in the model catalog.
     *
     * @param {object} input input.
     * @param {string} [input.sessionId] session id.
     * @param {string} [input.provider] explicit provider (composer query).
     * @param {string} [input.model] explicit model (composer query).
     * @returns {Promise<{provider?: string, model?: string, effort: string, supportedEfforts: string[]}>} state.
     */
    async reasoning({ sessionId, provider, model }) {
      const catalog = await modelCatalog()
      const selection = typeof sessionId === 'string' && sessionId.length > 0
        ? await this.modelSelection(sessionId)
        : undefined
      const resolvedProvider = provider ?? selection?.provider ?? catalog?.default?.provider
      const resolvedModel = model ?? selection?.model ?? catalog?.default?.model
      const match = catalogModel(catalog, resolvedProvider, resolvedModel)
      const offered = effortIdsOf(match?.entry)
      const selectionEffort = selection !== undefined && selection.model === (match?.model ?? resolvedModel)
        ? selection.reasoningEffort
        : undefined
      const effort = selectionEffort ??
        match?.entry?.reasoning?.defaultEffort ??
        catalog?.default?.reasoningEffort ??
        (offered.length > 0 ? offered[Math.floor(offered.length / 2)] : 'medium')
      return {
        ...(typeof resolvedProvider === 'string' ? { provider: resolvedProvider } : {}),
        ...(typeof resolvedModel === 'string' ? { model: resolvedModel } : {}),
        effort: String(effort),
        supportedEfforts: offered.length > 0 ? offered : ['off', 'low', 'medium', 'high', 'max'],
      }
    },

    /**
     * Change the reasoning effort of a session.
     *
     * DSH has no separate effort endpoint: effort is part of the model
     * selection, so the current provider/model are replayed with the new effort.
     * selectModel requires BOTH, which is why they are resolved from the catalog
     * when the session has not recorded a selection yet.
     *
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {string} input.effort effort id.
     * @returns {Promise<{ok: boolean, effort: string, provider: string, model: string, supportedEfforts: string[]}>} outcome.
     */
    async setReasoningEffort({ sessionId, effort }) {
      const state = await this.reasoning({ sessionId })
      const provider = state.provider
      const model = state.model
      if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
        throw new Error('no model is selected for this session yet, so its reasoning effort cannot be changed')
      }
      const offered = state.supportedEfforts
      const wanted = coerceEffort(effort, offered)
      if (wanted === undefined) {
        throw Object.assign(
          new Error('effort "' + effort + '" is not offered by ' + provider + '/' + model + '; use one of ' + offered.join(', ')),
          { code: 'effort-unsupported', supportedEfforts: offered },
        )
      }
      const value = await invoke('session', 'selectModel', {
        request: { sessionId, provider, model, reasoningEffort: wanted },
      })
      const selected = value?.selected
      return {
        ok: true,
        effort: typeof selected?.reasoningEffort === 'string' ? selected.reasoningEffort : wanted,
        provider: typeof selected?.provider === 'string' ? selected.provider : provider,
        model: typeof selected?.model === 'string' ? selected.model : model,
        supportedEfforts: offered,
      }
    },

    /**
     * Serve a file referenced by a chat: an absolute path, a session-relative
     * path, or an attachment id from DSH's content-addressed store.
     * @param {string} sessionId session the reference belongs to.
     * @param {string} reference path or attachment id.
     * @returns {Promise<{body: Buffer, contentType: string}|undefined>} file bytes.
     */
    async readMedia(sessionId, reference) {
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

      const resolved = await this.resolvePath(sessionId, raw)
      if (resolved === undefined) return undefined
      try {
        const body = await readFile(resolved)
        return { body, contentType: contentTypeFor(resolved) }
      } catch {
        return undefined
      }
    },

    /**
     * Resolve a client-supplied path: absolute as-is, otherwise relative to the
     * session's working directory. An empty reference means "the session cwd".
     * @param {string} sessionId session id.
     * @param {string} reference path or empty.
     * @returns {Promise<string|undefined>} absolute path.
     */
    async resolvePath(sessionId, reference) {
      const raw = String(reference ?? '').trim()
      if (raw.startsWith('/')) return raw
      const cwd = await this.cwdOf(sessionId)
      if (cwd === undefined) return undefined
      return raw.length === 0 ? cwd : join(cwd, raw)
    },

    /**
     * List one directory for the workspace file browser (GET /api/list).
     * @param {string} sessionId session id (defines the relative-path base).
     * @param {string} reference directory path, absolute or session-relative.
     * @returns {Promise<object|undefined>} listing, undefined when absent.
     */
    async listDir(sessionId, reference) {
      const target = await this.resolvePath(sessionId, reference)
      if (target === undefined) return undefined
      let dirents
      try {
        dirents = await readdir(target, { withFileTypes: true })
      } catch {
        return undefined
      }
      const entries = []
      for (const dirent of dirents) {
        const full = join(target, dirent.name)
        let size
        let modified
        try {
          const stats = await stat(full)
          size = stats.size
          modified = Math.floor(stats.mtimeMs / 1000)
        } catch { /* vanished between readdir and stat */ }
        entries.push({
          name: dirent.name,
          path: full,
          is_dir: dirent.isDirectory(),
          kind: dirent.isDirectory() ? 'dir' : 'file',
          ...(size === undefined ? {} : { size }),
          ...(modified === undefined ? {} : { modified }),
        })
      }
      entries.sort((left, right) => (left.is_dir === right.is_dir
        ? left.name.localeCompare(right.name)
        : (left.is_dir ? -1 : 1)))
      return {
        path: target,
        name: basename(target) || target,
        parent: dirname(target),
        entries,
        dirs: entries.filter(entry => entry.is_dir).map(entry => entry.name),
        files: entries.filter(entry => !entry.is_dir).map(entry => entry.name),
        count: entries.length,
      }
    },

    /**
     * Read one text file for the workspace file browser (GET /api/file).
     * @param {string} sessionId session id (defines the relative-path base).
     * @param {string} reference file path, absolute or session-relative.
     * @param {object} [options] options.
     * @param {number} [options.maxBytes] read only this prefix (a preview).
     * @returns {Promise<object|undefined>} file payload, undefined when absent or binary.
     */
    async readText(sessionId, reference, options = {}) {
      const target = await this.resolvePath(sessionId, reference)
      if (target === undefined) return undefined
      const maxBytes = Number.isSafeInteger(options?.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : undefined
      let body
      let size
      try {
        if (maxBytes === undefined) {
          body = await readFile(target)
          size = body.length
        } else {
          // A preview must not load a large file whole: read the window only.
          const handle = await open(target, 'r')
          try {
            const info = await handle.stat()
            if (info.isDirectory()) return undefined
            size = info.size
            const length = Math.min(size, maxBytes)
            const buffer = Buffer.alloc(length)
            let offset = 0
            while (offset < length) {
              const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
              if (bytesRead === 0) break
              offset += bytesRead
            }
            body = buffer.subarray(0, offset)
          } finally {
            await handle.close()
          }
        }
      } catch {
        return undefined
      }
      // A binary file belongs on /api/file/raw; a NUL byte is a cheap tell.
      if (body.includes(0)) return undefined
      const content = body.toString('utf8')
      return {
        content,
        path: target,
        name: basename(target),
        language: extname(target).replace(/^\./, '').toLowerCase(),
        size: size ?? body.length,
        lines: content.length === 0 ? 0 : content.split('\n').length,
        truncated: (size ?? body.length) > body.length,
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
      // ModelCatalog: { default: {provider, model}, groups: [{id, name, models:[{id,name,reasoning}]}], failures }
      return modelCatalog()
    },

    /**
     * Warm the catalog so the first composer open is not a cold, slow read.
     * @returns {void}
     */
    warm() {
      void modelCatalog().catch(() => {})
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
     * Workspace list plus the registry-global pin/archive sets.
     *
     * The pin and archive state is not per-workspace and has no Remote of its
     * own; it rides on the workspace/follow baseline, so it is captured here
     * (and cached with the workspaces) rather than through a second read.
     *
     * @returns {Promise<{workspaces: Array<object>, pinnedSessionIds: Array<string>, archivedSessionIds: Array<string>}>} workspace snapshot.
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
        // The baseline also carries the registry-global pin and archive sets.
        // They are not workspace fields: an archived session keeps its
        // `sessionIds` slot, and a pin is independent of grouping. Keep them on
        // the same value so a list read does not need a second baseline.
        workspaceCache = {
          workspaces: items
            .filter(item => typeof item?.path === 'string' && item.path.length > 0)
            .map(item => ({
              id: String(item.workspaceId ?? item.path),
              name: typeof item.title === 'string' && item.title.length > 0 ? item.title : String(item.path),
              path: String(item.path),
              sessionIds: (Array.isArray(item.sessionIds) ? item.sessionIds : []).map(String),
            })),
          pinnedSessionIds: (Array.isArray(baseline?.pinnedSessionIds) ? baseline.pinnedSessionIds : []).map(String),
          archivedSessionIds: (Array.isArray(baseline?.archivedSessionIds) ? baseline.archivedSessionIds : []).map(String),
        }
        workspaceCacheAt = Date.now()
        return workspaceCache
      } catch (error) {
        logger.warn?.('hermes-facade: workspace/follow failed: ' + String(error?.message ?? error))
        return { workspaces: [], pinnedSessionIds: [], archivedSessionIds: [] }
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
     * File an existing session under a workspace.
     *
     * Hermex creates the session first (profile only) and only names the
     * workspace on the following chat/start, so the session has to be adopted
     * afterwards or it stays ungrouped.
     *
     * @param {object} input input.
     * @param {string} input.sessionId session id.
     * @param {string} input.workspacePath directory path.
     * @returns {Promise<{ok: boolean, workspaceId?: string}>} outcome.
     */
    async adoptSession({ sessionId, workspacePath }) {
      const workspaceId = await this.ensureWorkspace(workspacePath)
      await invoke('workspace', 'insertSessionBefore', { request: { workspaceId, sessionId } })
      workspaceCache = undefined
      workspaceCacheAt = 0
      return { ok: true, workspaceId }
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
      // The pin set is part of the cached baseline, so the next list read must
      // fetch it again or the new pin stays invisible for the cache window.
      workspaceCache = undefined
      workspaceCacheAt = 0
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
     * Answer a pending approval with one of the app's four choices.
     *
     * All three allow choices resolve the ask with 'allowed-once' (the only
     * grant DeepSeek Harness accepts); "session"/"always" also leave a standing
     * grant so later asks for the same tool are answered automatically. An
     * already-resolved (or timed-out) id reports stale, which the HTTP layer
     * turns into the 409 the app reads as "that prompt already expired".
     * @param {object} input input.
     * @param {string} input.approvalId approval id.
     * @param {string} input.choice once|session|always|deny.
     * @returns {{ok: boolean, stale?: boolean, choice?: string, outcome?: string, error?: string}} outcome.
     */
    respondApproval({ approvalId, choice }) {
      const entry = pendingApprovals.get(approvalId)
      if (entry === undefined) return { ok: false, stale: true }
      const decision = approvalDecision(choice)
      // A choice we cannot name is not a grant: keep the card up rather than
      // answering "allowed-once" on the user's behalf.
      if (decision === undefined) return { ok: false, error: 'unknown approval choice: ' + String(choice) }
      entry.resolve(decision.outcome)
      rememberGrant(entry.sessionId, entry.toolName, decision.scope)
      notify({ kind: 'approval-resolved', sessionId: entry.sessionId, approvalId, reason: 'answered' })
      return { ok: true, choice: decision.scope, outcome: decision.outcome }
    },

    /**
     * Answer a pending clarification.
     * @param {object} input input.
     * @param {string} input.clarifyId clarification id.
     * @param {string} input.response free-text or chosen label.
     * @param {string} input.sessionId session id.
     * @returns {{ok: boolean, stale?: boolean}} outcome.
     */
    respondClarification({ clarifyId, response, sessionId }) {
      const entry = pendingQuestions.get(clarifyId)
      if (entry === undefined) return { ok: false, stale: true }
      // The answer batch names the question it answers: the host schema
      // (AskUserQuestionAnswerItem) requires the id echoed in the request.
      entry.resolve({
        answers: [{
          ...(entry.questionId === undefined ? {} : { id: entry.questionId }),
          selected: [response],
        }],
      })
      notify({ kind: 'clarify-resolved', sessionId: entry.sessionId, clarifyId, reason: 'answered' })
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
      sessionGrants.clear()
      alwaysGrants.clear()
    },
  }
}
