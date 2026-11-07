import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const rows = options.noSessions === true ? [] : [{
    sessionId: 's1',
    updatedAt: options.updatedAt ?? 1700000000000,
    running: false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    projections: { values: { modelSelection: selection, tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 } } },
  }, ...(options.extraRows ?? [])]
  const gateway = {
    async invoke(request) {
      calls.push(request)
      if (request.namespace === 'session' && request.method === 'list') return { items: rows }
      if (request.namespace === 'session' && request.method === 'projections') {
        return options.projections ?? { values: {} }
      }
      if (request.method === 'create' && request.namespace === 'workspace') {
        return { workspace: { workspaceId: 'ws-1', path: '/tmp', title: 'tmp', sessionIds: [] }, created: true }
      }
      if (request.namespace === 'session' && request.method === 'create') return { sessionId: 'created-1' }
      if (request.method === 'prompt') return { accepted: true }
      if (request.method === 'cancel') return { accepted: true }
      if (request.namespace === 'costMeter' && request.method === 'getBillingStatistics') return options.costStats
      if (request.namespace === 'skills' && request.method === 'list') {
        return { skills: options.skills ?? [{ name: 'demo', description: 'D', path: options.skillPath ?? '/nonexistent/SKILL.md' }] }
      }
      if (request.namespace === 'schedule') {
        if (request.method === 'list') return { items: [{ id: 's1' }], shown: 1, total: 1, limit: 100, offset: 0 }
        if (request.method === 'create') return { id: 's2', ...request.args?.request }
        if (request.method === 'edit') return { id: request.args?.request?.id }
        if (request.method === 'run') return { id: request.args?.request?.id, status: 'active' }
        if (request.method === 'history') return { id: request.args?.request?.id, records: [] }
      }
      if (request.method === 'modelCatalog') return options.catalog ?? defaultCatalog()
      if (request.namespace === 'speech' && request.method === 'transcribe') {
        // A fake speech Remote: the shape of failure is what the listener maps,
        // so the test picks it with `speech`.
        if (options.speech === 'invalid') {
          throw Object.assign(new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording'), {
            code: 'speech/invalid-audio',
            details: { reason: 'encoding-or-size' },
          })
        }
        if (options.speech === 'failed') {
          throw Object.assign(new Error('Speech provider is unavailable: sensevoice'), {
            code: 'speech/transcription-failed',
            details: { reason: 'Speech provider is unavailable: sensevoice' },
          })
        }
        if (options.speech === 'no-remote') {
          throw Object.assign(new Error('no active Remote method exports this endpoint'), {
            code: 'gateway/invocation-unavailable',
          })
        }
        if (options.speech === 'no-text') return { audioSeconds: 1.5, inferenceSeconds: 0.2 }
        return options.transcript ?? { text: 'plan the Nimbus migration', audioSeconds: 2.5, inferenceSeconds: 0.4 }
      }
      if (request.namespace === 'speech' && request.method === 'catalog') {
        if (options.speechCatalog === 'failed') throw new Error('speech catalog unavailable')
        return options.speechCatalog ?? { providers: [], selection: { providerId: 'fake-recognizer', language: 'auto' } }
      }
      if (request.namespace === 'session' && request.method === 'selectModel') {
        return { selected: request.args?.request ?? {} }
      }
      return {}
    },
    // The real gateway resolves to an AsyncIterable: mimic that, including the
    // Promise wrapper that used to break the for-await consumer.
    stream(request) {
      calls.push(request)
      if (request.namespace === 'session' && request.method === 'follow'
        && request.args?.request?.address?.kind === 'session'
        && request.args?.request?.address?.sessionId === 'sub-1') {
        throw new Error('subagent Sessions require their durable parent address')
      }
      if (request.namespace === 'workspace' && request.method === 'follow') {
        const items = Object.entries(existingWorkspaces).map(([path, workspaceId]) => ({
          workspaceId,
          path,
          title: path,
          sessionIds: [],
        }))
        return Promise.resolve((async function* frames() {
          yield {
            type: 'baseline',
            value: {
              items,
              archivedSessionIds: options.archivedSessionIds ?? [],
              pinnedSessionIds: options.pinnedSessionIds ?? [],
            },
          }
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


/**
 * Build a host adapter whose cordis waterfalls the test can fire.
 *
 * `build()` keeps `on()` inert; approvals and questions arrive as waterfalls,
 * so they need a fake ctx that records the listeners and a way to fire them.
 * @param {object} [options] options.
 * @param {boolean} [options.client] whether a phone is attached.
 * @returns {object} harness with the host, its notices and fire helpers.
 */
function buildInteractions(options = {}) {
  const handlers = new Map()
  const gateway = {
    async invoke() { return {} },
    stream() { return Promise.resolve((async function* empty() {})()) },
  }
  const ctx = {
    typertGateway: gateway,
    connection: { createPeer: () => ({ principal: 'owner' }) },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  const host = createDshHost({ ctx, logger: { info() {}, warn() {} } })
  host.setClientPredicate(() => options.client !== false)
  const notices = []
  host.onInteraction(notice => notices.push(notice))
  return {
    host,
    notices,
    /**
     * Fire one approval request.
     * @param {object} request approval request.
     * @returns {Promise<string>} the outcome the waterfall settles on.
     */
    ask(request) {
      return handlers.get('approval/request')(request, () => Promise.resolve('unavailable'))
    },
    /**
     * Fire one user-questions request.
     * @param {object} request question request.
     * @returns {Promise<object>} the answer batch the waterfall settles on.
     */
    askQuestion(request) {
      return handlers.get('user-questions/request')(request, () => Promise.resolve({ answers: [] }))
    },
  }
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

test('prompt attaches native image parts', async () => {
  const { host, calls } = build()
  const result = await host.prompt({
    sessionId: 's1',
    text: 'look',
    images: [{ mediaType: 'image/png', data: 'AAAA', name: 'pixel.png' }],
  })
  assert.deepEqual(result, { accepted: true })
  const call = calls.find(entry => entry.method === 'prompt')
  assert.deepEqual(call.args.request.content, [
    { type: 'text', text: 'look' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'pixel.png' },
  ])
})

test('prompt reads a staged image path and sends base64 data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-image-'))
  const file = join(dir, 'pixel.png')
  writeFileSync(file, Buffer.from('AAAA'))
  const { host, calls } = build()
  await host.prompt({
    sessionId: 's1',
    text: '',
    images: [{ mediaType: 'image/png', path: file, name: 'pixel.png' }],
  })
  const call = calls.find(entry => entry.method === 'prompt')
  assert.deepEqual(call.args.request.content, [
    { type: 'image', mediaType: 'image/png', data: 'QUFBQQ==', name: 'pixel.png' },
  ])
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

test('listSessions hides DSH subagent sessions', async () => {
  const { host } = build({}, { extraRows: [{ sessionId: 'sub-1', origin: 'subagent', parentSessionId: 's1' }] })
  const rows = await host.listSessions()
  assert.deepEqual(rows.map(row => row.sessionId), ['s1'], 'subagent rows stay internal for now')
})

test('readSession turns a DSH subagent rejection into a typed error', async () => {
  const { host } = build()
  await assert.rejects(
    () => host.readSession('sub-1'),
    error => error.code === 'subagent-session' && /parent chat/.test(error.message),
  )
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

test('workspaces() exposes the registry-global pin and archive sets', async () => {
  const { host } = build({}, { pinnedSessionIds: ['s1'], archivedSessionIds: ['s1', 's2'] })
  const value = await host.workspaces()
  assert.deepEqual(value.pinnedSessionIds, ['s1'])
  assert.deepEqual(value.archivedSessionIds, ['s1', 's2'])
})

test('workspaces() defaults both sets when the baseline omits them', async () => {
  const { host } = build()
  const value = await host.workspaces()
  assert.deepEqual(value.pinnedSessionIds, [])
  assert.deepEqual(value.archivedSessionIds, [])
})

test('pinSession drops the cached baseline so a new pin shows up immediately', async () => {
  const { host, calls } = build()
  await host.workspaces()
  await host.workspaces()
  const follows = () => calls.filter(entry => entry.namespace === 'workspace' && entry.method === 'follow').length
  assert.equal(follows(), 1, 'the second read is served from the cache')

  await host.pinSession({ sessionId: 's1', pinned: true })
  await host.workspaces()
  assert.equal(follows(), 2, 'the pin invalidated the baseline cache')
})


// ---- approvals & clarifications ---------------------------------------------

test('a pending approval keeps its command and description for a reconnect', async () => {
  const { host, ask } = buildInteractions()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1', reason: 'needs to run the tests' })

  // GET /api/approval/pending is served from this map: a bare approval_id is
  // what made the phone lose the command/description after a reconnect.
  assert.deepEqual(host.pendingApproval('s1'), {
    approval_id: 'call-1',
    command: 'bash',
    description: 'needs to run the tests',
  })

  assert.deepEqual(host.respondApproval({ approvalId: 'call-1', choice: 'once' }), {
    ok: true,
    choice: 'once',
    outcome: 'allowed-once',
  })
  assert.equal(await outcome, 'allowed-once')
  assert.equal(host.pendingApproval('s1'), undefined)
})

test('the localized displayReason is preferred over the raw reason', async () => {
  const { host, ask } = buildInteractions()
  ask({
    agent: { id: 's1' },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'internal reason',
    displayReason: { en: 'Run the test suite', de: 'Testlauf starten' },
  })
  assert.equal(host.pendingApproval('s1').description, 'Run the test suite')
  host.respondApproval({ approvalId: 'call-1', choice: 'deny' })
})

test('deny rejects the ask and leaves no grant', async () => {
  const { host, ask } = buildInteractions()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.deepEqual(host.respondApproval({ approvalId: 'call-1', choice: 'deny' }), {
    ok: true,
    choice: 'deny',
    outcome: 'rejected',
  })
  assert.equal(await outcome, 'rejected')
  // The same tool asks again next time: deny is not remembered.
  ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-2' })
  assert.notEqual(host.pendingApproval('s1'), undefined)
  host.respondApproval({ approvalId: 'call-2', choice: 'deny' })
})

test('session grants the tool for the rest of that session only', async () => {
  const { host, ask } = buildInteractions()
  const first = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.equal(host.respondApproval({ approvalId: 'call-1', choice: 'session' }).choice, 'session')
  assert.equal(await first, 'allowed-once')

  // Same session and tool: answered with the one grant DSH accepts, no card.
  assert.equal(await ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-2' }), 'allowed-once')
  assert.equal(host.pendingApproval('s1'), undefined)

  // A different tool still asks.
  const write = ask({ agent: { id: 's1' }, toolName: 'write', callId: 'call-3' })
  assert.equal(host.pendingApproval('s1').command, 'write')
  host.respondApproval({ approvalId: 'call-3', choice: 'deny' })
  assert.equal(await write, 'rejected')

  // Another session still asks for the same tool.
  const other = ask({ agent: { id: 's2' }, toolName: 'bash', callId: 'call-4' })
  assert.notEqual(host.pendingApproval('s2'), undefined)
  host.respondApproval({ approvalId: 'call-4', choice: 'deny' })
  assert.equal(await other, 'rejected')
})

test('always grants the tool in every session', async () => {
  const { host, ask } = buildInteractions()
  const first = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.equal(host.respondApproval({ approvalId: 'call-1', choice: 'always' }).choice, 'always')
  assert.equal(await first, 'allowed-once')
  assert.equal(await ask({ agent: { id: 's2' }, toolName: 'bash', callId: 'call-2' }), 'allowed-once')
  assert.equal(host.pendingApproval('s2'), undefined)
})

test('an unknown approval choice is refused instead of granted', async () => {
  const { host, ask } = buildInteractions()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.deepEqual(host.respondApproval({ approvalId: 'call-1', choice: 'sometimes' }), {
    ok: false,
    error: 'unknown approval choice: sometimes',
  })
  // The card stays up so the user can choose again.
  assert.notEqual(host.pendingApproval('s1'), undefined)
  host.respondApproval({ approvalId: 'call-1', choice: 'deny' })
  assert.equal(await outcome, 'rejected')
})

test('answering an already-resolved approval reports stale', async () => {
  const { host, ask } = buildInteractions()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.equal(host.respondApproval({ approvalId: 'c1', choice: 'once' }).stale, true, 'unknown id')
  host.respondApproval({ approvalId: 'call-1', choice: 'once' })
  await outcome
  assert.deepEqual(host.respondApproval({ approvalId: 'call-1', choice: 'once' }), { ok: false, stale: true })
})

test('a timed-out approval is retracted before it is handed to the GUI', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, ask, notices } = buildInteractions()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1' })
  assert.notEqual(host.pendingApproval('s1'), undefined)

  t.mock.timers.tick(10 * 60 * 1000)
  assert.equal(await outcome, 'unavailable', 'the GUI is asked after the phone card is withdrawn')
  assert.equal(host.pendingApproval('s1'), undefined)
  assert.ok(
    notices.some(notice => notice.kind === 'approval-resolved' && notice.reason === 'timeout'),
    'the phone is told to clear the card',
  )
})

test('a cancelled turn clears the approval card', async () => {
  const { host, ask, notices } = buildInteractions()
  const controller = new AbortController()
  const outcome = ask({ agent: { id: 's1' }, toolName: 'bash', callId: 'call-1', signal: controller.signal })
  controller.abort()
  assert.equal(await outcome, 'cancelled')
  assert.equal(host.pendingApproval('s1'), undefined)
  assert.ok(notices.some(notice => notice.kind === 'approval-resolved' && notice.reason === 'cancelled'))
})

test('a delegated approval reports resolved so a stale card clears', async () => {
  const { host, ask, notices } = buildInteractions({ client: false })
  assert.equal(await ask({ agent: { id: 's1' }, toolName: 'bash' }), 'unavailable')
  assert.equal(host.pendingApproval('s1'), undefined)
  assert.ok(notices.some(notice => notice.kind === 'approval-resolved' && notice.reason === 'delegated'))
})

test('a pending clarification keeps its question and choices for a reconnect', async () => {
  const { host, askQuestion } = buildInteractions()
  const answer = askQuestion({
    agent: { id: 's1' },
    id: 'q-1',
    questions: [{
      id: 'q-1',
      question: 'Which database should I use?',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
    }],
  })

  const pending = host.pendingClarification('s1')
  assert.equal(pending.clarify_id, 'q-1')
  assert.equal(pending.question, 'Which database should I use?')
  assert.deepEqual(pending.choices_offered, ['SQLite', 'Postgres'])
  assert.equal(pending.session_id, 's1')
  assert.equal(typeof pending.requested_at, 'number')

  assert.deepEqual(host.respondClarification({ clarifyId: 'q-1', response: 'Postgres', sessionId: 's1' }), { ok: true })
  // The answer batch names the question id the host echoed in the request.
  assert.deepEqual(await answer, { answers: [{ id: 'q-1', selected: ['Postgres'] }] })
  assert.equal(host.pendingClarification('s1'), undefined)
})

test('a clarification always carries a question marker, even without options', async () => {
  const { host, askQuestion } = buildInteractions()
  askQuestion({ agent: { id: 's1' }, id: 'q-2', questions: [{ id: 'q-2', question: 'What should I name it?' }] })
  const pending = host.pendingClarification('s1')
  assert.equal(pending.question, 'What should I name it?')
  assert.ok(!('choices_offered' in pending), 'no options means no choices_offered key')
  host.respondClarification({ clarifyId: 'q-2', response: 'Facade', sessionId: 's1' })
})

test('answering an already-resolved clarification reports stale', async () => {
  const { host, askQuestion } = buildInteractions()
  const answer = askQuestion({ agent: { id: 's1' }, id: 'q-3', questions: [{ id: 'q-3', question: 'Well?' }] })
  host.respondClarification({ clarifyId: 'q-3', response: 'yes', sessionId: 's1' })
  await answer
  assert.deepEqual(host.respondClarification({ clarifyId: 'q-3', response: 'yes', sessionId: 's1' }), {
    ok: false,
    stale: true,
  })
})

test('a timed-out clarification is retracted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, askQuestion, notices } = buildInteractions()
  const answer = askQuestion({ agent: { id: 's1' }, id: 'q-4', questions: [{ id: 'q-4', question: 'Well?' }] })
  t.mock.timers.tick(10 * 60 * 1000)
  assert.deepEqual(await answer, { answers: [] }, 'the GUI is asked after the phone card is withdrawn')
  assert.equal(host.pendingClarification('s1'), undefined)
  assert.ok(notices.some(notice => notice.kind === 'clarify-resolved' && notice.reason === 'timeout'))
})

test('sessionUsage maps token and context projections', async () => {
  const { host } = build({}, {
    projections: {
      values: {
        tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 40 },
        contextPressure: { contextWindow: 200000, pressureTokens: 5000, projectedTokens: 6000 },
      },
    },
  })
  assert.deepEqual(await host.sessionUsage('s1'), {
    input_tokens: 125, output_tokens: 40, context_length: 200000, last_prompt_tokens: 5000,
  })
})

test('sessionUsage omits what the projections do not report', async () => {
  const empty = build({}, { projections: null })
  assert.deepEqual(await empty.host.sessionUsage('s1'), {})
  const tokensOnly = build({}, {
    projections: { values: { tokenUsage: { uncachedInputTokens: 7, outputTokens: 3 } } },
  })
  assert.deepEqual(await tokensOnly.host.sessionUsage('s1'), { input_tokens: 7, output_tokens: 3 })
})

test('schedule remotes translate to host calls', async () => {
  const { host, calls } = build()
  assert.deepEqual(await host.listSchedules(), [{ id: 's1' }])
  assert.deepEqual(await host.createSchedule({ title: 'T', prompt: 'P', timing: { kind: 'every', every_seconds: 300 } }), { id: 's2', title: 'T', prompt: 'P', timing: { kind: 'every', every_seconds: 300 } })
  await host.editSchedule({ id: 's1', action: 'update', patch: { active: false } })
  await host.runSchedule('s1')
  await host.scheduleHistory('s1', 100)
  const scheduleCalls = calls.filter(call => call.namespace === 'schedule')
  assert.deepEqual(scheduleCalls.map(call => call.method), ['list', 'create', 'edit', 'run', 'history'])
  assert.deepEqual(scheduleCalls[0].args, { request: { limit: 100 } })
  assert.deepEqual(scheduleCalls[1].args, { request: { title: 'T', prompt: 'P', timing: { kind: 'every', every_seconds: 300 } } })
  assert.deepEqual(scheduleCalls[2].args, { request: { id: 's1', action: 'update', patch: { active: false } } })
  assert.deepEqual(scheduleCalls[4].args, { request: { id: 's1', limit: 100 } })
})

test('skills come from the newest session catalog and read only its SKILL.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-'))
  const skillPath = join(dir, 'SKILL.md')
  writeFileSync(skillPath, '# Demo\n')
  const { host, calls } = build({}, { skillPath })
  assert.deepEqual(await host.listSkills(), [{ name: 'demo', description: 'D', path: skillPath }])
  assert.deepEqual(await host.readSkill('demo'), { name: 'demo', content: '# Demo\n', path: skillPath })
  assert.equal(await host.readSkill('missing'), null)
  const call = calls.find(entry => entry.namespace === 'skills' && entry.method === 'list')
  assert.deepEqual(call.args, { request: { sessionId: 's1' } })
})

test('a package-provided skill reads its assets markdown instead of 404ing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'demo-package', 'assets'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'demo-package', 'assets', 'demo-package.md'), 'package body')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { host } = build({}, { skills: [{ name: 'demo-package', description: 'package skill' }] })
    assert.deepEqual(await host.readSkill('demo-package'), {
      name: 'demo-package',
      content: 'package body',
      path: join(home, 'profiles', 'web', 'node_modules', 'demo-package', 'assets', 'demo-package.md'),
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
  }
})

test('a pathless skill with no asset falls back to its description', async () => {
  const { host } = build({}, { skills: [{ name: 'no-asset-skill', description: 'what it does' }] })
  assert.deepEqual(await host.readSkill('no-asset-skill'), {
    name: 'no-asset-skill',
    content: 'what it does',
    path: '',
  })
})

test('usage merges dsh-cost-meter billing statistics, including cost-only rows', async () => {
  const now = Date.now()
  const localDay = date => String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const day = localDay(new Date(now))
  const older = localDay(new Date(now - 100 * 86400000))
  const costStats = {
    totals: { cost: 3.5 },
    days: [{ date: day, cost: 1.5 }, { date: older, cost: 2 }],
    models: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', cost: 1.5 },
      { provider: 'openrouter', model: 'vendor:variant', cost: 2 },
    ],
  }
  const { host, calls } = build({}, { updatedAt: now, costStats })
  const report = await host.usageReport(120)
  assert.equal(report.usage.totals.total_estimated_cost, 3.5)
  assert.equal(report.usage.daily.find(row => row.day === day).estimated_cost, 1.5)
  const extraDay = report.usage.daily.find(row => row.day === older)
  assert.equal(extraDay.estimated_cost, 2)
  assert.equal(extraDay.input_tokens, 0)
  assert.equal(report.models.models[0].estimated_cost, 1.5)
  const extraModel = report.models.models.find(row => row.model === 'vendor:variant')
  assert.equal(extraModel.estimated_cost, 2)
  assert.equal(extraModel.input_tokens, 0)
  const call = calls.find(entry => entry.namespace === 'costMeter' && entry.method === 'getBillingStatistics')
  assert.equal(call.args.query.basis, 'total')
  assert.equal(call.args.query.to, day)
  assert.equal(call.args.query.from, localDay(new Date(now - 120 * 86400000)))
})

test('zero cost entries from dsh-cost-meter add no daily or model rows', async () => {
  const now = Date.now()
  const localDay = date => String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
  const costStats = {
    totals: { cost: 0 },
    days: [{ date: localDay(new Date(now)), cost: 0 }, { date: localDay(new Date(now - 2 * 86400000)), cost: 0 }],
    models: [{ provider: 'openrouter', model: 'free-model', cost: 0 }],
  }
  const { host } = build({}, { updatedAt: now, costStats })
  const report = await host.usageReport(30)
  assert.equal(report.usage.totals.total_estimated_cost, 0)
  assert.equal(report.usage.daily.length, 1)
  assert.equal(report.models.models.length, 1)
})

test('usage stays token-only when dsh-cost-meter is absent', async () => {
  const { host } = build({}, { updatedAt: Date.now() })
  const report = await host.usageReport(30)
  assert.equal('total_estimated_cost' in report.usage.totals, false)
  assert.equal('estimated_cost' in report.usage.daily[0], false)
})

test('usage includes subagent sessions, excludes the window and attributes last-prompt days', async () => {
  const now = Date.now()
  const old = now - 40 * 86400000
  const promptAt = Date.parse('2026-11-01T12:00:00Z')
  const { host } = build({}, {
    updatedAt: now,
    extraRows: [
      {
        sessionId: 'sub', updatedAt: now, running: false, origin: 'subagent',
        projections: { values: {
          tokenUsage: { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0 },
          modelSelection: { lastUsed: { model: 'sub-model', provider: 'p2' } },
          sessionListMetadata: { lastPromptAt: promptAt },
        } },
      },
      {
        sessionId: 'old', updatedAt: old, running: false,
        projections: { values: { tokenUsage: { uncachedInputTokens: 999, outputTokens: 999, cacheReadTokens: 0 } } },
      },
      {
        sessionId: 'blank', updatedAt: now, running: false,
        projections: { values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } } },
      },
    ],
  })
  const report = await host.usageReport(30)
  assert.deepEqual(report.usage.totals, {
    total_input: 310, total_output: 151, total_cache_read: 30, total_sessions: 3,
  })
  assert.deepEqual(report.usage.daily.map(row => row.day), ['2026-11-01', new Date(now).toISOString().slice(0, 10)])
  const promptDay = report.usage.daily.find(row => row.day === '2026-11-01')
  assert.equal(promptDay.input_tokens, 200)
  assert.equal(promptDay.output_tokens, 100)
  assert.equal(promptDay.cache_read_tokens, 20)
  const subModel = report.models.models.find(row => row.model === 'sub-model')
  assert.equal(subModel.input_tokens, 200)
  assert.equal(subModel.output_tokens, 100)
  assert.equal(subModel.cache_read_tokens, 20)
  assert.equal(subModel.provider, 'p2')
  assert.equal(subModel.sessions, 1)
  assert.deepEqual(report.models.models.map(row => row.model).sort(), ['deepseek-v4-pro', 'sub-model'])
})

