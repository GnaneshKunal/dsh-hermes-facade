/**
 * First assistant message that carries tool calls.
 * @param {Array<object>} messages mapped messages.
 * @returns {object|undefined} the message.
 */
function assistantWith(messages) {
  return messages.find(message => Array.isArray(message.tool_calls))
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { detailOf, epochSeconds, messagesOf, modelOf, modelProviderOf, normaliseEvent, pageMessages, summaryOf, textOf, timelineOf, turnOutcomeOf } from '../src/map.mjs'

test('epochSeconds converts milliseconds and leaves seconds alone', () => {
  assert.equal(epochSeconds(1700000000000), 1700000000)
  assert.equal(epochSeconds(1700000000), 1700000000)
  assert.equal(epochSeconds(undefined), undefined)
})

test('epochSeconds never returns an ISO string', () => {
  assert.equal(typeof epochSeconds(Date.now()), 'number')
})

test('textOf joins text blocks only', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }, { type: 'text', text: 'c' }]), 'ac')
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf(undefined), '')
})

test('summaryOf emits snake_case fields the client decodes', () => {
  const summary = summaryOf({
    sessionId: 's1',
    updatedAt: 1700000000000,
    running: true,
    cwd: '/tmp/x',
    projections: { values: { title: 'Fix the pool', modelSelection: { model: { id: 'deepseek-v4-pro' } } } },
  })
  assert.equal(summary.session_id, 's1')
  assert.equal(summary.title, 'Fix the pool')
  assert.equal(summary.updated_at, 1700000000)
  assert.equal(typeof summary.updated_at, 'number')
  assert.equal(summary.is_streaming, true)
  assert.equal(summary.model, 'deepseek-v4-pro')
  assert.equal(summary.workspace, '/tmp/x')
  assert.ok(!('sessionId' in summary), 'camelCase must not leak onto the wire')
})

test('summaryOf falls back to a title rather than null', () => {
  assert.equal(summaryOf({ sessionId: 's' }).title, 'Untitled session')
})

test('messagesOf maps user and assistant events', () => {
  const messages = messagesOf([
    { type: 'user/message', seq: 1, time: 1700000000000, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 2, time: 1700000001000, data: { message: { content: [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: 'thinking' }] } } },
  ])
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, 'hi')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content, 'hello')
  assert.equal(messages[1].reasoning, 'thinking')
  assert.equal(typeof messages[1].timestamp, 'number')
})

test('messagesOf carries tool calls as OpenAI-shaped entries', () => {
  const messages = messagesOf([
    { type: 'assistant/message', seq: 1, time: 1700000000000, data: { message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }] } } },
  ])
  assert.equal(messages[0].tool_calls.length, 1)
  assert.equal(messages[0].tool_calls[0].function.name, 'bash')
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"cmd":"ls"}')
})

test('detailOf returns messages and offset', () => {
  const detail = detailOf({ sessionId: 's1', updatedAt: 1700000000000 }, [{ role: 'user', content: 'x' }])
  assert.equal(detail.session_id, 's1')
  assert.equal(detail.messages.length, 1)
  assert.equal(detail.messages_offset, 0)
})

test('modelOf and modelProviderOf read the DSH {lastUsed,next} projection', () => {
  const row = {
    projections: {
      values: {
        modelSelection: {
          lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
          next: null,
        },
      },
    },
  }
  assert.equal(modelOf(row), 'deepseek-v4-pro')
  assert.equal(modelProviderOf(row), 'deepseek-official')
  assert.equal(modelOf({ projections: { values: { modelSelection: { provider: 'p', model: 'm' } } } }), 'm')
  assert.equal(modelOf({ projections: { values: { modelSelection: null } } }), undefined)
})

test('timelineOf carries tool results as persisted tool calls', () => {
  const base = 1_800_000_000_000
  const events = [
    { type: 'user/message', seq: 0, time: base, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'list files' }] } },
    {
      type: 'assistant/message', seq: 1, time: base + 1000,
      data: { message: { content: [{ type: 'text', text: 'Running ls' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }] } },
    },
    { type: 'tool/call', seq: 2, time: base + 1000, data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result', seq: 3, time: base + 2500,
      data: { message: { toolCallId: 'call-1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a.txt' }] }] } },
    },
    { type: 'assistant/message', seq: 4, time: base + 3000, data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
  ]

  const timeline = timelineOf(events)
  assert.deepEqual(timeline.messages.map(message => message.role), ['user', 'assistant', 'assistant'])
  assert.equal(timeline.messages.some(message => message.role === 'tool'), false, 'no hidden tool rows')
  assert.equal(timeline.toolCalls.length, 1, 'assistant content and tool/call are one call')

  const call = timeline.toolCalls[0]
  assert.equal(call.tid, 'call-1')
  assert.equal(call.name, 'bash')
  assert.equal(call.args, undefined, 'args ride on the assistant tool_calls, not the persisted list')
  assert.equal(call.assistant_msg_idx, 1)
  assert.equal(call.snippet, 'a.txt')
  assert.equal(call.is_error, false)
  assert.equal(call.duration, 1.5)
})

