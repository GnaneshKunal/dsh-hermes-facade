import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFacadeServer } from '../src/server.mjs'
import { createMockHost } from '../scripts/standalone.mjs'

/**
 * Boot a facade on an ephemeral port with a fresh state directory.
 * @param {object} [options] options.
 * @param {boolean} [options.logRequests] write access.log.
 * @returns {Promise<object>} harness.
 */
async function boot(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-facade-'))
  const host = createMockHost()
  const lines = []
  const logger = { info: line => lines.push(String(line)), warn: line => lines.push(String(line)) }
  const config = {
    enabled: true,
    port: 0,
    bindHost: '127.0.0.1',
    dir,
    tokenTtlSeconds: 3600,
    logRequests: options.logRequests === true,
    ...(options.config ?? {}),
  }
  const facade = createFacadeServer({ config, host, logger })
  const address = await facade.listen()
  const base = 'http://127.0.0.1:' + address.port
  return { facade, host, base, password: facade.auth.generatedPassword, dir, lines }
}

/**
 * Log in and return the cookie header.
 * @param {string} base base URL.
 * @param {string} password facade password.
 * @returns {Promise<string>} cookie header value.
 */
async function signIn(base, password) {
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  return cookieOf(login)
}

/**
 * Read one JSONL log file.
 * @param {string} path file path.
 * @returns {Array<object>} parsed lines.
 */
function readLog(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Extract the session cookie from a response.
 * @param {Response} res response.
 * @returns {string} cookie header value.
 */
function cookieOf(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]
  const value = (raw ?? []).filter(Boolean)[0] ?? ''
  return value.split(';')[0]
}

/**
 * Build a transcript of alternating user/assistant events, oldest first.
 * @param {number} count how many display messages.
 * @returns {Array<object>} session events.
 */
function transcriptEvents(count) {
  const base = 1800000000000
  return Array.from({ length: count }, (_, index) => {
    const time = base + index * 1000
    if (index % 2 === 0) {
      return { type: 'user/message', seq: index, time, data: { content: [{ type: 'text', text: 'u' + String(index) }] } }
    }
    return {
      type: 'assistant/message', seq: index, time,
      data: { message: { content: [{ type: 'text', text: 'a' + String(index) }] } },
    }
  })
}

test('a long transcript pages backwards instead of stopping at the newest window', async t => {
  const { facade, host, base, password } = await boot({ config: { historyPage: 5, historyWindow: 20 } })
  t.after(() => facade.close())
  host.seed('sess-mock', transcriptEvents(12))
  const cookie = await signIn(base, password)

  /**
   * Read one transcript page.
   * @param {string} query query string.
   * @returns {Promise<object>} session detail.
   */
  const page = async query => {
    const res = await fetch(base + '/api/session?' + query, { headers: { cookie } })
    assert.equal(res.status, 200)
    return (await res.json()).session
  }

  // The initial page is the configured page size (5), not the client's 2, and
  // reports how many older messages remain.
  const first = await page('session_id=sess-mock&messages=1&msg_limit=2')
  assert.deepEqual(first.messages.map(message => message.content), ['a7', 'u8', 'a9', 'u10', 'a11'])
  assert.equal(first.messages_offset, 7)
  assert.equal(first.messages_truncated, true)
  assert.equal(first.message_count, 12)

  // Each msg_before page is the chunk immediately before the cursor.
  const second = await page('session_id=sess-mock&messages=1&msg_limit=2&msg_before=7')
  assert.deepEqual(second.messages.map(message => message.content), ['a5', 'u6'])
  assert.equal(second.messages_offset, 5)
  assert.equal(second.messages_truncated, true)

  const third = await page('session_id=sess-mock&messages=1&msg_limit=2&msg_before=5')
  assert.deepEqual(third.messages.map(message => message.content), ['a3', 'u4'])
  assert.equal(third.messages_offset, 3)

  const fourth = await page('session_id=sess-mock&messages=1&msg_limit=2&msg_before=3')
  assert.deepEqual(fourth.messages.map(message => message.content), ['a1', 'u2'])
  assert.equal(fourth.messages_offset, 1)

  // The last page reaches index 0, which is what tells the app to stop.
  const last = await page('session_id=sess-mock&messages=1&msg_limit=2&msg_before=1')
  assert.deepEqual(last.messages.map(message => message.content), ['u0'])
  assert.equal(last.messages_offset, 0)
  assert.equal(last.messages_truncated, false)
})

