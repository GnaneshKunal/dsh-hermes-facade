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


/**
 * Open an SSE endpoint and read one parsed frame at a time.
 *
 * The prompt streams never end by themselves, so a test reads the frames it
 * needs and then closes the response; comment heartbeats are skipped.
 * @param {string} url url to open.
 * @param {string} cookie session cookie header.
 * @returns {Promise<{nextEvent: Function, close: Function}>} frame reader.
 */
async function openSse(url, cookie) {
  const controller = new AbortController()
  const res = await fetch(url, { headers: { cookie }, signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  /**
   * Read the next named event, or null when none arrives inside the budget.
   * @param {number} [timeoutMs] budget.
   * @returns {Promise<{event: string, data: string}|null>} frame.
   */
  async function nextEvent(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (!done) {
      const split = buffer.indexOf('\n\n')
      if (split >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        if (frame.startsWith(':')) continue
        let event = ''
        let data = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (event.length > 0) return { event, data }
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      let timer
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), remaining) }),
      ])
      clearTimeout(timer)
      if (chunk.timedOut === true) return null
      if (chunk.done) {
        done = true
        return null
      }
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    return null
  }

  return {
    nextEvent,
    close() {
      try { controller.abort() } catch { /* already closed */ }
    },
  }
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
  // Build markers: these say the reconnect payloads/retraction are in this build.
  assert.ok(healthBody.features.includes('approval-retract'))
  assert.ok(healthBody.features.includes('clarify-markers'))

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
  // The app rebuilds its context ring from this detail after every turn.
  assert.equal(body.session.context_length, 200000)
  assert.equal(body.session.last_prompt_tokens, 4321)
  assert.equal(body.session.input_tokens, 1234)
  assert.equal(body.session.output_tokens, 56)
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
  assert.match(text, /event: usage/)
  assert.match(text, /event: done/)
  assert.match(text, /event: stream_end/)
  // The done event carries the Legacy context-window snapshot: tokens and the
  // provider's context pressure, from the session projections. No cost: DSH has
  // no pricing.
  assert.match(text, /"input_tokens":1234/)
  assert.match(text, /"output_tokens":56/)
  assert.match(text, /"context_length":200000/)
  assert.match(text, /"last_prompt_tokens":4321/)
  assert.doesNotMatch(text, /event: (error|cancel)/, 'a completed turn carries no failure terminal')
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

test('a failed turn ends the stream with error, not done', async t => {
  const { facade, base, password, host } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  host.setTurnOutcome('failed')

  const start = await fetch(base + '/api/chat/start', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'fail please' }),
  })
  const started = await start.json()
  const text = await (await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })).text()

  assert.match(text, /event: error/)
  assert.match(text, /"message":"The turn failed: mock provider failure"/)
  assert.doesNotMatch(text, /event: done/, 'a failed turn must not report completion')
  assert.doesNotMatch(text, /event: stream_end/, 'error closes the stream; a stream_end after it is a second, completing teardown')

  const statusRes = await fetch(base + '/api/chat/stream/status?stream_id=' + started.stream_id, { headers: { cookie } })
  assert.equal(statusRes.status, 200)
  const statusBody = await statusRes.json()
  assert.equal(statusBody.active, false)
  assert.equal(statusBody.journal.terminal_state, 'failed')
})

test('a cancelled turn reports cancel, not done', async t => {
  const { base, password, host, facade } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  host.setTurnOutcome('cancelled')

  const start = await fetch(base + '/api/chat/start', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'stop this' }),
  })
  const started = await start.json()
  const text = await (await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })).text()

  assert.match(text, /event: cancel/)
  assert.doesNotMatch(text, /event: done/)
  assert.doesNotMatch(text, /event: stream_end/)

  const statusRes = await fetch(base + '/api/chat/stream/status?stream_id=' + started.stream_id, { headers: { cookie } })
  assert.equal((await statusRes.json()).journal.terminal_state, 'cancelled')
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

