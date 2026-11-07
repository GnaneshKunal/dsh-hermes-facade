/**
 * Translation between DSH session shapes and the hermes-webui shapes the
 * Hermex client decodes.
 *
 * Every field name here is snake_case because Hermex sets
 * keyDecodingStrategy = .convertFromSnakeCase on its REST decoder. SSE
 * payloads are decoded with a plain JSONDecoder, so those keys are snake_case
 * too, written literally.
 *
 * @module dsh-hermes-facade/src/map
 */

/**
 * Convert DSH milliseconds to the epoch SECONDS number Hermex expects.
 * @param {unknown} value epoch ms (or already seconds).
 * @returns {number|undefined} epoch seconds.
 */
export function epochSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value > 1e12 ? Math.round(value) / 1000 : value
}

/**
 * Join the text blocks of a DSH content array.
 * @param {unknown} content content blocks.
 * @returns {string} concatenated text.
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Pull reasoning text out of DSH content blocks.
 * @param {unknown} content content blocks.
 * @returns {string} concatenated reasoning.
 */
export function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'reasoning' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Extract tool calls declared inside an assistant message.
 * @param {unknown} content content blocks.
 * @returns {Array<{id: string, name: string, arguments: unknown}>} tool calls.
 */
export function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const calls = []
  for (const block of content) {
    if (block && block.type === 'tool-call') {
      calls.push({ id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: block.arguments })
    }
  }
  return calls
}

/**
 * Read the title out of a session's projections.
 * @param {object} item session list item.
 * @returns {string} title.
 */
export function titleOf(item) {
  const values = item?.projections?.values ?? {}
  if (typeof values.title === 'string' && values.title.trim()) return values.title
  return 'Untitled session'
}

/**
 * Unwrap the recorded model-selection projection.
 *
 * DSH projects `values.modelSelection = {lastUsed, next|pending}`; older drafts
 * used a flat `{provider, model, reasoningEffort}`. Reading only the flat shape
 * loses both the model and its provider on current deployments.
 * @param {object} item session list item.
 * @returns {object|undefined} chosen selection.
 */
function selectionOf(item) {
  const projection = item?.projections?.values?.modelSelection
  if (projection === null || typeof projection !== 'object') return undefined
  const chosen = projection.next ?? projection.pending ?? projection.lastUsed ?? projection
  return chosen !== null && typeof chosen === 'object' ? chosen : undefined
}

/**
 * Model id from a session's projections.
 * @param {object} item session list item.
 * @returns {string|undefined} model id.
 */
export function modelOf(item) {
  const chosen = selectionOf(item)
  const model = chosen?.model ?? chosen
  if (typeof model === 'string') return model
  if (model && typeof model.id === 'string') return model.id
  return undefined
}

/**
 * Provider route id from a session's projections.
 * @param {object} item session list item.
 * @returns {string|undefined} provider id.
 */
export function modelProviderOf(item) {
  const chosen = selectionOf(item)
  return typeof chosen?.provider === 'string' && chosen.provider.length > 0 ? chosen.provider : undefined
}

/**
 * Map one DSH session list row to a Hermex SessionSummary.
 * @param {object} item session/list row.
 * @param {{id: string, name: string}} [workspace] workspace row for project grouping.
 * @param {{pinned?: boolean, archived?: boolean}} [state] registry-global visibility flags.
 * @returns {object} snake_case summary.
 */
export function summaryOf(item, workspace, state = {}) {
  const updated = epochSeconds(item?.updatedAt)
  return {
    session_id: String(item?.sessionId ?? ''),
    ...(workspace === undefined ? {} : { project_id: String(workspace.id), project: String(workspace.name) }),
    title: titleOf(item),
    workspace: typeof item?.cwd === 'string' ? item.cwd : '',
    message_count: Number.isSafeInteger(item?.projections?.values?.sessionListMetadata?.messageCount)
      ? item.projections.values.sessionListMetadata.messageCount
      : undefined,
    created_at: epochSeconds(item?.createdAt) ?? updated,
    updated_at: updated,
    last_message_at: updated,
    // DSH keeps both sets registry-global in the workspace baseline; a row that
    // is absent from a set is simply not pinned/archived.
    pinned: state.pinned === true,
    archived: state.archived === true,
    input_tokens: Number.isSafeInteger(item?.projections?.values?.contextUsage?.inputTokens)
      ? item.projections.values.contextUsage.inputTokens
      : undefined,
    output_tokens: Number.isSafeInteger(item?.projections?.values?.contextUsage?.outputTokens)
      ? item.projections.values.contextUsage.outputTokens
      : undefined,
    is_streaming: item?.running === true,
    is_cli_session: false,
    read_only: false,
    model: modelOf(item),
    ...(modelProviderOf(item) === undefined ? {} : { model_provider: modelProviderOf(item) }),
    ...(typeof item?.parentSessionId === 'string' ? { parent_session_id: item.parentSessionId } : {}),
  }
}

