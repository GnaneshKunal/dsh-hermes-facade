/**
 * Runs one chat turn against the facade's SSE stream and republishes it as the
 * Hermes event vocabulary.
 *
 * The facade already did the hard mapping (DSH assistant-stream chunks, tool
 * calls, approvals, clarify, turn outcome). This module only renames and
 * re-shapes its frames, and owns the reverse requests for approvals and
 * clarifications.
 *
 * @module dsh-hermes-facade/src/hermes/turn
 */

import { publishSessionsChanged } from './events.mjs'
import { TERMINAL_BACKEND } from './protocol.mjs'
import { usageOf } from './shapes.mjs'

/** How long an approval or question may stay unanswered. */
const REQUEST_TTL_MS = 10 * 60 * 1000

/**
 * Parse an SSE data payload.
 * @param {string} data raw data.
 * @returns {object} parsed object, or {}.
 */
function jsonOf(data) {
  try {
    const value = JSON.parse(data)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * The live state a session.info frame must carry: the composer restores its
 * model and effort chips from it, and a missing field clears them.
 *
 * @param {object} backend facade client.
 * @param {string} sessionId session id.
 * @returns {Promise<object>} info fields without `running`.
 */
async function infoPayload(backend, sessionId) {
  // The Files/Git entries appear only when the host names a local backend.
  const info = { session_id: sessionId, terminal_backend: TERMINAL_BACKEND }
  try {
    const list = await backend.call('GET', '/api/sessions', { query: { include_archived: 1 } })
    const rows = Array.isArray(list.json?.sessions) ? list.json.sessions : []
    const row = rows.find(entry => String(entry?.session_id ?? entry?.sessionId ?? '') === sessionId)
    if (row !== undefined) {
      if (typeof row.model === 'string' && row.model.length > 0) info.model = row.model
      if (typeof row.model_provider === 'string' && row.model_provider.length > 0) info.provider = row.model_provider
      if (typeof row.title === 'string' && row.title.length > 0) info.title = row.title
      if (typeof row.workspace === 'string' && row.workspace.length > 0) info.cwd = row.workspace
    }
  } catch { /* the state is advisory; the turn still runs */ }
  // A session that has never picked a model has no modelSelection projection,
  // so its row names none and the composer's chip would be blank. It still runs
  // on the catalog's default, which is what the picker already shows.
  if (info.model === undefined || info.provider === undefined) {
    try {
      const models = await backend.call('GET', '/api/models')
      if (info.model === undefined && typeof models.json?.default_model === 'string' && models.json.default_model.length > 0) {
        info.model = models.json.default_model
      }
      if (info.provider === undefined && typeof models.json?.active_provider === 'string' && models.json.active_provider.length > 0) {
        info.provider = models.json.active_provider
      }
    } catch { /* the catalog is advisory */ }
  }
  try {
    const reasoning = await backend.call('GET', '/api/reasoning', { query: { session_id: sessionId } })
    const effort = reasoning.json?.effective_effort ?? reasoning.json?.effort
    if (typeof effort === 'string' && effort.length > 0) info.reasoning_effort = effort
  } catch { /* the effort is advisory */ }
  return info
}

/**
 * Create the turn runner.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.hub event hub.
 * @param {Function} options.requestClient reverse-request sender.
 * @param {object} [options.logger] logger.
 * @param {() => number} [options.now] epoch seconds.
 * @returns {object} runner.
 */
export function createTurnRunner({
  backend,
  hub,
  requestClient,
  resolveBackendSession = id => id,
  onSettled,
  logger = console,
  now = () => Math.floor(Date.now() / 1000),
}) {
  /** @type {Map<string, {streamId: string, controller: AbortController, startedAt: number, info: object}>} */
  const active = new Map()
  /** Prompts submitted while the session already had a turn, oldest first. */
  const queued = new Map()
  /** Sessions whose start is still in flight, so a second submit cannot race it. */
  const starting = new Set()

  /**
   * Whether a turn is running for a session.
   * @param {string} sessionId session id.
   * @returns {boolean} running.
   */
  function isRunning(sessionId) {
    return active.has(sessionId)
  }

  /**
   * Start one turn.
   * @param {object} input input.
   * @param {string} input.sessionId session id.
   * @param {string} input.text prompt text.
   * @param {Array<object>} [input.images] image parts ({mediaType,data,name?}).
   * @returns {Promise<object>} prompt.submit reply.
   */
  async function start({ sessionId, text, images = [] }) {
    if ((typeof text !== 'string' || text.length === 0) && (!Array.isArray(images) || images.length === 0)) {
      throw new Error('text required')
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session_id required')
    if (active.has(sessionId) || starting.has(sessionId)) {
      // A second chat/start would create a second stream, and two consumers of
      // the same session split its frames and publish two turn boundaries. Keep
      // the text and run it when the current turn settles. `starting` closes the
      // window between this check and `active.set` below, where two concurrent
      // submits used to both pass.
      const pending = queued.get(sessionId) ?? []
      pending.push({ text, images })
      queued.set(sessionId, pending)
      return { status: 'queued', session_id: sessionId, turn_isolation: null }
    }
    starting.add(sessionId)
    try {
      const backendSessionId = resolveBackendSession(sessionId)
      const started = await backend.call('POST', '/api/chat/start', {
        body: { session_id: backendSessionId, message: text, ...(images.length > 0 ? { images } : {}) },
      })
      const streamId = started.json?.stream_id
      if (started.status !== 200 || typeof streamId !== 'string' || streamId.length === 0) {
        const detail = started.json?.detail ?? started.json?.error ?? ('HTTP ' + started.status)
        throw new Error(String(detail))
      }
      const controller = new AbortController()
      const info = await infoPayload(backend, backendSessionId)
      // The phone holds the draft id for this chat; every frame speaks it.
      info.session_id = sessionId
      const wasRunning = active.has(sessionId)
      active.set(sessionId, { streamId, controller, startedAt: now(), info })
      hub.publish('session.info', { ...info, running: true, turn_started_at: now() }, sessionId)
      // The session list watches the live set, not this chat: tell it a turn
      // started so its row shows Working without waiting for its poll.
      publishSessionsChanged(hub)
      hub.publish('message.start', { role: 'assistant' }, sessionId)
      void pump(sessionId, streamId, controller, info)
      // The client turns the reply's status into the send's outcome: only
      // "streaming" (this send started the turn) and "queued" (a turn was already
      // running) count as accepted. Anything else rolls the optimistic message
      // back into the composer and shows an error, while the turn still runs.
      return {
        status: wasRunning ? 'queued' : 'streaming',
        session_id: sessionId,
        turn_isolation: null,
      }
    } finally {
      starting.delete(sessionId)
    }
  }

  /**
   * Follow the facade stream and republish it.
   * @param {string} sessionId session id.
   * @param {string} streamId facade stream id.
   * @param {AbortController} controller abort handle.
   * @returns {Promise<void>} resolves when the turn ends.
   */
  async function pump(sessionId, streamId, controller, info = { session_id: sessionId }) {
    const toolNames = new Map()
    let text = ''
    let finished = false
    try {
      for await (const frame of backend.stream('/api/chat/stream', {
        query: { stream_id: streamId },
        signal: controller.signal,
      })) {
        const data = jsonOf(frame.data)
        if (frame.event === 'token') {
          const delta = typeof data.text === 'string' ? data.text : ''
          if (delta.length > 0) { text += delta; hub.publish('message.delta', { text: delta }, sessionId) }
        } else if (frame.event === 'reasoning') {
          if (typeof data.text === 'string' && data.text.length > 0) hub.publish('reasoning.delta', { text: data.text }, sessionId)
        } else if (frame.event === 'interim_assistant') {
          hub.publish('message.interim', {
            text: typeof data.text === 'string' ? data.text : '',
            already_streamed: data.already_streamed === true,
          }, sessionId)
        } else if (frame.event === 'tool') {
          const toolId = String(data.tid ?? '')
          const name = String(data.name ?? '')
          if (toolId.length > 0) toolNames.set(toolId, name)
          hub.publish('tool.start', {
            name,
            args: data.args ?? {},
            ...(toolId.length > 0 ? { tool_id: toolId } : {}),
          }, sessionId)
        } else if (frame.event === 'tool_complete') {
          const toolId = String(data.tid ?? '')
          hub.publish('tool.complete', {
            name: toolNames.get(toolId) ?? '',
            ...(toolId.length > 0 ? { tool_id: toolId } : {}),
            result: typeof data.preview === 'string' ? data.preview : '',
            ...(data.is_error === true ? { is_error: true } : {}),
          }, sessionId)
        } else if (frame.event === 'title') {
          if (typeof data.title === 'string' && data.title.length > 0) {
            hub.publish('session.title', { session_id: sessionId, title: data.title }, sessionId)
          }
        } else if (frame.event === 'usage') {
          // The facade's Legacy snapshot shape → the host's context-window
          // vocabulary, which is what the app's ring reads.
          const usage = usageOf(data)
          if (Object.keys(usage).length > 0) hub.publish('session.usage', { usage }, sessionId)
        } else if (frame.event === 'approval') {
          if (data.pending === null || data.pending === undefined) requestClient.cancelSession?.(sessionId, 'resolved')
          else await handleApproval(sessionId, data.pending)
        } else if (frame.event === 'clarify') {
          if (data.pending === null || data.pending === undefined) requestClient.cancelSession?.(sessionId, 'resolved')
          else await handleClarify(sessionId, data.pending)
        } else if (frame.event === 'done') {
          finished = true
          // The contract's literal is "complete"; the client renders anything
          // but interrupted/error as completed, so this only removes drift.
          // An absent/empty usage is not a measurement: reporting input/output 0
          // would look authoritative. The ring needs context_max anyway, so only
          // fields the facade sent are mapped.
          const measured = data.usage !== null && typeof data.usage === 'object'
            && Object.keys(data.usage).length > 0
          hub.publish('message.complete', {
            status: 'complete',
            text,
            ...(measured ? { usage: usageOf(data.usage) } : {}),
          }, sessionId)
          hub.publish('session.info', { ...info, running: false }, sessionId)
          break
        } else if (frame.event === 'error') {
          finished = true
          const message = typeof data.message === 'string' && data.message.length > 0 ? data.message : 'The turn failed.'
          hub.publish('message.complete', { status: 'error', text: message }, sessionId)
          hub.publish('session.info', { ...info, running: false }, sessionId)
          break
        } else if (frame.event === 'cancel') {
          finished = true
          hub.publish('message.complete', { status: 'interrupted', text }, sessionId)
          hub.publish('session.info', { ...info, running: false }, sessionId)
          break
        } else if (frame.event === 'stream_end') {
          break
        }
      }
    } catch (error) {
      if (controller.signal.aborted !== true) {
        logger.warn?.('hermes-gateway: turn stream failed: ' + String(error?.message ?? error))
        hub.publish('message.complete', { status: 'error', text: String(error?.message ?? error) }, sessionId)
        hub.publish('session.info', { ...info, running: false }, sessionId)
        finished = true
      }
    } finally {
      active.delete(sessionId)
      // The list must stop showing this session as busy the moment its turn
      // ends; a status read after this sees it idle and omits it.
      publishSessionsChanged(hub)
      // One turn changes the transcript, so a write-fence revision read before
      // it must no longer match.
      onSettled?.(sessionId)
      requestClient.cancelSession?.(sessionId, 'resolved')
      if (!finished) {
        hub.publish('session.info', { ...info, running: false }, sessionId)
      }
      // A prompt queued behind this turn starts now, on a single stream.
      const pending = queued.get(sessionId)
      const next = pending?.shift()
      if (pending !== undefined && pending.length === 0) queued.delete(sessionId)
      if (next !== undefined) {
        setTimeout(() => {
          start({ sessionId, text: next.text, images: next.images }).catch(error => {
            logger.warn?.('hermes-gateway: queued prompt failed: ' + String(error?.message ?? error))
          })
        }, 0)
      }
    }
  }

  /**
   * Send an approval card as a reverse request and apply the client's choice.
   * @param {string} sessionId session id.
   * @param {object|undefined|null} pending facade pending payload.
   * @returns {Promise<void>} resolves once answered or withdrawn.
   */
  async function handleApproval(sessionId, pending) {
    if (pending === undefined || pending === null) return
    const requestId = String(pending.approval_id ?? '')
    if (requestId.length === 0) return
    const command = typeof pending.command === 'string' && pending.command.length > 0 ? pending.command : undefined
    const description = typeof pending.description === 'string' && pending.description.length > 0 ? pending.description : undefined
    const result = await requestClient('approval', {
      session_id: sessionId,
      request_id: requestId,
      ...(command === undefined ? {} : { command }),
      ...(description === undefined ? {} : { description }),
      ...(command === undefined ? {} : { tool_name: command, pattern_key: command }),
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: true,
      allow_session: true,
      smart_denied: false,
    }, { sessionId, timeoutMs: REQUEST_TTL_MS })
    if (result === null || result === undefined) return
    const choice = String(result.choice ?? 'deny')
    try {
      const answer = await backend.call('POST', '/api/approval/respond', {
        body: { approval_id: requestId, choice, session_id: sessionId },
      })
      if (answer.status !== 200 || answer.json?.ok !== true) {
        logger.warn?.('hermes-gateway: approval answer refused: HTTP ' + answer.status)
      }
    } catch (error) {
      logger.warn?.('hermes-gateway: approval answer failed: ' + String(error?.message ?? error))
    }
  }

  /**
   * Send a clarification as a reverse request and apply the answer.
   * @param {string} sessionId session id.
   * @param {object|undefined|null} pending facade pending payload.
   * @returns {Promise<void>} resolves once answered or withdrawn.
   */
  async function handleClarify(sessionId, pending) {
    if (pending === undefined || pending === null) return
    const requestId = String(pending.clarify_id ?? '')
    if (requestId.length === 0) return
    const question = typeof pending.question === 'string' ? pending.question : ''
    const choices = Array.isArray(pending.choices_offered) ? pending.choices_offered.filter(value => typeof value === 'string') : []
    const result = await requestClient('clarify', {
      session_id: sessionId,
      request_id: requestId,
      question,
      ...(choices.length > 0 ? { choices } : {}),
      ...(pending.multi_select === true ? { multi_select: true } : {}),
    }, { sessionId, timeoutMs: REQUEST_TTL_MS })
    if (result === null || result === undefined) return
    const response = String(result.answer ?? result.value ?? '')
    try {
      await backend.call('POST', '/api/clarify/respond', {
        body: { clarify_id: requestId, response, session_id: sessionId },
      })
    } catch (error) {
      logger.warn?.('hermes-gateway: clar answer failed: ' + String(error?.message ?? error))
    }
  }

  /**
   * Stop the running turn of a session.
   * @param {string} sessionId session id.
   * @returns {Promise<object>} reply.
   */
  async function interrupt(sessionId) {
    // A stop withdraws prompts queued behind the running turn, as the host does.
    queued.delete(sessionId)
    // Withdraw the cards before the abort: the pump may be parked inside an
    // awaited reverse request, so aborting the stream alone would never reach
    // its finally and the card would sit until the request's own TTL.
    requestClient.cancelSession?.(sessionId, 'interrupted')
    const entry = active.get(sessionId)
    if (entry === undefined) return { status: 'not_interrupted', interrupted: false }
    entry.controller.abort()
    try {
      await backend.call('GET', '/api/chat/cancel', { query: { stream_id: entry.streamId } })
    } catch (error) {
      logger.warn?.('hermes-gateway: cancel failed: ' + String(error?.message ?? error))
    }
    return { status: 'interrupted', interrupted: true }
  }

  /**
   * Queue a mid-run message.
   * @param {string} sessionId session id.
   * @param {string} text text.
   * @returns {Promise<object>} reply.
   */
  async function steer(sessionId, text) {
    const reply = await backend.call('POST', '/api/chat/steer', {
      body: { session_id: resolveBackendSession(sessionId), text },
    })
    // The steer branch of the client's outcome map reads "queued" as guidance
    // accepted and "rejected" as a refusal; anything else is an unknown outcome.
    return { status: reply.json?.accepted === true ? 'queued' : 'rejected', text }
  }

  /**
   * Stop every running turn (plugin dispose).
   * @returns {void}
   */
  function dispose() {
    for (const entry of active.values()) {
      try { entry.controller.abort() } catch { /* already closed */ }
    }
    active.clear()
  }

  return { start, interrupt, steer, isRunning, dispose, active }
}