test('a short transcript opens complete and reports no older pages', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  host.seed('sess-mock', transcriptEvents(3))
  const cookie = await signIn(base, password)

  const res = await fetch(base + '/api/session?session_id=sess-mock&messages=1&msg_limit=50', { headers: { cookie } })
  const body = await res.json()
  assert.equal(body.session.messages.length, 3)
  assert.equal(body.session.messages_offset, 0)
  assert.equal(body.session.messages_truncated, false)
})

test('health and auth gating', async t => {
  const { facade, base } = await boot()
  t.after(() => facade.close())

  const health = await fetch(base + '/health')
  assert.equal(health.status, 200)
  const healthBody = await health.json()
  assert.equal(healthBody.status, 'ok')
  // Extra fields drive /health checks and the hot-reload script; the client's
  // HealthResponse ignores keys it does not know.
  assert.equal(healthBody.active_streams, 0)
  assert.equal(healthBody.history.page, 200)
  assert.equal(healthBody.history.window, 800)

  const status = await fetch(base + '/api/auth/status')
  const statusBody = await status.json()
  assert.equal(statusBody.auth_enabled, true)
  assert.equal(statusBody.logged_in, false)
  assert.equal(statusBody.password_auth_enabled, true, 'must not be false or the app refuses password sign-in')

  const denied = await fetch(base + '/api/sessions')
  assert.equal(denied.status, 401)

  const bad = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
  })
  assert.equal(bad.status, 401)
})

test('login sets a cookie the rest of the API accepts', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  assert.equal(login.status, 200)
  assert.deepEqual(await login.json(), { ok: true })
  const cookie = cookieOf(login)
  assert.match(cookie, /^hermes_session=/)

  const sessions = await fetch(base + '/api/sessions', { headers: { cookie } })
  assert.equal(sessions.status, 200)
  const body = await sessions.json()
  assert.ok(Array.isArray(body.sessions))
  assert.ok(body.sessions.length >= 1)
  assert.equal(typeof body.server_time, 'number')
  const row = body.sessions[0]
  assert.equal(typeof row.session_id, 'string')
  assert.equal(typeof row.updated_at, 'number')
  assert.ok(row.title.length > 0)
})

test('session detail returns messages', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  await host.prompt({ sessionId: 'sess-mock', text: 'hello there' })

  const res = await fetch(base + '/api/session?session_id=sess-mock&messages=1&msg_limit=50', { headers: { cookie } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.session.session_id, 'sess-mock')
  assert.ok(Array.isArray(body.session.messages))
})

test('chat start streams token, done and stream_end over SSE', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const start = await fetch(base + '/api/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'hello world' }),
  })
  assert.equal(start.status, 200)
  const started = await start.json()
  assert.equal(typeof started.stream_id, 'string')
  assert.ok(started.stream_id.length > 0, 'stream_id is mandatory or the app rolls the bubble back')
  assert.equal(started.session_id, 'sess-mock')

  const stream = await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await stream.text()
  assert.match(text, /event: token/)
  assert.match(text, /event: done/)
  assert.match(text, /event: stream_end/)
  assert.match(text, /"text":"Echo: /)

  const replay = await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id + '&replay=1&after_seq=0', { headers: { cookie } })
  assert.equal(replay.status, 200)
  assert.match(await replay.text(), /event: token/)

  const finished = await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })
  assert.equal(finished.status, 200, 'a finished stream replays its journal instead of 404ing')
  assert.match(await finished.text(), /event: stream_end/)

  const unknown = await fetch(base + '/api/chat/stream?stream_id=nope', { headers: { cookie } })
  assert.equal(unknown.status, 404)
  assert.match(JSON.stringify(await unknown.json()), /stream not found/)

  const statusRes = await fetch(base + '/api/chat/stream/status?stream_id=' + started.stream_id, { headers: { cookie } })
  const statusBody = await statusRes.json()
  assert.equal(statusBody.active, false)
  assert.equal(statusBody.journal.terminal, true)
})

