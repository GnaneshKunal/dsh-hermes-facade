import assert from 'node:assert/strict'
import test from 'node:test'
import { detailOf, epochSeconds, messagesOf, normaliseEvent, summaryOf, textOf } from '../src/map.mjs'

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