test('approval pending carries the command and description the phone needs', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const empty = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { pending: null, pending_count: 0 })

  const pending = host.simulateApproval('sess-mock')

  const listed = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  const listedBody = await listed.json()
  assert.equal(listedBody.pending.approval_id, pending.approval_id)
  assert.equal(listedBody.pending.command, 'bash', 'a re-attached card keeps the command')
  assert.equal(listedBody.pending.description, 'Run npm test', 'and the description')
  assert.equal(listedBody.pending_count, 1)

  const respond = await fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'once', approval_id: pending.approval_id }),
  })
  assert.equal(respond.status, 200)
  assert.deepEqual(await respond.json(), { ok: true, choice: 'once' })

  const gone = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  assert.deepEqual(await gone.json(), { pending: null, pending_count: 0 })
})

test('the approval stream re-sends the full pending payload on reattach', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const pending = host.simulateApproval('sess-mock')

  const sse = await openSse(base + '/api/approval/stream?session_id=sess-mock', cookie)
  t.after(() => sse.close())
  const initial = await sse.nextEvent()
  assert.equal(initial.event, 'initial')
  const payload = JSON.parse(initial.data).pending
  assert.equal(payload.approval_id, pending.approval_id)
  assert.equal(payload.command, 'bash', 'without this the card cannot describe the ask')
  assert.equal(payload.description, 'Run npm test')
})

test('a live approval is pushed, then retracted when the phone answers', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const sse = await openSse(base + '/api/approval/stream?session_id=sess-mock', cookie)
  t.after(() => sse.close())
  // Nothing pending: the stream starts with an explicit clear, so a card left
  // over from a previous connection cannot linger.
  const cleared = await sse.nextEvent()
  assert.equal(cleared.event, 'approval')
  assert.deepEqual(JSON.parse(cleared.data), { pending: null, pending_count: 0 })

  const pending = host.simulateApproval('sess-mock')
  const live = await sse.nextEvent()
  assert.equal(live.event, 'approval')
  assert.equal(JSON.parse(live.data).pending.approval_id, pending.approval_id)

  const respond = await fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'once', approval_id: pending.approval_id }),
  })
  assert.equal(respond.status, 200)

  const retracted = await sse.nextEvent()
  assert.equal(retracted.event, 'approval')
  assert.deepEqual(JSON.parse(retracted.data), { pending: null, pending_count: 0 })
})

test('a prompt resolved without the phone is retracted over the stream', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const sse = await openSse(base + '/api/approval/stream?session_id=sess-mock', cookie)
  t.after(() => sse.close())
  await sse.nextEvent() // the opening clear

  host.simulateApproval('sess-mock')
  assert.equal((await sse.nextEvent()).event, 'approval')

  // A GUI-side answer, a timeout, or a cancelled turn all surface as a resolve.
  host.simulatePromptResolved('sess-mock')
  const retracted = await sse.nextEvent()
  assert.equal(retracted.event, 'approval')
  assert.deepEqual(JSON.parse(retracted.data), { pending: null, pending_count: 0 })
  assert.equal((await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })).status, 200)
})

test('an already-resolved approval answers 409 stale', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const pending = host.simulateApproval('sess-mock')

  const send = () => fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'once', approval_id: pending.approval_id }),
  })

  assert.equal((await send()).status, 200)
  const again = await send()
  assert.equal(again.status, 409, 'the app dismisses the card only on 409 {stale:true}')
  assert.deepEqual(await again.json(), { stale: true })

  const unknown = await fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'once', approval_id: 'never-existed' }),
  })
  assert.equal(unknown.status, 409)
})

