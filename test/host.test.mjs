import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshHost } from '../src/host.mjs'

/**
 * Build a host adapter over a fake gateway.
 * @returns {{host: object, calls: Array<object>}} adapter and recorded calls.
 */
function build(existingWorkspaces = {}) {
  const calls = []
  const gateway = {
    async invoke(request) {
      calls.push(request)
      if (request.method === 'list') {
        return {
          items: [{
            sessionId: 's1',
            updatedAt: 1700000000000,
            running: false,
            projections: { values: { modelSelection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'medium' } } },
          }],
        }
      }
      if (request.method === 'create' && request.namespace === 'workspace') {
        return { workspace: { workspaceId: 'ws-1', path: '/tmp', title: 'tmp', sessionIds: [] }, created: true }
      }
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
      if (request.namespace === 'workspace' && request.method === 'follow') {
        const items = Object.entries(existingWorkspaces).map(([path, workspaceId]) => ({
          workspaceId,
          path,
          title: path,
          sessionIds: [],
        }))
        return Promise.resolve((async function* frames() {
          yield { type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } }
        })())
      }
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

test('ensureSession joins a workspace so the GUI groups the session', async () => {
  const { host, calls } = build()
  await host.ensureSession(undefined, '/tmp')
  const { realpathSync } = await import('node:fs')
  const workspace = calls.find(entry => entry.namespace === 'workspace' && entry.method === 'create')
  assert.equal(workspace.args.request.path, realpathSync('/tmp'), 'the path is canonicalised before create')
  const session = calls.find(entry => entry.namespace === 'session' && entry.method === 'create')
  assert.equal(session.args.request.workspaceId, 'ws-1')
  assert.ok(!('cwd' in session.args.request), 'cwd and workspaceId are exclusive')
})

test('ensureSession reuses an existing workspace for the same path', async () => {
  const { host, calls } = build({'/tmp/': 'ws-existing'})
  await host.ensureSession(undefined, '/tmp')
  assert.ok(!calls.some(entry => entry.namespace === 'workspace' && entry.method === 'create'), 'no duplicate workspace')
  const session = calls.find(entry => entry.namespace === 'session' && entry.method === 'create')
  assert.equal(session.args.request.workspaceId, 'ws-existing')
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

test('ensureSession accepts a project id as the workspace id', async () => {
  const { host, calls } = build({ '/private/tmp': 'ws-existing' })
  await host.ensureSession(undefined, undefined, 'ws-existing')
  const session = calls.find(entry => entry.namespace === 'session' && entry.method === 'create')
  assert.equal(session.args.request.workspaceId, 'ws-existing', 'the project lane names the workspace by id')
  assert.ok(!calls.some(entry => entry.namespace === 'workspace' && entry.method === 'create'), 'no workspace is created')
})

test('an unknown project id falls back to the workspace path', async () => {
  const { host, calls } = build({ '/private/tmp': 'ws-existing' })
  await host.ensureSession(undefined, '/private/tmp', 'not-a-workspace')
  const session = calls.find(entry => entry.namespace === 'session' && entry.method === 'create')
  assert.equal(session.args.request.workspaceId, 'ws-existing')
})

test('adoptSession files an existing session under the workspace', async () => {
  const { host, calls } = build()
  const result = await host.adoptSession({ sessionId: 's1', workspacePath: '/tmp' })
  assert.equal(result.ok, true)
  const adopt = calls.find(entry => entry.namespace === 'workspace' && entry.method === 'insertSessionBefore')
  assert.deepEqual(adopt.args.request, { workspaceId: 'ws-1', sessionId: 's1' })
})

test('setReasoningEffort replays the provider and model with the new effort', async () => {
  const { host, calls } = build()
  await host.setReasoningEffort({ sessionId: 's1', effort: 'high' })
  const call = calls.find(entry => entry.method === 'selectModel')
  assert.deepEqual(call.args.request, {
    sessionId: 's1',
    reasoningEffort: 'high',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
})

test('creating a session drops the cached workspace baseline', async () => {
  const { host, calls } = build()
  const baselineReads = () => calls.filter(entry => entry.namespace === 'workspace' && entry.method === 'follow').length

  await host.workspaces()
  const before = baselineReads()
  await host.workspaces()
  assert.equal(baselineReads(), before, 'the second read is served from cache')

  await host.ensureSession(undefined, '/tmp')
  await host.workspaces()
  assert.equal(baselineReads(), before + 1, 'the baseline is refetched after a create')
})

test('models returns the raw ModelCatalog', async () => {
  const { host } = build()
  const catalog = await host.models()
  assert.equal(catalog.groups[0].models[0].id, 'm')
  assert.equal(catalog.default.model, 'm')
})