test('usage in a window with no sessions is an honest empty state', async () => {
  const { host } = build({}, { noSessions: true })
  const report = await host.usageReport(7)
  assert.deepEqual(report.usage.totals, { total_input: 0, total_output: 0, total_cache_read: 0, total_sessions: 0 })
  assert.deepEqual(report.usage.daily, [])
  assert.deepEqual(report.models.models, [])
})

test('usage reports tokens by day and model from session projections', async () => {
  const { host } = build({}, { updatedAt: Date.now() })
  const report = await host.usageReport(30)
  assert.deepEqual(report.usage.totals, {
    total_input: 100, total_output: 50, total_cache_read: 10, total_sessions: 1,
  })
  assert.equal(report.usage.period_days, 30)
  assert.equal(report.usage.daily.length, 1)
  assert.equal(report.usage.daily[0].sessions, 1)
  assert.equal(report.usage.daily[0].input_tokens, 100)
  assert.equal(report.models.models[0].model, 'deepseek-v4-pro')
  assert.equal(report.models.models[0].provider, 'deepseek-official')
  assert.equal(report.models.models[0].sessions, 1)
})

test('skills are empty when the host has no sessions', async () => {
  const { host, calls } = build({}, { noSessions: true })
  assert.deepEqual(await host.listSkills(), [])
  assert.equal(calls.some(entry => entry.namespace === 'skills'), false)
})

