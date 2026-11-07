import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshHost } from '../src/host.mjs'

/**
 * The catalog shape the real host returns, with per-model effort levels.
 * @returns {object} ModelCatalog.
 */
function defaultCatalog() {
  return {
    default: { provider: 'p', model: 'm', reasoningEffort: 'medium' },
    groups: [{
      id: 'p',
      name: 'P',
      models: [{
        id: 'm',
        name: 'M',
        reasoning: {
          efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }],
          defaultEffort: 'medium',
        },
      }],
    }],
    failures: [],
  }
}

/**
 * Two providers, so @provider: parsing and provider resets are exercised.
 * @returns {object} ModelCatalog.
 */
function twoProviderCatalog() {
  return {
    default: { provider: 'p', model: 'm', reasoningEffort: 'medium' },
    groups: [
      {
        id: 'p',
        name: 'P',
        models: [
          { id: 'm', name: 'M', reasoning: { efforts: ['off', 'low', 'medium', 'high', 'max'], defaultEffort: 'medium' } },
          { id: 'm-nodefault', name: 'M2', reasoning: { efforts: ['off', 'low'], defaultEffort: 'max' } },
        ],
      },
      {
        id: 'q',
        name: 'Q',
        models: [{ id: 'm', name: 'M Q', reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } }],
      },
    ],
    failures: [],
  }
}

/**
 * Build a host adapter over a fake gateway.
 * @returns {{host: object, calls: Array<object>}} adapter and recorded calls.
 */
function build(existingWorkspaces = {}, options = {}) {
  const calls = []
  const selection = options.selection ?? {
    lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'medium' },
    pending: null,
  }
  const gateway = {
    async invoke(request) {
      calls.push(request)
      if (request.method === 'list') {
        return {
          items: [{
            sessionId: 's1',
            updatedAt: 1700000000000,
            running: false,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            projections: { values: { modelSelection: selection } },
          }],
        }
      }
      if (request.method === 'create' && request.namespace === 'workspace') {
        return { workspace: { workspaceId: 'ws-1', path: '/tmp', title: 'tmp', sessionIds: [] }, created: true }
      }
      if (request.method === 'create') return { sessionId: 'created-1' }
      if (request.method === 'prompt') return { accepted: true }
      if (request.method === 'cancel') return { accepted: true }
      if (request.method === 'modelCatalog') return options.catalog ?? defaultCatalog()
      if (request.namespace === 'session' && request.method === 'selectModel') {
        return { selected: request.args?.request ?? {} }
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
  const result = await host.setReasoningEffort({ sessionId: 's1', effort: 'high' })
  const call = calls.find(entry => entry.method === 'selectModel')
  assert.deepEqual(call.args.request, {
    sessionId: 's1',
    reasoningEffort: 'high',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  })
  assert.equal(result.effort, 'high')
  assert.deepEqual(result.supportedEfforts, ['off', 'low', 'medium', 'high', 'max'])
})

test('modelSelection reads the recorded projection, not an empty top level', async () => {
  const { host } = build()
  const selection = await host.modelSelection('s1')
  assert.deepEqual(selection, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium',
  })
})

test('modelSelection accepts next and the legacy flat projection', async () => {
  const next = build({}, {
    selection: { lastUsed: null, next: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
  })
  assert.equal((await next.host.modelSelection('s1')).reasoningEffort, 'low')
  const legacy = build({}, {
    selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  })
  assert.equal((await legacy.host.modelSelection('s1')).reasoningEffort, 'high')
})

test('reasoning reports the effort in force and the levels the model offers', async () => {
  const { host } = build()
  const state = await host.reasoning({ sessionId: 's1' })
  assert.equal(state.effort, 'medium', 'the session selection wins over the catalog default')
  assert.equal(state.model, 'deepseek-v4-pro')
  assert.deepEqual(state.supportedEfforts, ['off', 'low', 'medium', 'high', 'max'])
})

test('reasoning falls back to the catalog default before a session selects a model', async () => {
  const { host } = build()
  const state = await host.reasoning({})
  assert.equal(state.provider, 'p')
  assert.equal(state.model, 'm')
  assert.equal(state.effort, 'medium')
})

test('setReasoningEffort translates a level the model names differently', async () => {
  const { host, calls } = build()
  // The iOS picker still offers the OpenAI spellings; this model says "max".
  const result = await host.setReasoningEffort({ sessionId: 's1', effort: 'xhigh' })
  assert.equal(result.effort, 'max')
  assert.equal(calls.find(entry => entry.method === 'selectModel').args.request.reasoningEffort, 'max')
})

test('setReasoningEffort refuses a level the model does not offer, listing the real ones', async () => {
  const { host, calls } = build()
  await assert.rejects(
    () => host.setReasoningEffort({ sessionId: 's1', effort: 'ultra' }),
    error => {
      assert.match(error.message, /not offered by deepseek-official/)
      assert.match(error.message, /use one of off, low, medium, high, max/)
      return true
    },
  )
  assert.ok(!calls.some(entry => entry.method === 'selectModel'), 'nothing is sent to the host')
})

test('listDir lists an absolute directory with dirs, files and entries', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'hermes-list-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'readme.md'), 'hello\n')
  const { host } = build()
  const listing = await host.listDir('s1', root)
  assert.equal(listing.path, root)
  assert.deepEqual(listing.dirs, ['src'])
  assert.deepEqual(listing.files, ['readme.md'])
  assert.equal(listing.count, 2)
  assert.equal(listing.entries[0].is_dir, true, 'directories sort first')
})

