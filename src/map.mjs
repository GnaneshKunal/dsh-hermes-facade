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
 * Model id from a session's projections.
 * @param {object} item session list item.
 * @returns {string|undefined} model id.
 */
export function modelOf(item) {
  const selection = item?.projections?.values?.modelSelection
  const model = selection?.model ?? selection
  if (typeof model === 'string') return model
  if (model && typeof model.id === 'string') return model.id
  return undefined
}

/**
 * Map one DSH session list row to a Hermex SessionSummary.
 * @param {object} item session/list row.
 * @returns {object} snake_case summary.
 */
export function summaryOf(item, workspace) {
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
    pinned: false,
    archived: false,
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
 * @returns {object} snake_case detail.
 */
export function detailOf(item, messages, workspace, paging = {}) {
  const summary = summaryOf(item, workspace)
  return {
    ...summary,
    message_count: Number.isSafeInteger(paging.total) ? paging.total : messages.length,
    messages,
    messages_offset: Number.isSafeInteger(paging.offset) ? paging.offset : 0,
    messages_truncated: paging.truncated === true,
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

export function messagesOf(events) {
  const messages = []
  /** Last assistant message, so tool calls attach to the row that issued them. */
  let lastAssistant
  for (const event of events) {
    const data = event?.data ?? {}
    const timestamp = epochSeconds(event?.time)
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
      const toolCalls = toolCallsOf(content)
      if (!text && !reasoning && toolCalls.length === 0) continue
      const assistantMessage = {
        role: 'assistant',
        content: text,
        timestamp,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length
          ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) } })) }
          : {}),
      }
      messages.push(assistantMessage)
      lastAssistant = assistantMessage
      continue
    }
    if (event.type === 'tool/call') {
      // Tool calls belong on the assistant message that issued them, not as a
      // separate row: a bare role:"tool" message renders as an empty bubble.
      const call = {
        id: String(data.callId ?? ''),
        type: 'function',
        function: {
          name: String(data.name ?? ''),
          arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
        },
      }
      if (lastAssistant !== undefined) {
        lastAssistant.tool_calls = Array.isArray(lastAssistant.tool_calls) ? [...lastAssistant.tool_calls, call] : [call]
      } else {
        const message = { role: 'assistant', content: '', timestamp, tool_calls: [call] }
        messages.push(message)
        lastAssistant = message
      }
      continue
    }
  }
  return messages
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
    let preview = ''
    for (const block of data.message?.content ?? []) {
      const inner = block?.type === 'tool-result' ? block.content ?? [] : [block]
      for (const part of inner) if (part?.type === 'text' && typeof part.text === 'string') preview += part.text
    }
    return {
      type: 'tool/result',
      seq: event.seq,
      time: event.time,
      data: {
        turn: data.turn,
        step: data.step,
        callId: data.message?.toolCallId ?? data.message?.source?.callId,
        isError: data.message?.isError === true || Boolean(data.error),
        preview: preview.length > 4000 ? preview.slice(0, 4000) + '…' : preview,
      },
    }
  }
  if (event?.type === 'session/title') {
    return { type: 'session/title', seq: event.seq, time: event.time, data: { title: data.title } }
  }
  if (event?.type === 'turn/end') {
    return { type: 'turn/end', seq: event.seq, time: event.time, data: { turn: data.turn, reason: data.reason } }
  }
  return { type: String(event?.type ?? 'unknown'), seq: event?.seq, time: event?.time, data }
}