test('timelineOf keeps an error verdict on a persisted tool call', () => {
  const base = 1_800_000_000_000
  const timeline = timelineOf([
    { type: 'assistant/message', seq: 0, time: base, data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] } } },
    { type: 'tool/result', seq: 1, time: base + 500, data: { message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] } } },
  ])
  assert.equal(timeline.toolCalls.length, 1)
  assert.equal(timeline.toolCalls[0].is_error, true)
  assert.equal(timeline.toolCalls[0].snippet, 'boom')
  assert.equal(timeline.toolCalls[0].duration, 0.5)
})

test('a long tool result is capped to the preview the client renders', () => {
  const base = 1_800_000_000_000
  const long = 'x'.repeat(2000)
  const timeline = timelineOf([
    { type: 'assistant/message', seq: 0, time: base, data: { message: { content: [{ type: 'tool-call', id: 'c4', name: 'bash', arguments: '{}' }] } } },
    { type: 'tool/result', seq: 1, time: base + 100, data: { message: { toolCallId: 'c4', content: [{ type: 'text', text: long }] } } },
  ])
  assert.equal(timeline.toolCalls[0].snippet.length, 501)
  assert.ok(timeline.toolCalls[0].snippet.endsWith('…'))
})

test('a compaction replacement keeps the original tool duration', () => {
  const base = 1_800_000_000_000
  const timeline = timelineOf([
    { type: 'assistant/message', seq: 0, time: base, data: { message: { content: [{ type: 'tool-call', id: 'c3', name: 'bash', arguments: '{}' }] } } },
    { type: 'tool/result', seq: 1, time: base + 500, data: { message: { toolCallId: 'c3', content: [{ type: 'text', text: 'old' }] } } },
    {
      type: 'tool/result', seq: 9, time: base + 9000, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1],
      data: { message: { toolCallId: 'c3', content: [{ type: 'text', text: 'current' }] } },
    },
  ])
  assert.equal(timeline.toolCalls[0].duration, 0.5)
  assert.equal(timeline.toolCalls[0].snippet, 'current')
})

test('detailOf reports the page cursor, truncation and total', () => {
  const detail = detailOf(
    { sessionId: 's1', updatedAt: 1700000000000 },
    [{ role: 'user', content: 'x' }],
    undefined,
    { offset: 40, truncated: true, total: 41 },
  )
  assert.equal(detail.messages_offset, 40)
  assert.equal(detail.messages_truncated, true)
  assert.equal(detail.message_count, 41)
})

test('pageMessages opens the newest page and reports the older offset', () => {
  const all = Array.from({ length: 260 }, (_, index) => ({ role: 'user', content: 'm' + String(index) }))

  const first = pageMessages(all, { limit: 50, initial: 200 })
  assert.equal(first.messages.length, 200)
  assert.equal(first.messages[0].content, 'm60')
  assert.equal(first.offset, 60)
  assert.equal(first.truncated, true)
  assert.equal(first.total, 260)

  const older = pageMessages(all, { limit: 50, before: first.offset, initial: 200 })
  assert.equal(older.messages.length, 50)
  assert.equal(older.messages[0].content, 'm10')
  assert.equal(older.messages.at(-1).content, 'm59')
  assert.equal(older.offset, 10)
  assert.equal(older.truncated, true)

  const oldest = pageMessages(all, { limit: 50, before: older.offset, initial: 200 })
  assert.equal(oldest.messages.length, 10)
  assert.equal(oldest.messages[0].content, 'm0')
  assert.equal(oldest.offset, 0)
  assert.equal(oldest.truncated, false)
})

test('pageMessages tolerates short, empty and out-of-range windows', () => {
  const short = pageMessages([{ role: 'user', content: 'a' }], { initial: 200 })
  assert.equal(short.messages.length, 1)
  assert.equal(short.offset, 0)
  assert.equal(short.truncated, false)

  assert.deepEqual(pageMessages([], {}).messages, [])

  const clamped = pageMessages(Array.from({ length: 5 }, () => ({ role: 'user' })), { before: 99, limit: 2 })
  assert.equal(clamped.messages.length, 2)
  assert.equal(clamped.offset, 3)
  assert.equal(clamped.truncated, true)
})