test('readText returns content, name, language, size and lines', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'hermes-file-'))
  const file = join(root, 'notes.md')
  writeFileSync(file, 'one\ntwo\n')
  const { host } = build()
  const payload = await host.readText('s1', file)
  assert.equal(payload.content, 'one\ntwo\n')
  assert.equal(payload.name, 'notes.md')
  assert.equal(payload.language, 'md')
  assert.equal(payload.size, 8)
  assert.equal(payload.lines, 3)
})

test('readText refuses a binary file so the client uses file/raw', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'hermes-bin-'))
  const file = join(root, 'pic.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x0a]))
  const { host } = build()
  assert.equal(await host.readText('s1', file), undefined)
})

test('a relative path resolves against the session cwd', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'hermes-rel-'))
  writeFileSync(join(root, 'a.txt'), 'x\n')
  const { host } = build({}, { cwd: root })
  const payload = await host.readText('s1', 'a.txt')
  assert.equal(payload.content, 'x\n')
  assert.equal((await host.listDir('s1', '')).path, root, 'an empty path means the session cwd')
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

test('selectModel falls back to the new model declared default effort', async () => {
  const { host, calls } = build({}, {
    catalog: twoProviderCatalog(),
    selection: { lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'ultra' }, pending: null },
  })
  const selected = await host.selectModel({ sessionId: 's1', model: 'm' })
  const request = calls.find(entry => entry.method === 'selectModel').args.request
  assert.equal(request.reasoningEffort, 'medium', 'not offered -> declared default, not the first level')
  assert.equal(selected.reasoningEffort, 'medium')
})

test('selectModel carries the current effort over when the new model offers it', async () => {
  const { host, calls } = build({}, {
    catalog: twoProviderCatalog(),
    selection: { lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'low' }, pending: null },
  })
  const selected = await host.selectModel({ sessionId: 's1', model: 'm' })
  assert.equal(calls.find(entry => entry.method === 'selectModel').args.request.reasoningEffort, 'low')
  assert.equal(selected.reasoningEffort, 'low')
})

test('selectModel uses the first offered effort when the declared default is not offered', async () => {
  const { host, calls } = build({}, {
    catalog: twoProviderCatalog(),
    selection: { lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'ultra' }, pending: null },
  })
  const selected = await host.selectModel({ sessionId: 's1', model: 'm-nodefault' })
  assert.equal(calls.find(entry => entry.method === 'selectModel').args.request.reasoningEffort, 'off')
  assert.equal(selected.reasoningEffort, 'off')
})

test('selectModel splits @provider: ids and switches provider on a shared model name', async () => {
  const { host, calls } = build({}, {
    catalog: twoProviderCatalog(),
    selection: { lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'low' }, pending: null },
  })
  const selected = await host.selectModel({ sessionId: 's1', model: '@q:m' })
  const request = calls.find(entry => entry.method === 'selectModel').args.request
  assert.equal(request.provider, 'q')
  assert.equal(request.model, 'm')
  assert.equal(request.reasoningEffort, 'low')
  assert.equal(selected.provider, 'q')
})

test('selectModel reports an unknown model with the catalog error', async () => {
  const { host, calls } = build()
  await assert.rejects(
    () => host.selectModel({ sessionId: 's1', model: 'nope', provider: 'q' }),
    /model "nope" for provider "q" is not available in the model catalog/,
  )
  assert.ok(!calls.some(entry => entry.method === 'selectModel'))
})
