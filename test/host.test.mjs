import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshHost } from '../src/host.mjs'

/**
 * Build a host adapter over a fake gateway.
 * @returns {{host: object, calls: Array<object>}} adapter and recorded calls.
 */
function build() {
  const calls = []
  const gateway = {
    async invoke(request) {
      calls.push(request)
      if (request.method === 'list') return { items: [{ sessionId: 's1', updatedAt: 1700000000000, running: false }] }
      if (request.method === 'create') return { sessionId: 'created-1' }
      if (request.method === 'prompt') return { accepted: true }
      if (request.method === 'cancel') return { accepted: true }
      if (request.method === 'modelCatalog') {
        return { default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] }
      }
      return {}
    },
    // The real gateway resolves to an AsyncIterable: mimic that, including the
    // Promise wrapper that used to break the for-await consumer.
    stream(request) {
      calls.push(request)
      return Promise.resolve((async function* frames() {
        yield { type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1700000000000, data: { content: [{ type: 'text', text: 'hi' }] } } }], hasMore: false, projections: {} }
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text', text: 'ok' } } }
        yield { type: 'event', event: { type: 'turn/end', seq: 1, time: 1700000001000, data: { turn: 1 } } }
      })())
    },
  }
  const ctx = {
    typertGateway: gateway,
    connection: { createPeer: () => ({ principal: 'owner' }) },
    on: () => () => {},
    logger: { info() {}, warn() {} },
  }
  return { host: createDshHost({ ctx, logger: { info() {}, warn() {} } }), calls }
}

test('listSessions uses the literal _request argument', async () => {
  const { host, calls } = build()
  const items = await host.listSessions()
  assert.equal(items.length, 1)
  assert.deepEqual(calls[0].args, { _request: {} })
  assert.equal(calls[0].namespace, 'session')
})

test('ensureSession returns the id the host created', async () => {
  const { host } = build()
  assert.equal(await host.ensureSession(), 'created-1')
})

test('prompt sends an idempotent request envelope', async () => {
  const { host, calls } = build()
  const result = await host.prompt({ sessionId: 's1', text: 'hello' })
  assert.deepEqual(result, { accepted: true })
  const call = calls.find(entry => entry.method === 'prompt')
  assert.equal(call.args.request.sessionId, 's1')
  assert.equal(call.args.request.mode, 'queue')
  assert.deepEqual(call.args.request.content, [{ type: 'text', text: 'hello' }])
  assert.equal(typeof call.args.request.requestId, 'string')
})

test('follow iterates a promise-wrapped stream', async () => {
  const { host } = build()
  const frames = []
  for await (const frame of host.follow('s1', { signal: new AbortController().signal })) frames.push(frame.type)
  assert.deepEqual(frames, ['snapshot', 'assistant-stream', 'event'])
})

test('readSession returns the snapshot events', async () => {
  const { host } = build()
  const snapshot = await host.readSession('s1', { maxMessages: 10 })
  assert.equal(snapshot.events.length, 1)
  assert.equal(snapshot.events[0].type, 'user/message')
})

test('readSession omits assistantStream (const-true field in the host schema)', async () => {
  const { host, calls } = build()
  await host.readSession('s1', { maxMessages: 10 })
  const call = calls.find(entry => entry.method === 'follow')
  assert.equal(call.args.request.address.sessionId, 's1')
  assert.equal(call.args.request.maxMessages, 10)
  assert.ok(!('assistantStream' in call.args.request), 'sending false fails strict boundary validation')
})

test('models returns the raw ModelCatalog', async () => {
  const { host } = build()
  const catalog = await host.models()
  assert.equal(catalog.groups[0].models[0].id, 'm')
  assert.equal(catalog.default.model, 'm')
})
