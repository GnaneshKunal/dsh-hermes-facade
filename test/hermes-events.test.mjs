import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventHub } from '../src/hermes/events.mjs'

test('the replay ring keeps more than a thousand events for one long turn', () => {
  const hub = createEventHub()
  for (let seq = 1; seq <= 1501; seq += 1) hub.publish('tool.start', { name: 'x', tool_id: String(seq) }, 'sess')
  const since = hub.since('sess', 0)
  assert.equal(since.truncated, false)
  assert.equal(since.latest_seq, 1501)
  assert.equal(since.events.length, 1501)
  assert.equal(since.events[0].seq, 1)
  assert.equal(since.events.at(-1).seq, 1501)
})

test('the replay ring still reports a real truncation', () => {
  const hub = createEventHub({ retain: 2 })
  for (let seq = 1; seq <= 3; seq += 1) hub.publish('tool.start', { name: 'x' }, 'sess')
  const since = hub.since('sess', 0)
  assert.equal(since.truncated, true)
  assert.deepEqual(since.events.map(event => event.seq), [2, 3])
})