test('session and always approvals are remembered, not collapsed into once', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const respond = (approvalId, choice) => fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice, approval_id: approvalId }),
  })
  const pendingOf = async sessionId => {
    const res = await fetch(base + '/api/approval/pending?session_id=' + sessionId, { headers: { cookie } })
    return (await res.json()).pending
  }

  // "Allow session": the same tool stops asking in this session only.
  const first = host.simulateApproval('sess-mock', { command: 'bash' })
  const session = await respond(first.approval_id, 'session')
  assert.deepEqual(await session.json(), { ok: true, choice: 'session' })
  host.simulateApproval('sess-mock', { command: 'bash' })
  assert.equal(await pendingOf('sess-mock'), null, 'session grants the tool')
  const write = host.simulateApproval('sess-mock', { command: 'write' })
  assert.equal((await pendingOf('sess-mock')).approval_id, write.approval_id, 'another tool still asks')
  await respond(write.approval_id, 'deny')
  assert.equal(await pendingOf('sess-mock'), null)

  // The grant is per session: another session asks for the same tool again.
  const other = host.simulateApproval('sess-other', { command: 'bash' })
  assert.equal((await pendingOf('sess-other')).approval_id, other.approval_id, 'the session grant does not cross sessions')
  const always = await respond(other.approval_id, 'always')
  assert.deepEqual(await always.json(), { ok: true, choice: 'always' })
  host.simulateApproval('sess-third', { command: 'bash' })
  assert.equal(await pendingOf('sess-third'), null, 'always grants the tool across sessions')
})

test('an unknown approval choice is refused and keeps the card up', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const pending = host.simulateApproval('sess-mock')

  // No default choice: an unrecognised value must never become a grant.
  const res = await fetch(base + '/api/approval/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', choice: 'sometimes', approval_id: pending.approval_id }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /unknown approval choice/)
  const still = await fetch(base + '/api/approval/pending?session_id=sess-mock', { headers: { cookie } })
  assert.equal((await still.json()).pending.approval_id, pending.approval_id)
})

test('clarify pending and initial carry question and choices_offered', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)
  const pending = host.simulateClarification('sess-mock')

  const listed = await fetch(base + '/api/clarify/pending?session_id=sess-mock', { headers: { cookie } })
  const body = await listed.json()
  assert.equal(listed.status, 200)
  assert.equal(body.pending.clarify_id, pending.clarify_id)
  assert.equal(body.pending.question, 'Which database should I use?')
  assert.deepEqual(body.pending.choices_offered, ['SQLite', 'Postgres'])
  assert.equal(body.pending_count, 1)

  const sse = await openSse(base + '/api/clarify/stream?session_id=sess-mock', cookie)
  t.after(() => sse.close())
  const initial = await sse.nextEvent()
  assert.equal(initial.event, 'initial')
  // The client sniffs these keys to tell a clarification from an approval.
  const payload = JSON.parse(initial.data).pending
  assert.equal(payload.clarify_id, pending.clarify_id)
  assert.equal(payload.question, 'Which database should I use?')
  assert.deepEqual(payload.choices_offered, ['SQLite', 'Postgres'])
})

test('a clarification answer succeeds and retracts the card', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const sse = await openSse(base + '/api/clarify/stream?session_id=sess-mock', cookie)
  t.after(() => sse.close())
  const cleared = await sse.nextEvent()
  assert.equal(cleared.event, 'clarify')
  assert.deepEqual(JSON.parse(cleared.data), { pending: null, pending_count: 0 })

  const pending = host.simulateClarification('sess-mock')
  const live = await sse.nextEvent()
  assert.equal(live.event, 'clarify')
  assert.equal(JSON.parse(live.data).pending.question, 'Which database should I use?')

  const respond = await fetch(base + '/api/clarify/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', response: 'Postgres', clarify_id: pending.clarify_id }),
  })
  assert.equal(respond.status, 200)
  assert.deepEqual(await respond.json(), { ok: true })
  assert.deepEqual(host.lastClarificationResponse, { clarifyId: pending.clarify_id, response: 'Postgres' })

  const retracted = await sse.nextEvent()
  assert.equal(retracted.event, 'clarify')
  assert.deepEqual(JSON.parse(retracted.data), { pending: null, pending_count: 0 })

  const gone = await fetch(base + '/api/clarify/pending?session_id=sess-mock', { headers: { cookie } })
  assert.deepEqual(await gone.json(), { pending: null, pending_count: 0 })
})