test('a turn with no stream chunks still delivers its text once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-facade-nochunks-'))
  const config = { enabled: true, port: 0, bindHost: '127.0.0.1', dir, tokenTtlSeconds: 3600, logRequests: false }
  const host = {
    setClientPredicate() {},
    onInteraction() { return () => {} },
    async listSessions() { return [] },
    async ensureSession() { return 's1' },
    async prompt() {},
    async cancel() {},
    async models() { return {} },
    async commands() { return [] },
    async workspaces() { return { workspaces: [] } },
    pendingApproval() { return undefined },
    pendingClarification() { return undefined },
    respondApproval() { return { ok: false } },
    respondClarification() { return { ok: false } },
    // No assistant-stream frames at all: only the durable message and turn end.
    async *follow() {
      yield { type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'settled text' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } } }
    },
  }
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  const base = 'http://127.0.0.1:' + address.port
  t.after(() => facade.close())

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: facade.auth.generatedPassword }),
  })
  const cookie = cookieOf(login)
  const start = await (await fetch(base + '/api/chat/start', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ message: 'hi' }),
  })).json()
  const text = await (await fetch(base + '/api/chat/stream?stream_id=' + start.stream_id, { headers: { cookie } })).text()
  assert.match(text, /event: token/)
  assert.match(text, /settled text/)
  assert.equal((text.match(/settled text/g) ?? []).length, 1, 'the settled text must not be duplicated')
})

test('session actions answer instead of 404ing', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  })

  const created = await (await post('/api/session/new', {})).json()
  assert.equal(typeof created.session.session_id, 'string')
  const id = created.session.session_id

  const renamed = await (await post('/api/session/rename', { session_id: id, title: 'Renamed' })).json()
  assert.equal(renamed.ok, true)
  const list = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  assert.equal(list.sessions.find(row => row.session_id === id).title, 'Renamed')

  assert.equal((await (await post('/api/session/pin', { session_id: id, pinned: true })).json()).ok, true)
  assert.equal((await (await post('/api/session/archive', { session_id: id, archived: true })).json()).ok, true)

  const forked = await (await post('/api/session/branch', { session_id: id, keep_count: 1 })).json()
  assert.equal(forked.ok, true)
  assert.equal(typeof forked.session_id, 'string')

  // No DSH equivalent: still a 200 with an honest message, never the scary
  // "server endpoint was not found" the app shows for a 404.
  const unsupported = await post('/api/session/delete', { session_id: id })
  assert.equal(unsupported.status, 200)
  const body = await unsupported.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /not supported/i)
})

test('approval pending, SSE and respond', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const empty = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { pending: null, pending_count: 0 })

  const pending = host.simulateApproval('sess-mock')

  const listed = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  const listedBody = await listed.json()
  assert.equal(listedBody.pending.approval_id, pending.approval_id)
  assert.equal(listedBody.pending_count, 1)

  const respond = await fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'once', approval_id: pending.approval_id }),
  })
  assert.equal(respond.status, 200)
  assert.deepEqual(await respond.json(), { ok: true })

  const gone = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  assert.deepEqual(await gone.json(), { pending: null, pending_count: 0 })
})