/**
 * Select one backwards page of display messages for GET /api/session.
 *
 * Hermex opens a chat with msg_limit=50 and asks for older pages with
 * msg_before=<messages_offset> until the offset reaches 0. DSH hands us a
 * bounded recent window; this slices it the same way a hermes-webui host does:
 * the initial page is the newest chunk (larger than the client asked for, so
 * most chats open complete), every older page is the chunk immediately before
 * the requested offset, and the offset is the index of the first returned
 * message in that window.
 *
 * @param {Array<object>} messages every display message in the host window.
 * @param {object} [options] paging options.
 * @param {number} [options.limit] client page size for older pages.
 * @param {number} [options.before] msg_before cursor (index of the current first message).
 * @param {number} [options.initial] size of the first page when no cursor is sent.
 * @returns {{messages: Array<object>, offset: number, truncated: boolean, total: number}} page.
 */
export function pageMessages(messages, { limit = 50, before, initial = 200 } = {}) {
  const windowMessages = Array.isArray(messages) ? messages : []
  const total = windowMessages.length
  const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50

  if (Number.isSafeInteger(before) && before > 0) {
    const end = Math.min(before, total)
    const start = Math.max(0, end - pageSize)
    return {
      messages: windowMessages.slice(start, end),
      offset: start,
      truncated: start > 0,
      total,
    }
  }

  const initialSize = Math.max(
    1,
    Number.isSafeInteger(initial) && initial > 0 ? initial : 200,
    pageSize,
  )
  const start = Math.max(0, total - initialSize)
  return {
    messages: windowMessages.slice(start),
    offset: start,
    truncated: start > 0,
    total,
  }
}

/**
 * Map one DSH session row plus messages to a Hermex session detail.
 * @param {object} item session/list row.
 * @param {Array<object>} messages ChatMessage array (one page).
 * @param {object} [workspace] workspace row for project grouping.
 * @param {object} [paging] page cursor: {offset, truncated, total}.
 * @param {Array<object>} [toolCalls] persisted tool calls for the loaded window.
 * @param {{pinned?: boolean, archived?: boolean}} [state] registry-global visibility flags.
 * @returns {object} snake_case detail.
 */
export function detailOf(item, messages, workspace, paging = {}, toolCalls = [], state = {}) {
  const summary = summaryOf(item, workspace, state)
  return {
    ...summary,
    message_count: Number.isSafeInteger(paging.total) ? paging.total : messages.length,
    messages,
    messages_offset: Number.isSafeInteger(paging.offset) ? paging.offset : 0,
    messages_truncated: paging.truncated === true,
    ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Turn durable DSH session events into Hermex ChatMessage objects.
 * @param {Array<object>} events normalised events ({type, seq, time, data}).
 * @returns {Array<object>} ChatMessage array.
 */
/**
 * Pull image references out of a DSH content array.
 *
 * DSH surfaces an agent-generated image as a ptc-mode user message whose text
 * block names the file and whose image blocks carry a content-addressed
 * attachment. Hermex renders images from markdown, so the reference has to
 * become ![name](path).
 *
 * @param {unknown} content content blocks.
 * @returns {Array<{path?: string, name?: string, attachmentId?: string}>} image refs.
 */
export function imageRefsOf(content) {
  if (!Array.isArray(content)) return []
  const refs = []
  let namedPath
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const match = /<path>([\s\S]*?)<\/path>/.exec(block.text)
      if (match) namedPath = match[1].trim()
    }
  }
  for (const block of content) {
    if (!block || block.type !== 'image') continue
    const attachment = block.attachment ?? {}
    refs.push({
      ...(namedPath === undefined ? {} : { path: namedPath }),
      ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
      ...(typeof attachment.attachmentId === 'string' ? { attachmentId: attachment.attachmentId } : {}),
    })
  }
  return refs
}

