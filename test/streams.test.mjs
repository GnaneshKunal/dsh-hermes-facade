import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamRegistry, newStreamId } from '../src/streams.mjs';

test('newStreamId is opaque and unique enough for a journal key', () => {
  const first = newStreamId();
  const second = newStreamId();
  assert.equal(typeof first, 'string');
  assert.notEqual(first, second);
});

test('finish marks the stream terminal, records its time and is idempotent', () => {
  const registry = createStreamRegistry();
  const stream = registry.create({ sessionId: 's1' });
  registry.finish(stream, 'completed');
  assert.equal(stream.terminal, 'completed');
  assert.equal(typeof stream.finishedAt, 'number');
  const finishedAt = stream.finishedAt;
  registry.finish(stream, 'failed');
  assert.equal(stream.terminal, 'completed', 'a second finish cannot rewrite the outcome');
  assert.equal(stream.finishedAt, finishedAt);
  assert.equal(registry.activeCount(), 0);
});

test('finishing a stream prunes finished journals past the replay window', () => {
  const registry = createStreamRegistry({ retainMs: 60_000 });
  const old = registry.create({ sessionId: 's1' });
  registry.finish(old, 'complete');
  // Pretend the turn finished well before this lifecycle call.
  old.finishedAt = Date.now() - 120_000;

  const current = registry.create({ sessionId: 's2' });
  registry.finish(current, 'completed');

  assert.equal(registry.get(old.streamId), undefined, 'the stale journal is gone');
  assert.ok(registry.get(current.streamId), 'the just-finished stream is still replayable');
});

test('live streams are never pruned', () => {
  const registry = createStreamRegistry({ retainMs: 0, maxFinished: 0 });
  const live = registry.create({ sessionId: 's1' });
  live.createdAt = Date.now() - 60_000;
  const other = registry.create({ sessionId: 's2' });
  registry.finish(other, 'completed');
  assert.ok(registry.get(live.streamId), 'a running turn keeps its replay journal');
  assert.equal(registry.get(other.streamId), undefined, 'the finished stream is over the cap');
});

test('the finished-stream cap drops the oldest journals, not the newest', () => {
  const registry = createStreamRegistry({ retainMs: 60_000, maxFinished: 2 });
  const first = registry.create({ sessionId: 's1' });
  registry.finish(first, 'completed');
  first.finishedAt = Date.now() - 3_000;
  const second = registry.create({ sessionId: 's2' });
  registry.finish(second, 'completed');
  second.finishedAt = Date.now() - 2_000;
  const third = registry.create({ sessionId: 's3' });
  registry.finish(third, 'completed');

  const kept = [...[first, second, third]].filter(record => registry.get(record.streamId) !== undefined);
  assert.equal(kept.length, 2);
  assert.equal(registry.get(third.streamId)?.streamId, third.streamId, 'the newest stays');
  assert.equal(registry.get(first.streamId), undefined, 'the oldest goes first');
});

test('prune can be called explicitly with its own window', () => {
  const registry = createStreamRegistry();
  const stream = registry.create({ sessionId: 's1' });
  registry.finish(stream, 'cancelled');
  stream.finishedAt = Date.now() - 10_000;
  assert.equal(registry.prune(5_000), 1);
  assert.equal(registry.get(stream.streamId), undefined);
  assert.equal(registry.prune(5_000), 0);
});

test('publish fans out to attached channels and deletes closed ones', () => {
  const registry = createStreamRegistry();
  const stream = registry.create({ sessionId: 's1' });
  const seen = [];
  const open = { closed: false, send(event, data, seq) { seen.push({ event, data, seq }); } };
  const closed = { closed: true, send() { throw new Error('must not send to a closed channel'); } };
  stream.channels.add(open);
  stream.channels.add(closed);
  const seq = registry.publish(stream, 'token', { text: 'hi' });
  assert.equal(seq, 1);
  assert.deepEqual(seen, [{ event: 'token', data: { text: 'hi' }, seq: 1 }]);
  assert.equal(stream.channels.has(closed), false);
});