test('/api/media serves a referenced file', async t => {
  const { writeFileSync } = await import('node:fs')
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  const file = join(mkdtempSync(join(tmpdir(), 'hermes-media-')), 'pic.png')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const res = await fetch(base + '/api/media?session_id=sess-mock&path=' + encodeURIComponent(file), { headers: { cookie } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal((await res.arrayBuffer()).byteLength, 4)

  const missing = await fetch(base + '/api/media?session_id=sess-mock&path=/nope.png', { headers: { cookie } })
  assert.equal(missing.status, 404)
})

test('the effort chip starts on the model default, not a hard-coded medium', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const status = await (await fetch(base + '/api/reasoning?session_id=sess-mock', { headers: { cookie } })).json()
  assert.equal(status.effective_effort, 'high', 'the catalog default, not "medium"')
  assert.equal(status.reasoning_effort, 'high')
  assert.deepEqual(status.supported_efforts, ['off', 'low', 'medium', 'high', 'max'])
  assert.ok(!status.supported_efforts.includes('xhigh'), 'advertising a level the model lacks breaks every change')
  assert.equal(status.supports_reasoning_effort, true)
})

test('changing reasoning effort answers instead of 404ing', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const res = await fetch(base + '/api/reasoning', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ effort: 'high', session_id: 'sess-mock' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.reasoning_effort, 'high')
  assert.ok(Array.isArray(body.supported_efforts))

  const status = await (await fetch(base + '/api/reasoning?session_id=sess-mock', { headers: { cookie } })).json()
  assert.equal(status.reasoning_effort, 'high', 'the GET reflects what was saved')
})

test('a stale effort name is translated instead of failing', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  // The iOS picker used to be offered the OpenAI spellings for this model.
  const body = await (await fetch(base + '/api/reasoning', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ effort: 'xhigh', session_id: 'sess-mock' }),
  })).json()
  assert.equal(body.ok, true)
  assert.equal(body.reasoning_effort, 'max', 'xhigh is what this model calls max')
  const status = await (await fetch(base + '/api/reasoning?session_id=sess-mock', { headers: { cookie } })).json()
  assert.equal(status.effective_effort, 'max')
})

test('an effort the model does not offer answers ok:false with the real levels', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const res = await fetch(base + '/api/reasoning', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ effort: 'ultra', session_id: 'sess-mock' }),
  })
  assert.equal(res.status, 200, 'a refused action is 200 ok:false, not a transport error')
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /not offered/)
  assert.deepEqual(body.supported_efforts, ['off', 'low', 'medium', 'high', 'max'])
  assert.equal(body.reasoning_effort, 'high', 'the current effort is still reported so the chip stays usable')
})

test('an effort change without a session_id says what is missing', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const body = await (await fetch(base + '/api/reasoning', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ effort: 'high' }),
  })).json()
  assert.equal(body.ok, false)
  assert.equal(body.error, 'session_id required')
})

test('unknown writes answer 200 ok:false instead of 404', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  const res = await fetch(base + '/api/session/frobnicate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /not supported/i)
})

test('a bare new chat joins the default workspace instead of none', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  // This is exactly what the app sends: profile only, no workspace, no project.
  await fetch(base + '/api/session/new', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ profile: 'default' }),
  })
  assert.equal(host.lastEnsure.workspacePath, process.cwd(), 'falls back to the host cwd')
  assert.equal(host.lastEnsure.projectId, undefined)
})

test('chat/start adopts the session into the workspace the app names', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)
  // The shape the app actually posts: workspace on start, not on create.
  const started = await (await fetch(base + '/api/chat/start', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      profile: 'default',
      message: 'hi',
      workspace: '/Users/gnanesh/setu/litellm-super-openrouter',
      session_id: 'sess-mock',
    }),
  })).json()
  assert.equal(typeof started.stream_id, 'string')
  assert.equal(host.lastAdopt.sessionId, 'sess-mock')
  assert.equal(host.lastAdopt.workspacePath, '/Users/gnanesh/setu/litellm-super-openrouter')
})

test('projects come from DSH workspaces and sessions carry project_id', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const projects = await (await fetch(base + '/api/projects', { headers: { cookie } })).json()
  assert.equal(projects.projects.length, 1)
  assert.equal(projects.projects[0].project_id, 'ws-mock')
  assert.equal(projects.projects[0].name, 'mock workspace')

  const sessions = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  const row = sessions.sessions.find(entry => entry.session_id === 'sess-mock')
  assert.equal(row.project_id, 'ws-mock', 'the list groups under the workspace')
})