test('transcribe forwards one recording to the speech Remote', async () => {
  const { host, calls } = build()
  const result = await host.transcribe({ audioBase64: 'UklGRg==' })
  assert.deepEqual(result, { text: 'plan the Nimbus migration', provider: 'fake-recognizer' })
  const call = calls.find(entry => entry.namespace === 'speech' && entry.method === 'transcribe')
  assert.deepEqual(call.args, { request: { audioBase64: 'UklGRg==' } })
  assert.equal('providerId' in call.args.request, false, 'an unselected recognizer stays the host default')
  assert.equal('language' in call.args.request, false)
})

test('transcribe passes an explicit recognizer and language through', async () => {
  const { host, calls } = build()
  const result = await host.transcribe({ audioBase64: 'UklGRg==', providerId: 'sensevoice', language: 'en' })
  const call = calls.find(entry => entry.namespace === 'speech' && entry.method === 'transcribe')
  assert.deepEqual(call.args.request, { audioBase64: 'UklGRg==', providerId: 'sensevoice', language: 'en' })
  // The reply names the recognizer that was asked for without a second read.
  assert.deepEqual(result, { text: 'plan the Nimbus migration', provider: 'sensevoice' })
  assert.equal(calls.some(entry => entry.namespace === 'speech' && entry.method === 'catalog'), false)
})