test('the chat stream hands a re-attached turn the full pending prompts', async t => {
  const { facade, base, host, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  host.simulateApproval('sess-mock')
  host.simulateClarification('sess-mock')
  const start = await fetch(base + '/api/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'hello' }),
  })
  const started = await start.json()
  const text = await (await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })).text()

  assert.match(text, /event: approval/)
  assert.match(text, /"command":"bash"/, 'the chat stream carries the command too')
  assert.match(text, /"description":"Run npm test"/)
  assert.match(text, /event: clarify/)
  assert.match(text, /"choices_offered":\["SQLite","Postgres"\]/)
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


/**
 * POST a JSON body with the session cookie.
 * @param {string} base base URL.
 * @param {string} cookie cookie header.
 * @param {string} path route.
 * @param {object} body payload.
 * @returns {Promise<Response>} response.
 */
function postJson(base, cookie, path, body) {
  return fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  })
}

test('sessions mark pinned and archived state and list archived only on opt-in', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  host.seed('sess-archived', transcriptEvents(2))
  host.seed('sess-archived-2', transcriptEvents(2))
  const cookie = await signIn(base, password)

  assert.equal((await (await postJson(base, cookie, '/api/session/pin', { session_id: 'sess-mock', pinned: true })).json()).ok, true)
  // Pinning then archiving drops the pin, as it does in DSH.
  assert.equal((await (await postJson(base, cookie, '/api/session/pin', { session_id: 'sess-archived-2', pinned: true })).json()).ok, true)
  assert.equal((await (await postJson(base, cookie, '/api/session/archive', { session_id: 'sess-archived', archived: true })).json()).ok, true)
  assert.equal((await (await postJson(base, cookie, '/api/session/archive', { session_id: 'sess-archived-2', archived: true })).json()).ok, true)

  const plain = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  assert.equal(plain.sessions.some(row => row.session_id === 'sess-archived'), false, 'archived rows are hidden by default')
  assert.equal(plain.sessions.some(row => row.session_id === 'sess-archived-2'), false)
  const pinnedRow = plain.sessions.find(row => row.session_id === 'sess-mock')
  assert.equal(pinnedRow.pinned, true)
  assert.equal(pinnedRow.archived, false)
  assert.equal(plain.archived_count, 2, 'the Archived entry still knows how many exist')
  assert.equal(plain.include_archived, false)

  const all = await (await fetch(base + '/api/sessions?include_archived=1', { headers: { cookie } })).json()
  assert.equal(all.sessions.length, 3)
  const archivedOne = all.sessions.find(row => row.session_id === 'sess-archived')
  assert.equal(archivedOne.archived, true)
  assert.equal(archivedOne.pinned, false)
  const archivedTwo = all.sessions.find(row => row.session_id === 'sess-archived-2')
  assert.equal(archivedTwo.archived, true)
  assert.equal(archivedTwo.pinned, false, 'archiving dropped the pin')
  assert.equal(all.archived_count, 2)
  assert.equal(all.include_archived, true)

  const capped = await (await fetch(base + '/api/sessions?include_archived=1&archived_limit=1', { headers: { cookie } })).json()
  assert.equal(capped.sessions.length, 2)
  assert.equal(capped.sessions.filter(row => row.archived).length, 1)
  assert.equal(capped.archived_limit, 1)
  assert.equal(capped.archived_count, 2, 'the limit caps rows, not the reported count')

  const spelling = await (await fetch(base + '/api/sessions?include_archived=true', { headers: { cookie } })).json()
  assert.equal(spelling.include_archived, true, 'the flag accepts true as well as 1')

  const detail = await (await fetch(base + '/api/session?session_id=sess-archived&messages=1', { headers: { cookie } })).json()
  assert.equal(detail.session.archived, true)
  assert.equal(detail.session.pinned, false)

  await postJson(base, cookie, '/api/session/archive', { session_id: 'sess-archived', archived: false })
  const restored = await (await fetch(base + '/api/sessions', { headers: { cookie } })).json()
  assert.equal(restored.sessions.some(row => row.session_id === 'sess-archived'), true)
  assert.equal(restored.archived_count, 1)
})