test('composer catalogs and unknown paths', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const models = await (await fetch(base + '/api/models', { headers: { cookie } })).json()
  assert.equal(typeof models.models[0].id, 'string', 'flat list is emitted alongside groups')
  assert.equal(models.groups[0].models[0].id, 'deepseek-v4-pro')
  assert.equal(models.groups[0].provider_id, 'deepseek-official', 'the picker needs the provider route')
  assert.equal(models.models[0].label, 'DeepSeek V4 Pro')
  assert.equal(models.default_model, 'deepseek-v4-pro')
  assert.equal(models.active_provider, 'deepseek-official')

  const commands = await (await fetch(base + '/api/commands', { headers: { cookie } })).json()
  assert.deepEqual(commands.commands, [])

  const workspaces = await (await fetch(base + '/api/workspaces', { headers: { cookie } })).json()
  assert.ok(Array.isArray(workspaces.workspaces))

  const profiles = await (await fetch(base + '/api/profiles', { headers: { cookie } })).json()
  assert.equal(profiles.single_profile_mode, true)

  const missing = await fetch(base + '/api/does-not-exist', { headers: { cookie } })
  assert.equal(missing.status, 404)
})

test('the model picker applies through session/update', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const updated = await fetch(base + '/api/session/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', model: 'deepseek-v4-pro', model_provider: 'deepseek-official' }),
  })
  assert.equal(updated.status, 200)
  const body = await updated.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.model, 'deepseek-v4-pro')
  assert.equal(body.session.model_provider, 'deepseek-official')
  assert.equal(host.lastSelectedModel.model, 'deepseek-v4-pro', 'the host selection actually changed')

  const list = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  assert.equal(list.sessions[0].model, 'deepseek-v4-pro')
  assert.equal(list.sessions[0].model_provider, 'deepseek-official')
})

test('an unavailable model is a 400 instead of a silent no-op', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const rejected = await fetch(base + '/api/session/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', model: 'gpt-nowhere' }),
  })
  assert.equal(rejected.status, 400)
  assert.match((await rejected.json()).error, /not available in the model catalog/)
  assert.equal(host.lastSelectedModel, undefined)
})

test('chat start applies a model chosen before the session existed', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const start = await fetch(base + '/api/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      session_id: 'sess-mock', message: 'hello', model: 'deepseek-v4-pro', model_provider: 'deepseek-official',
    }),
  })
  assert.equal(start.status, 200)
  assert.equal(host.lastSelectedModel.model, 'deepseek-v4-pro')

  const bad = await fetch(base + '/api/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'hello', model: 'nope' }),
  })
  assert.equal(bad.status, 400)
  assert.equal(typeof (await bad.json()).detail, 'string')
})

test('session/new applies the requested model', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const created = await fetch(base + '/api/session/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ model: 'deepseek-v4-pro', model_provider: 'deepseek-official' }),
  })
  assert.equal(created.status, 200)
  const body = await created.json()
  assert.equal(body.session.model, 'deepseek-v4-pro')
  assert.equal(host.lastSelectedModel.model, 'deepseek-v4-pro')
})

test('a reloaded transcript carries tool results as persisted tool calls', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  host.seed('sess-mock', [
    { type: 'user/message', seq: 0, time: 1800000000000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'list files' }] } },
    {
      type: 'assistant/message', seq: 1, time: 1800000001000,
      data: { message: { content: [{ type: 'text', text: 'Running' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] } },
    },
    { type: 'tool/call', seq: 2, time: 1800000001000, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result', seq: 3, time: 1800000002500,
      data: { message: { toolCallId: 'c1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file.txt' }] }] } },
    },
  ])
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })
  const cookie = cookieOf(login)

  const res = await fetch(base + '/api/session?session_id=sess-mock&messages=1&msg_limit=50', { headers: { cookie } })
  const body = await res.json()
  assert.equal(body.session.tool_calls.length, 1)
  const call = body.session.tool_calls[0]
  assert.equal(call.tid, 'c1')
  assert.equal(call.name, 'bash')
  assert.equal(call.snippet, 'file.txt')
  assert.equal(call.is_error, false)
  assert.equal(call.assistant_msg_idx, 1)
  assert.equal(call.duration, 1.5)
  assert.equal(body.session.messages.some(message => message.role === 'tool'), false)
})