test('transcribe keeps a provider-returned empty transcript as silence', async () => {
  const { host } = build({}, { transcript: { text: '', audioSeconds: 0.5, inferenceSeconds: 0.1 } })
  assert.deepEqual(await host.transcribe({ audioBase64: 'UklGRg==' }), { text: '', provider: 'fake-recognizer' })
})

test('transcribe never invents a transcript when the reply carries no text', async () => {
  const { host } = build({}, { speech: 'no-text' })
  await assert.rejects(host.transcribe({ audioBase64: 'UklGRg==' }), /returned no transcript/)
})

test('transcribe forwards the speech controller refusal unchanged', async () => {
  const { host } = build({}, { speech: 'invalid' })
  await assert.rejects(host.transcribe({ audioBase64: 'UklGRg==' }), error => {
    assert.equal(error.code, 'speech/invalid-audio')
    assert.match(error.message, /canonical 16 kHz mono PCM16 WAV/)
    return true
  })
})

test('transcribe omits the recognizer when the catalog cannot name it', async () => {
  const { host } = build({}, { speechCatalog: 'failed' })
  // The transcript already succeeded; a failed label read must not fail it or
  // invent a provider that did not run.
  assert.deepEqual(await host.transcribe({ audioBase64: 'UklGRg==' }), { text: 'plan the Nimbus migration' })
})
