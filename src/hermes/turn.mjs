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
 * Create the turn runner.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.hub event hub.
 * @param {Function} options.requestClient reverse-request sender.
 * @param {object} [options.logger] logger.
 * @param {() => number} [options.now] epoch seconds.
 * @returns {object} runner.
 */
export function createTurnRunner({ backend, hub, requestClient, logger = console, now = () => Math.floor(Date.now() / 1000) }) {
  /** @type {Map<string, {streamId: string, controller: AbortController, startedAt: number}>} */
  const active = new Map()

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
   * @param {string} input.text prompt.
   * @returns {Promise<object>} prompt.submit reply.
   */
  async function start({ sessionId, text }) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('text required')
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session_id required')
    const started = await backend.call('POST', '/api/chat/start', { body: { session_id: sessionId, message: text } })
    const streamId = started.json?.stream_id
    if (started.status !== 200 || typeof streamId !== 'string' || streamId.length === 0) {
      const detail = started.json?.detail ?? started.json?.error ?? ('HTTP ' + started.status)
      throw new Error(String(detail))
    }
    const controller = new AbortController()
    active.set(sessionId, { streamId, controller, startedAt: now() })
    hub.publish('session.info', { session_id: sessionId, running: true, turn_started_at: now() }, sessionId)
    hub.publish('message.start', { role: 'assistant' }, sessionId)
    void pump(sessionId, streamId, controller)
    return { status: 'accepted', session_id: sessionId, turn_isolation: null }
  }

  /**
   * Follow the facade stream and republish it.
   * @param {string} sessionId session id.
   * @param {string} streamId facade stream id.
   * @param {AbortController} controller abort handle.
   * @returns {Promise<void>} resolves when the turn ends.
   */
  async function pump(sessionId, streamId, controller) {
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
        } else if (frame.event === 'approval') {
          if (data.pending === null || data.pending === undefined) requestClient.cancelSession?.(sessionId, 'resolved')
          else await handleApproval(sessionId, data.pending)
        } else if (frame.event === 'clarify') {
          if (data.pending === null || data.pending === undefined) requestClient.cancelSession?.(sessionId, 'resolved')
          else await handleClarify(sessionId, data.pending)
        } else if (frame.event === 'done') {
          finished = true
          hub.publish('message.complete', { status: 'completed', text }, sessionId)
          hub.publish('session.info', { session_id: sessionId, running: false }, sessionId)
          break
        } else if (frame.event === 'error') {
          finished = true
          const message = typeof data.message === 'string' && data.message.length > 0 ? data.message : 'The turn failed.'
          hub.publish('message.complete', { status: 'error', text: message }, sessionId)
          hub.publish('session.info', { session_id: sessionId, running: false }, sessionId)
          break
        } else if (frame.event === 'cancel') {
          finished = true
          hub.publish('message.complete', { status: 'interrupted', text }, sessionId)
          hub.publish('session.info', { session_id: sessionId, running: false }, sessionId)
          break
        } else if (frame.event === 'stream_end') {
          break
        }
      }
    } catch (error) {
      if (controller.signal.aborted !== true) {
        logger.warn?.('hermes-gateway: turn stream failed: ' + String(error?.message ?? error))
        hub.publish('message.complete', { status: 'error', text: String(error?.message ?? error) }, sessionId)
        hub.publish('session.info', { session_id: sessionId, running: false }, sessionId)
        finished = true
      }
    } finally {
      active.delete(sessionId)
      requestClient.cancelSession?.(sessionId, 'resolved')
      if (!finished) {
        hub.publish('session.info', { session_id: sessionId, running: false }, sessionId)
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
    // Withdraw the cards before the abort: the pump may be parked inside an
    // awaited reverse request, so aborting the stream alone would never reach
    // its finally and the card would sit until the request's own TTL.
    requestClient.cancelSession?.(sessionId, 'interrupted')
    const entry = active.get(sessionId)
    if (entry === undefined) return { status: 'idle', interrupted: false }
    entry.controller.abort()
    try {
      await backend.call('GET', '/api/chat/cancel', { query: { stream_id: entry.streamId } })
    } catch (error) {
      logger.warn?.('hermes-gateway: cancel failed: ' + String(error?.message ?? error))
    }
    return { status: 'ok', interrupted: true }
  }

  /**
   * Queue a mid-run message.
   * @param {string} sessionId session id.
   * @param {string} text text.
   * @returns {Promise<object>} reply.
   */
  async function steer(sessionId, text) {
    const reply = await backend.call('POST', '/api/chat/steer', { body: { session_id: sessionId, text } })
    return { status: reply.json?.accepted === true ? 'accepted' : 'refused', text }
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