test('injected context never renders as a user message', () => {
  const messages = messagesOf([
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real question' }] } },
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context...' }] } },
    { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: '<system-reminder>...' }] } },
    { type: 'user/message', seq: 4, time: 4, data: { source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled...' }] } },
    { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: '<path>/tmp/pic.jpg</path>' }] } },
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, 'real question')
})

test('a user message without a source is still a real message', () => {
  const messages = messagesOf([{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } }])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
})

test('tool calls attach to the assistant row instead of adding empty rows', () => {
  const messages = messagesOf([
    { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [] } } },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'c1', name: 'run_code', arguments: '{"x":1}' } },
    { type: 'tool/call', seq: 3, time: 3, data: { callId: 'c2', name: 'bash', arguments: '{}' } },
  ])
  const withCalls = messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls))
  assert.equal(messages.filter(m => m.role === 'tool').length, 0, 'no synthetic tool rows')
  assert.equal(assistantWith(messages).tool_calls.length, 2)
  assert.equal(assistantWith(messages).tool_calls[0].function.name, 'run_code')
})

test('an agent image becomes markdown on the reply', () => {
  const messages = messagesOf([
    { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'Here it is' }] } } },
    {
      type: 'user/message', seq: 2, time: 2,
      data: {
        source: { kind: 'ptc-mode' },
        content: [
          { type: 'text', text: '<path>/tmp/kimi_lifted.jpg</path>\n<type>image</type>' },
          { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'kimi_lifted.jpg', mediaType: 'image/jpeg' } },
        ],
      },
    },
  ])
  assert.equal(messages.length, 1, 'no phantom user message')
  assert.equal(messages[0].role, 'assistant')
  assert.match(messages[0].content, /Here it is/)
  assert.match(messages[0].content, /!\[kimi_lifted\.jpg\]\(\/tmp\/kimi_lifted\.jpg\)/)
})

test('normaliseEvent extracts assistant text and reasoning', () => {
  const event = normaliseEvent({ type: 'assistant/message', seq: 3, time: 1, data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }] } } })
  assert.equal(event.data.text, 'a')
  assert.equal(event.data.reasoning, 'r')
})

test('normaliseEvent flattens tool result previews', () => {
  const event = normaliseEvent({
    type: 'tool/result', seq: 4, time: 1,
    data: { message: { toolCallId: 'c1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'done!' }] }] } },
  })
  assert.equal(event.data.callId, 'c1')
  assert.equal(event.data.preview, 'done!')
  assert.equal(event.data.isError, false)
})

test('turn/end classifies a completed turn as success', () => {
  const event = normaliseEvent({ type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(event.data.outcome, { status: 'completed' })
})

test('turn/end keeps success when the host records no reason', () => {
  // An older host, or an event synthesized without one, carries no verdict: the
  // phone must not be told the turn failed on a guess.
  assert.deepEqual(turnOutcomeOf(undefined), { status: 'completed' })
  assert.deepEqual(normaliseEvent({ type: 'turn/end', seq: 9, time: 1, data: { turn: 1 } }).data.outcome, { status: 'completed' })
})

test('turn/end aborted for any cause is a cancellation', () => {
  for (const cause of ['user', 'parent', 'disposed', 'legacy']) {
    assert.deepEqual(turnOutcomeOf({ kind: 'aborted', reason: { kind: cause } }), { status: 'cancelled' })
  }
})

test('turn/end error carries the provider detail in the failure', () => {
  const outcome = turnOutcomeOf({ kind: 'error', error: { message: '429 Too Many Requests', code: 'RATE_LIMIT' } })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.message, /429 Too Many Requests/)
  // Logs written by older builds nest the same facts under `failure`.
  assert.match(turnOutcomeOf({ kind: 'error', failure: { message: 'legacy shape' } }).message, /legacy shape/)
  assert.match(turnOutcomeOf({ kind: 'error' }).message, /failed before it finished/)
})

test('turn/end names every other non-success reason', () => {
  for (const kind of ['max-tokens', 'blocked', 'interrupted']) {
    assert.equal(turnOutcomeOf({ kind }).status, 'failed')
  }
  assert.match(turnOutcomeOf({ kind: 'max-tokens' }).message, /output-token limit/)
  // A reason a host plugin adds still fails honestly instead of reporting done.
  const unknown = turnOutcomeOf({ kind: 'quota-exceeded' })
  assert.equal(unknown.status, 'failed')
  assert.match(unknown.message, /quota-exceeded/)
})