/**
 * Longest tool-result preview sent in a session detail.
 *
 * The client draws a tool row's snippet, not a full log dump; a compact preview
 * keeps a tool-heavy transcript's page small enough for a mobile link while the
 * arguments still travel on each assistant message's tool_calls.
 */
const TOOL_SNIPPET_LIMIT = 500

/**
 * Text and verdict of one tool/result event.
 * @param {object|undefined} data event data.
 * @returns {{callId?: string, isError: boolean, preview: string}} result.
 */
export function toolResultOf(data) {
  let preview = ''
  for (const block of data?.message?.content ?? []) {
    const inner = block?.type === 'tool-result' ? block.content ?? [] : [block]
    for (const part of inner) if (part?.type === 'text' && typeof part.text === 'string') preview += part.text
  }
  return {
    callId: data?.message?.toolCallId ?? data?.message?.source?.callId,
    isError: data?.message?.isError === true || Boolean(data?.error),
    preview: preview.length > 4000 ? preview.slice(0, 4000) + '…' : preview,
  }
}

/**
 * Turn durable DSH session events into the transcript Hermex renders.
 *
 * Messages are user/assistant rows only: a bare role:"tool" row would render as
 * an empty bubble. Tool output is carried separately as `tool_calls` entries
 * (the client's PersistedToolCall), which the app draws as completed tool cards
 * anchored to the assistant message that issued each call.
 *
 * @param {Array<object>} events normalised events ({type, seq, time, data}).
 * @returns {{messages: Array<object>, toolCalls: Array<object>}} transcript.
 */