test('GET /api/session/export downloads the transcript in the requested format', async t => {
  const { facade, host, base, password } = await boot()
  t.after(() => facade.close())
  host.seed('sess-export', transcriptEvents(3))
  const cookie = await signIn(base, password)

  const jsonRes = await fetch(base + '/api/session/export?session_id=sess-export&format=json', { headers: { cookie } })
  assert.equal(jsonRes.status, 200)
  assert.match(jsonRes.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal(
    jsonRes.headers.get('content-disposition'),
    'attachment; filename="hermes-sess-export.json"',
  )
  const dump = await jsonRes.json()
  assert.equal(dump.session_id, 'sess-export')
  assert.equal(dump.messages.length, 3)
  assert.equal(dump.input_tokens, 1234)
  assert.equal(dump.output_tokens, 56)
  assert.equal(dump.context_length, 200000)
  assert.equal(dump.last_prompt_tokens, 4321)
  assert.deepEqual(dump.messages.map(message => message.content), ['u0', 'a1', 'u2'])

  // Same mapping as the open chat, not a second rendering of the transcript.
  const detail = await (await fetch(base + '/api/session?session_id=sess-export&messages=1', { headers: { cookie } })).json()
  assert.deepEqual(dump.messages, detail.session.messages)

  const htmlRes = await fetch(base + '/api/session/export?session_id=sess-export&format=html', { headers: { cookie } })
  assert.equal(htmlRes.status, 200)
  assert.match(htmlRes.headers.get('content-type') ?? '', /^text\/html/)
  assert.match(htmlRes.headers.get('content-disposition') ?? '', /filename="hermes-sess-export\.html"/)
  const html = await htmlRes.text()
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /u0/)
  assert.match(html, /a1/)

  const markdownRes = await fetch(base + '/api/session/export?session_id=sess-export&format=markdown', { headers: { cookie } })
  assert.equal(markdownRes.status, 200)
  assert.match(markdownRes.headers.get('content-type') ?? '', /^text\/markdown/)
  assert.match(await markdownRes.text(), /^## Me$/m)

  const defaultRes = await fetch(base + '/api/session/export?session_id=sess-export', { headers: { cookie } })
  assert.match(defaultRes.headers.get('content-type') ?? '', /^application\/json/, 'JSON is the default per the client contract')

  const missing = await fetch(base + '/api/session/export', { headers: { cookie } })
  assert.equal(missing.status, 400)
  const badFormat = await fetch(base + '/api/session/export?session_id=sess-export&format=pdf', { headers: { cookie } })
  assert.equal(badFormat.status, 400)
  assert.match(JSON.stringify(await badFormat.json()), /unsupported format/)
  const unknown = await fetch(base + '/api/session/export?session_id=no-such-session', { headers: { cookie } })
  assert.equal(unknown.status, 404)
})

test('models/live overlays the catalog and providers derives from it', async t => {
  const { facade, base, password } = await boot()
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  const liveRes = await fetch(base + '/api/models/live', { headers: { cookie } })
  assert.equal(liveRes.status, 200)
  const live = await liveRes.json()
  assert.equal(live.provider, 'deepseek-official', 'the app matches the live list against a catalog group by provider id')
  assert.equal(live.count, 1)
  assert.deepEqual(live.models, [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }])

  const requested = await (await fetch(base + '/api/models/live?provider=deepseek-official', { headers: { cookie } })).json()
  assert.equal(requested.provider, 'deepseek-official')
  assert.equal(requested.count, 1)

  const unknown = await (await fetch(base + '/api/models/live?provider=missing', { headers: { cookie } })).json()
  assert.equal(unknown.provider, 'missing')
  assert.deepEqual(unknown.models, [])
  assert.equal(unknown.count, 0)

  const providersRes = await fetch(base + '/api/providers', { headers: { cookie } })
  assert.equal(providersRes.status, 200)
  const providers = await providersRes.json()
  assert.equal(providers.active_provider, 'deepseek-official')
  const deepseek = providers.providers.find(provider => provider.id === 'deepseek-official')
  assert.equal(deepseek.display_name, 'DeepSeek')
  assert.equal(deepseek.has_key, true)
  assert.equal(deepseek.key_source, 'config')
  assert.equal(deepseek.models_total, 1)
  assert.deepEqual(deepseek.models, [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }])
  // A provider the catalog could not list is reported with its own error.
  const failed = providers.providers.find(provider => provider.id === 'unconfigured-provider')
  assert.equal(failed.has_key, false)
  assert.equal(failed.auth_error, 'no API key configured')
  assert.deepEqual(failed.models, [])
})