test('subagent sessions are hidden and a direct open answers 400', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  const record = host.seed('subagent-mock', [])
  record.origin = 'subagent'
  const cookie = await signIn(base, password)

  const list = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  assert.equal(list.sessions.some(row => row.session_id === 'subagent-mock'), false)

  host.readSession = async () => {
    const error = new Error('This is a subagent session; open the parent chat instead.')
    error.code = 'subagent-session'
    throw error
  }
  const direct = await fetch(base + '/api/session?session_id=subagent-mock&messages=1&msg_limit=50', { headers: { cookie } })
  assert.equal(direct.status, 400)
  assert.match(JSON.stringify(await direct.json()), /subagent/)
})

test('the workspace file browser lists a directory and reads a text file', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const root = mkdtempSync(join(tmpdir(), 'hermes-browse-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'notes.md'), 'line one\nline two\n')

  const listing = await (await fetch(base + '/api/list?session_id=sess-mock&path=' + encodeURIComponent(root), { headers: { cookie } })).json()
  assert.equal(listing.path, root)
  assert.deepEqual(listing.dirs, ['src'])
  assert.deepEqual(listing.files, ['notes.md'])
  assert.equal(listing.entries[0].is_dir, true)

  const file = await (await fetch(base + '/api/file?session_id=sess-mock&path=' + encodeURIComponent(join(root, 'notes.md')), { headers: { cookie } })).json()
  assert.equal(file.content, 'line one\nline two\n')
  assert.equal(file.name, 'notes.md')
  assert.equal(file.language, 'md')
  assert.equal(file.lines, 3)

  const absent = await fetch(base + '/api/list?session_id=sess-mock&path=' + encodeURIComponent(join(root, 'nope')), { headers: { cookie } })
  assert.equal(absent.status, 404)
})

test('unknown endpoints are written to their own log, with the body', async t => {
  const { facade, base, password, dir } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  await fetch(base + '/api/workspace/frobnicate', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ path: '/private/tmp' }),
  })
  await fetch(base + '/api/nope', { headers: { cookie } })

  const entries = readLog(join(dir, 'unknown-endpoints.log'))
  const write = entries.find(entry => entry.method === 'POST' && entry.path === '/api/workspace/frobnicate')
  assert.equal(write.kind, 'unsupported-write')
  assert.equal(write.status, 200)
  assert.match(write.body, /private\/tmp/, 'the body is kept so the client call can be reconstructed')
  const read = entries.find(entry => entry.method === 'GET' && entry.path === '/api/nope')
  assert.equal(read.kind, 'no-route')
  assert.equal(read.status, 404)
})

test('access.log records method, path, status and duration when enabled', async t => {
  const { facade, base, password, dir } = await boot({ logRequests: true })
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  await fetch(base + '/api/sessions', { headers: { cookie } })
  // The line is written from the response "finish" hook.
  await new Promise(resolve => setTimeout(resolve, 100))

  const entries = readLog(join(dir, 'access.log'))
  const row = entries.find(entry => entry.path === '/api/sessions' && entry.status === 200)
  assert.ok(row !== undefined, 'the request appears in access.log')
  assert.equal(row.method, 'GET')
  assert.equal(typeof row.ms, 'number')
  assert.equal(row.client_gone, undefined, 'the client waited for the answer')
})

test('default-model answers once, with a decodable body', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const res = await fetch(base + '/api/default-model', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ model: 'deepseek-v4-pro', provider: 'deepseek-official' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.default_model, 'deepseek-v4-pro')
  assert.equal(body.persisted, false)

  // A second response would have poisoned this keep-alive connection.
  const after = await fetch(base + '/api/sessions', { headers: { cookie } })
  assert.equal(after.status, 200)
})