export function timelineOf(events) {
  const messages = []
  /** Persisted tool calls, snake_case, anchored by assistant message index. */
  const toolCalls = []
  /** callId -> persisted entry (one entry per call, first appearance wins). */
  const callEntries = new Map()
  /** persisted entry -> call time in ms, for duration. */
  const callTimes = new Map()
  /** event seq -> its time in ms, so a compaction replacement can price its result. */
  const eventTimes = new Map()
  /** Last assistant message, so tool calls attach to the row that issued them. */
  let lastAssistant
  let lastAssistantIndex = -1

  /**
   * Record one tool call against the assistant message that issued it.
   * @param {object} call call shape ({id, name, arguments}).
   * @param {number} messageIndex assistant message index.
   * @param {number|undefined} time call time (epoch ms).
   * @returns {void}
   */
  function recordCall(call, messageIndex, time) {
    if (messageIndex < 0) return
    const callId = String(call?.id ?? '')
    if (callId.length > 0 && callEntries.has(callId)) return
    const entry = {
      ...(typeof call?.name === 'string' && call.name.length > 0 ? { name: call.name } : {}),
      ...(callId.length > 0 ? { tid: callId } : {}),
      assistant_msg_idx: messageIndex,
    }
    toolCalls.push(entry)
    if (callId.length > 0) callEntries.set(callId, entry)
    if (typeof time === 'number' && Number.isFinite(time)) callTimes.set(entry, time > 1e12 ? time : time * 1000)
  }

  for (const event of events) {
    const data = event?.data ?? {}
    const timestamp = epochSeconds(event?.time)
    if (Number.isSafeInteger(event?.seq) && typeof event.time === 'number' && Number.isFinite(event.time)) {
      eventTimes.set(event.seq, event.time > 1e12 ? event.time : event.time * 1000)
    }
    if (event.type === 'user/message') {
      // DSH stores injected context as user/message with a source.kind. Only
      // kind "user" (or an unlabelled message) is a real message from the
      // human; runtime-context, skill-catalog, time-context and ptc-mode are
      // harness plumbing and must never render as "Me:".
      const kind = data.source && typeof data.source.kind === 'string' ? data.source.kind : undefined
      if (kind === 'ptc-mode') {
        // The agent's own image: fold it into the reply as markdown so the app
        // renders it, instead of dropping it or showing it as a user message.
        const refs = imageRefsOf(data.content)
        if (refs.length > 0) {
          const markdown = refs
            .map(ref => '![' + (ref.name ?? 'image') + '](' + (ref.path ?? ('attachment:' + ref.attachmentId)) + ')')
            .join('\n')
          if (lastAssistant !== undefined) {
            const content = typeof lastAssistant.content === 'string' ? lastAssistant.content : ''
            lastAssistant.content = content.length > 0 ? content + '\n\n' + markdown : markdown
          } else {
            const message = { role: 'assistant', content: markdown, timestamp }
            messages.push(message)
            lastAssistant = message
            lastAssistantIndex = messages.length - 1
          }
        }
        continue
      }
      if (kind !== undefined && kind !== 'user') continue
      const text = textOf(data.content)
      if (!text) continue
      messages.push({ role: 'user', content: text, timestamp })
      continue
    }
    if (event.type === 'assistant/message') {
      const content = data.message?.content ?? []
      const text = textOf(content)
      const reasoning = reasoningOf(content)
      const messageToolCalls = toolCallsOf(content)
      if (!text && !reasoning && messageToolCalls.length === 0) continue
      const assistantMessage = {
        role: 'assistant',
        content: text,
        timestamp,
        ...(reasoning ? { reasoning } : {}),
        ...(messageToolCalls.length
          ? { tool_calls: messageToolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) } })) }
          : {}),
      }
      messages.push(assistantMessage)
      lastAssistant = assistantMessage
      lastAssistantIndex = messages.length - 1
      for (const call of messageToolCalls) recordCall(call, lastAssistantIndex, event?.time)
      continue
    }
    if (event.type === 'tool/call') {
      // Tool calls belong on the assistant message that issued them, not as a
      // separate row: a bare role:"tool" message renders as an empty bubble.
      const callId = String(data.callId ?? '')
      const callName = String(data.name ?? '')
      const callArguments = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
      const openAICall = {
        id: callId,
        type: 'function',
        function: { name: callName, arguments: callArguments },
      }
      if (lastAssistant !== undefined) {
        const already = Array.isArray(lastAssistant.tool_calls)
          && lastAssistant.tool_calls.some(entry => entry?.id !== undefined && String(entry.id) === callId)
        if (!already) {
          lastAssistant.tool_calls = Array.isArray(lastAssistant.tool_calls) ? [...lastAssistant.tool_calls, openAICall] : [openAICall]
        }
        recordCall({ id: callId, name: callName, arguments: callArguments }, lastAssistantIndex, event?.time)
      } else {
        const message = { role: 'assistant', content: '', timestamp, tool_calls: [openAICall] }
        messages.push(message)
        lastAssistant = message
        lastAssistantIndex = messages.length - 1
        recordCall({ id: callId, name: callName, arguments: callArguments }, lastAssistantIndex, event?.time)
      }
      continue
    }
    if (event.type === 'tool/result') {
      const result = toolResultOf(data)
      const callId = String(result.callId ?? '')
      const entry = callId.length > 0 ? callEntries.get(callId) : undefined
      if (entry === undefined) continue
      if (result.preview.length > 0) {
        entry.snippet = result.preview.length > TOOL_SNIPPET_LIMIT
          ? result.preview.slice(0, TOOL_SNIPPET_LIMIT) + '…'
          : result.preview
      }
      entry.is_error = result.isError
      const callTime = callTimes.get(entry)
      const resultTime = event?.time > 1e12 ? event.time : (typeof event?.time === 'number' ? event.time * 1000 : undefined)
      // Compaction re-surfaces a pruned result as a replacement node whose own
      // time is "now"; price the call against the result it replaced instead.
      const sources = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs : []
      const replacedTime = sources
        .map(seq => eventTimes.get(seq))
        .filter(time => typeof time === 'number')
        .sort((left, right) => left - right)[0]
      const pricedTime = (event?.surfaceOp !== undefined && event.surfaceOp !== 'append' && replacedTime !== undefined)
        ? replacedTime
        : resultTime
      if (typeof callTime === 'number' && typeof pricedTime === 'number' && pricedTime >= callTime) {
        entry.duration = Math.round(((pricedTime - callTime) / 1000) * 100) / 100
      }
      continue
    }
  }
  return { messages, toolCalls }
}

/**
 * Backwards-compatible message-only view of {@link timelineOf}.
 * @param {Array<object>} events normalised events.
 * @returns {Array<object>} ChatMessage array.
 */
export function messagesOf(events) {
  return timelineOf(events).messages
}

/** Longest provider error detail carried into the phone failure banner. */
const TURN_ERROR_DETAIL_LIMIT = 400

