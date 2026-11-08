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

test('a turn in flight pins its first event so a mid-turn cursor has no hole', () => {
  const hub = createEventHub({ retain: 4, turnRetain: 100 })
  // Three quiet events fill the ring before the turn begins.
  for (let seq = 1; seq <= 3; seq += 1) hub.publish('session.info', { running: false }, 'sess')
  hub.beginTurn('sess')
  const turnStart = hub.head('sess') + 1
  for (let seq = 0; seq < 20; seq += 1) hub.publish('tool.start', { name: 'bash', tool_id: String(seq) }, 'sess')

  // A screen that saw the turn begin and dropped keeps its cursor inside the
  // turn; the replay is contiguous even though the ring is four events wide.
  const replay = hub.since('sess', turnStart - 1)
  assert.equal(replay.truncated, false)
  assert.equal(replay.events.length, 20)
  assert.equal(replay.events[0].seq, turnStart)
  assert.equal(replay.events.at(-1).seq, replay.latest_seq)
  assert.deepEqual(replay.events.map(event => event.seq), Array.from({ length: 20 }, (_, index) => turnStart + index))

  // The pre-turn events are still honestly gone: a cursor behind the turn
  // start is a real truncation, not a fabricated answer.
  const behind = hub.since('sess', turnStart - 2)
  assert.equal(behind.truncated, true)
  assert.equal(behind.events[0].seq, turnStart)
})

test('a settled turn releases its pin and the ring returns to its quiet size', () => {
  const hub = createEventHub({ retain: 4, turnRetain: 100 })
  hub.beginTurn('sess')
  const turnStart = 1
  for (let seq = 0; seq < 30; seq += 1) hub.publish('reasoning.delta', { text: 'thinking ' + seq }, 'sess')
  assert.equal(hub.since('sess', turnStart - 1).truncated, false)

  hub.endTurn('sess')
  const quiet = hub.since('sess', turnStart - 1)
  assert.equal(quiet.events.length, 4)
  assert.equal(quiet.truncated, true, 'the post-turn window is the ordinary ring, honestly reported')
  assert.equal(quiet.latest_seq, 30)

  // The next turn pins from its own first event, not the settled one.
  hub.beginTurn('sess')
  hub.publish('tool.start', { name: 'read' }, 'sess')
  const pinStart = hub.head('sess')
  for (let seq = 0; seq < 10; seq += 1) hub.publish('reasoning.delta', { text: 'again ' + seq }, 'sess')
  const next = hub.since('sess', pinStart - 1)
  assert.equal(next.truncated, false)
  assert.equal(next.events[0].seq, pinStart)
  assert.equal(next.events.length, 11)
})

test('one turn is pinned only up to the bounded turn retention', () => {
  const hub = createEventHub({ retain: 2, turnRetain: 5 })
  hub.beginTurn('sess')
  for (let seq = 0; seq < 20; seq += 1) hub.publish('message.delta', { text: 'x' }, 'sess')
  const replay = hub.since('sess', 0)
  assert.equal(replay.events.length, 5, 'the pin is bounded, so a runaway turn cannot grow the ring without limit')
  assert.equal(replay.truncated, true, 'past the bound the replay reports the hole instead of pretending')
  assert.equal(replay.latest_seq, 20)
})

test('forgetting a session drops its turn pin', () => {
  const hub = createEventHub({ retain: 4, turnRetain: 100 })
  hub.beginTurn('sess')
  hub.publish('tool.start', { name: 'bash' }, 'sess')
  hub.forget('sess')
  hub.publish('tool.start', { name: 'read' }, 'sess')
  const replay = hub.since('sess', 0)
  assert.equal(replay.latest_seq, 1)
  assert.equal(replay.truncated, false)
  assert.equal(replay.events[0].seq, 1)
})
