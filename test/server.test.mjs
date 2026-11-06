import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFacadeServer } from '../src/server.mjs'
import { createMockHost } from '../scripts/standalone.mjs'

/**
 * Boot a facade on an ephemeral port with a fresh state directory.
 * @returns {Promise<object>} harness.
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-facade-'))
  const host = createMockHost()
  const config = { enabled: true, port: 0, bindHost: '127.0.0.1', dir, tokenTtlSeconds: 3600, logRequests: false }
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  const base = 'http://127.0.0.1:' + address.port
  return { facade, host, base, password: facade.auth.generatedPassword, dir }
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

test('health and auth gating', async t => {
  const { facade, base } = await boot()
  t.after(() => facade.close())

  const health = await fetch(base + '/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })

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