/**
 * Plain phrases for turn-ending reasons that are not a provider error.
 * @type {Record<string, string>}
 */
const TURN_REASON_NOTES = {
  'max-tokens': 'The turn stopped at the model output-token limit.',
  blocked: 'The turn was blocked before it ran.',
  interrupted: 'The turn was interrupted before it finished.',
  forked: 'The turn was closed at a fork boundary.',
}

/**
 * Human-readable detail out of a failed turn/end reason.
 *
 * DSH records {kind:"error", error: LlmFailure}; logs written by older builds
 * carry the same facts under "failure", so both spellings are read.
 * @param {object|undefined} reason raw reason.
 * @returns {string} detail, possibly empty.
 */
function failureDetailOf(reason) {
  const candidates = [
    reason?.error?.message,
    reason?.failure?.message,
    typeof reason?.error === 'string' ? reason.error : undefined,
    reason?.message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const detail = candidate.trim()
    if (detail.length === 0) continue
    return detail.length > TURN_ERROR_DETAIL_LIMIT ? detail.slice(0, TURN_ERROR_DETAIL_LIMIT) + '…' : detail
  }
  return ''
}

/**
 * Classify a turn/end reason as one of the three outcomes the phone knows.
 *
 * A webui stream ends in exactly one way: "done" (the run completed), "error"
 * (it failed) or "cancel" (it was stopped). DSH records why the turn ended in
 * turn/end.reason; only kind:"completed" is a success. A missing reason (an
 * older host, or an event synthesized without one) carries no verdict, so it
 * keeps the completed path. Every other kind is a non-completion: "aborted" is
 * the cancellation family, everything else is a failure ("error", "blocked",
 * "max-tokens", and any reason a host plugin adds).
 *
 * @param {object|undefined} reason turn/end reason.
 * @returns {{status: 'completed'|'cancelled'|'failed', message?: string}} outcome.
 */
export function turnOutcomeOf(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : ''
  if (kind.length === 0 || kind === 'completed') return { status: 'completed' }
  // aborted: user / parent / hook / disposed, or a legacy record without a cause.
  if (kind === 'aborted') return { status: 'cancelled' }
  if (kind === 'error') {
    const detail = failureDetailOf(reason)
    return {
      status: 'failed',
      message: detail.length > 0 ? 'The turn failed: ' + detail : 'The turn failed before it finished.',
    }
  }
  return { status: 'failed', message: TURN_REASON_NOTES[kind] ?? 'The turn ended with reason "' + kind + '".' }
}

/**
 * Normalise one raw DSH session event into the subset the facade needs.
 * @param {object} event raw event ({type, seq, time, data}).
 * @returns {object} normalised event.
 */
export function normaliseEvent(event) {
  const data = event?.data ?? {}
  if (event?.type === 'assistant/message') {
    const content = data.message?.content ?? []
    return {
      type: 'assistant/message',
      seq: event.seq,
      time: event.time,
      data: { turn: data.turn, step: data.step, text: textOf(content), reasoning: reasoningOf(content), usage: data.usage, interrupted: data.interrupted === true },
    }
  }
  if (event?.type === 'user/message') {
    return { type: 'user/message', seq: event.seq, time: event.time, data: { text: textOf(data.content) } }
  }
  if (event?.type === 'tool/call') {
    return { type: 'tool/call', seq: event.seq, time: event.time, data: { turn: data.turn, step: data.step, callId: data.callId, name: data.name, arguments: data.arguments } }
  }
  if (event?.type === 'tool/result') {
    const result = toolResultOf(data)
    return {
      type: 'tool/result',
      seq: event.seq,
      time: event.time,
      data: {
        turn: data.turn,
        step: data.step,
        callId: result.callId,
        isError: result.isError,
        preview: result.preview,
      },
    }
  }
  if (event?.type === 'session/title') {
    return { type: 'session/title', seq: event.seq, time: event.time, data: { title: data.title } }
  }
  if (event?.type === 'turn/end') {
    return {
      type: 'turn/end',
      seq: event.seq,
      time: event.time,
      data: { turn: data.turn, reason: data.reason, outcome: turnOutcomeOf(data.reason) },
    }
  }
  return { type: String(event?.type ?? 'unknown'), seq: event?.seq, time: event?.time, data }
}