test('finished stream journals are pruned as the next turn finishes', async t => {
  const { facade, base, password } = await boot({ config: { streamRetainMs: 60_000 } })
  t.after(() => facade.close())
  const cookie = await signIn(base, password)

  /**
   * Run one turn to completion and return its stream id.
   * @param {string} message user text.
   * @returns {Promise<string>} stream id.
   */
  const turn = async message => {
    const start = await postJson(base, cookie, '/api/chat/start', { session_id: 'sess-mock', message })
    assert.equal(start.status, 200)
    const started = await start.json()
    const stream = await fetch(base + '/api/chat/stream?stream_id=' + started.stream_id, { headers: { cookie } })
    assert.match(await stream.text(), /event: stream_end/)
    return started.stream_id
  }

  const firstId = await turn('first')
  const first = facade.registry.get(firstId)
  assert.ok(first, 'a just-finished stream stays replayable for the client reconnect')
  assert.equal(first.terminal, 'completed')
  assert.equal(typeof first.finishedAt, 'number')
  // Age it past the configured replay window without waiting.
  first.finishedAt = Date.now() - 120_000

  const secondId = await turn('second')
  assert.equal(facade.registry.get(firstId), undefined, 'the stale journal was pruned when the next stream finished')
  assert.ok(facade.registry.get(secondId), 'the new journal is retained')
})

test('a resolved approval also clears the card on the live chat stream', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-facade-chat-approval-'))
  const host = createMockHost()
  // Hold the turn open: an approval happens mid-turn, so the chat stream is
  // still attached when it resolves and the clear must reach it too.
  host.prompt = async () => ({ accepted: true })
  host.follow = () => (async function* hold() {
    // No timer: the pending promise holds the stream open without keeping the
    // test process alive.
    await new Promise(() => {})
  })()
  const config = { enabled: true, port: 0, bindHost: '127.0.0.1', dir, tokenTtlSeconds: 3600, logRequests: false }
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  const base = 'http://127.0.0.1:' + address.port
  t.after(() => facade.close())
  const cookie = await signIn(base, facade.auth.generatedPassword)

  const started = await (await fetch(base + '/api/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ session_id: 'sess-mock', message: 'run it' }),
  })).json()
  const sse = await openSse(base + '/api/chat/stream?stream_id=' + started.stream_id, cookie)
  t.after(() => sse.close())

  host.simulateApproval('sess-mock')
  const live = await sse.nextEvent()
  assert.equal(live.event, 'approval')
  assert.equal(JSON.parse(live.data).pending.command, 'bash')

  host.simulatePromptResolved('sess-mock')
  const retracted = await sse.nextEvent()
  assert.equal(retracted.event, 'approval')
  assert.deepEqual(JSON.parse(retracted.data), { pending: null, pending_count: 0 })
})
