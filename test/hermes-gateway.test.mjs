import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFacadeServer } from '../src/server.mjs'
import { createGatewayServer } from '../src/hermes/server.mjs'
import { createMockHost } from '../scripts/standalone.mjs'

/**
 * Boot the facade and the gateway on ephemeral ports.
 * @returns {Promise<object>} harness.
 */
async function boot({ hostCwd } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-'))
  const host = hostCwd === undefined ? createMockHost() : createMockHost({ cwd: hostCwd })
  const config = {
    enabled: true,
    port: 0,
    bindHost: '127.0.0.1',
    dir,
    tokenTtlSeconds: 3600,
    logRequests: false,
    gatewayEnabled: true,
    gatewayPort: 0,
    gatewayBindHost: '127.0.0.1',
    internalToken: 'test-internal-token-0123456789abcdef',
    historyWindow: 800,
    historyPage: 200,
  }
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  const gateway = createGatewayServer({
    config,
    facadeUrl: 'http://127.0.0.1:' + address.port,
    facadeAuth: facade.auth,
  })
  const gatewayAddress = await gateway.listen()
  return {
    host,
    facade,
    gateway,
    dir,
    base: 'http://127.0.0.1:' + gatewayAddress.port,
    password: facade.auth.generatedPassword,
  }
}

/**
 * One request against the gateway.
 * @param {string} base base url.
 * @param {string} path path.
 * @param {object} [options] options.
 * @returns {Promise<{status: number, json: any, headers: Headers}>} reply.
 */
async function api(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.headers ?? {}),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json
  try { json = text.length > 0 ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, json, text, headers: response.headers }
}

/**
 * Sign in and return the cookie header.
 * @param {string} base base url.
 * @param {string} password password.
 * @returns {Promise<string>} cookie header.
 */
async function signIn(base, password) {
  const reply = await api(base, '/auth/password-login', { method: 'POST', body: { provider: 'basic', username: 'dsh', password } })
  assert.equal(reply.status, 200, 'login must succeed')
  const cookies = reply.headers.getSetCookie()
  assert.ok(cookies.length >= 1, 'login must set a cookie')
  return cookies.map(cookie => cookie.split(';')[0]).join('; ')
}

/**
 * Open the socket and collect frames.
 * @param {string} base base url.
 * @param {string} cookie cookie header.
 * @param {object} [options] options.
 * @param {boolean} [options.advertise] send client.capabilities (as the app does).
 * @returns {Promise<object>} socket harness.
 */
async function openSocket(base, cookie, { advertise = true } = {}) {
  const ticketReply = await api(base, '/api/auth/ws-ticket', { method: 'POST', cookie, body: {} })
  assert.equal(ticketReply.status, 200)
  const ticket = ticketReply.json.ticket
  assert.ok(typeof ticket === 'string' && ticket.length > 0)
  const url = base.replace('http://', 'ws://') + '/api/ws'
  const ws = new WebSocket(url, ['hermes-gateway-v1', 'hermes-gateway-ticket.' + ticket])
  const frames = []
  const waiters = []
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data)
    frames.push(value)
    for (const waiter of [...waiters]) {
      if (waiter.test(value) !== true) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(value)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  /**
   * Wait for the first frame matching a predicate, including already-received ones.
   * @param {(frame: object) => boolean} predicate test.
   * @param {number} [timeoutMs] deadline.
   * @returns {Promise<object>} frame.
   */
  function waitFor(predicate, timeoutMs = 5000) {
    const seen = frames.find(frame => predicate(frame))
    if (seen !== undefined) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const waiter = { test: predicate, resolve: value => { clearTimeout(timer); resolve(value) } }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error('timed out waiting for a frame; saw: ' + JSON.stringify(frames)))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }
  // The stock client advertises server-request support immediately after
  // gateway.ready; reverse requests are only delivered to a socket that did.
  if (advertise) {
    const identify = 'caps-' + Math.random().toString(36).slice(2, 8)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: identify, method: 'client.capabilities', params: { server_requests: true } }))
    await waitFor(frame => frame.id === identify)
  }
  /**
   * Send one JSON-RPC request.
   * @param {string} method method.
   * @param {object} params params.
   * @returns {Promise<object>} reply frame.
   */
  async function call(method, params = {}) {
    const id = 'test-' + Math.random().toString(36).slice(2, 8)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return waitFor(frame => frame.id === id)
  }
  return { ws, frames, waitFor, call }
}

test('status document, password login and session cookies', async () => {
  const harness = await boot()
  try {
    const status = await api(harness.base, '/api/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.version, '0.22.5')
    assert.equal(status.json.auth_required, true)
    assert.deepEqual(status.json.auth_providers, ['basic'])
    assert.ok(String(status.json.install_id).length >= 8)
    assert.equal(status.json.session_authority, undefined)

    const unauthorized = await api(harness.base, '/api/auth/me')
    assert.equal(unauthorized.status, 401)

    const cookie = await signIn(harness.base, harness.password)
    const me = await api(harness.base, '/api/auth/me', { cookie })
    assert.equal(me.status, 200)
    assert.equal(me.json.provider, 'basic')
    assert.ok(me.json.expires_at > Math.floor(Date.now() / 1000))
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('websocket handshake, capabilities and session list', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      const ready = await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      assert.ok(String(ready.params.payload.replay_epoch).length > 0)
      assert.notEqual(ready.params.payload.session_authority, true)

      const capabilities = await socket.call('client.capabilities', { server_requests: true })
      assert.equal(capabilities.result.ok, true)

      const list = await socket.call('session.list', { profile: 'default' })
      assert.equal(list.result.sessions[0].id, 'sess-mock')

      const missing = await socket.call('insights.get', {})
      assert.equal(missing.error.code, -32601)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('sessions REST: list, row, messages and rename', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const listing = await api(harness.base, '/api/sessions?profile=default&order=recent&archived=exclude&limit=20&offset=0', { cookie })
    assert.equal(listing.status, 200)
    assert.equal(listing.json.sessions[0].id, 'sess-mock')
    assert.equal(listing.json.sessions[0].source, 'gui')

    const row = await api(harness.base, '/api/sessions/sess-mock', { cookie })
    assert.equal(row.status, 200)
    assert.equal(row.json.id, 'sess-mock')

    const messages = await api(harness.base, '/api/sessions/sess-mock/messages?profile=default&order=latest&limit=50&offset=0', { cookie })
    assert.equal(messages.status, 200)
    assert.equal(messages.json.session_id, 'sess-mock')
    assert.ok(Array.isArray(messages.json.messages))

    // The phone reads the mutation snapshot before every write and answers it
    // with expected_revision; a route that 404s makes rename/pin/archive fail.
    const snapshot = await api(harness.base, '/api/sessions/sess-mock/mutation-snapshot', { cookie })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.json.session_id, 'sess-mock')
    assert.equal(snapshot.json.exists, true)
    assert.ok(Number.isInteger(snapshot.json.runtime_revision) && snapshot.json.runtime_revision >= 0)

    const renamed = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', title: 'Renamed by test', request_id: 'r-1', expected_revision: snapshot.json.runtime_revision },
    })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.json.title, 'Renamed by test')

    // A write that read an older revision is refused with the host's wording, so
    // the phone says the session changed instead of overwriting another device.
    const stale = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', title: 'Stale', request_id: 'r-2', expected_revision: snapshot.json.runtime_revision - 1 },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.detail, 'revision_conflict')

    // Half an identity is the host's separate refusal.
    const half = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', title: 'Half', request_id: 'r-3' },
    })
    assert.equal(half.status, 409)
    assert.equal(half.json.detail, 'mutation_identity_required')

    // A client from before the fence writes bare, as it always could.
    const bare = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', title: 'Bare write' },
    })
    assert.equal(bare.status, 200)
    assert.equal(bare.json.title, 'Bare write')

    const unknown = await api(harness.base, '/api/sessions/no-such-session/mutation-snapshot', { cookie })
    assert.equal(unknown.status, 200)
    assert.equal(unknown.json.exists, false)

    // DSH has no unread flag; a 200 would clear the phone's badge for nothing.
    const unread = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', unread: true },
    })
    assert.equal(unread.status, 400)
    assert.match(unread.json.detail, /unread/i)
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('prompt.submit streams a completed turn', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('session.create', { profile: 'default' })
      const submitted = await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'hello there' })
      // The client maps "streaming"/"queued" to a started/queued turn; anything
      // else rolls the optimistic message back into the composer.
      assert.equal(submitted.result.status, 'streaming')

      await socket.waitFor(frame => frame.params?.type === 'message.start')
      const delta = await socket.waitFor(frame => frame.params?.type === 'message.delta')
      assert.ok(delta.params.payload.text.length > 0)
      const complete = await socket.waitFor(frame => frame.params?.type === 'message.complete')
      assert.equal(complete.params.payload.status, 'complete')
      assert.ok(complete.params.payload.text.startsWith('Echo: hello there'))
      const info = await socket.waitFor(frame => frame.params?.type === 'session.info' && frame.params.payload.running === false)
      assert.equal(info.params.payload.running, false)

      // The transcript the client reads after reattaching carries the turn.
      const messages = await api(harness.base, '/api/sessions/sess-mock/messages?profile=default&order=latest&limit=50&offset=0', { cookie })
      // The mock stream never persists assistant rows; the user row proves the
      // transcript mapping works end to end.
      assert.deepEqual(messages.json.messages.map(message => message.role), ['user'])
      assert.equal(messages.json.messages[0].content, 'hello there')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('an approval arrives as a reverse request and is answered', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(600)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'run the tests' })
      await socket.waitFor(frame => frame.params?.type === 'message.start')

      const pending = harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'Run npm test' })
      const request = await socket.waitFor(frame => frame.method === 'approval')
      assert.equal(request.params.session_id, 'sess-mock')
      assert.equal(request.params.request_id, pending.approval_id)
      assert.deepEqual(request.params.choices, ['once', 'session', 'always', 'deny'])
      assert.equal(request.params.command, 'bash')

      const answered = await socket.call('approval.respond', {
        session_id: 'sess-mock',
        request_id: pending.approval_id,
        choice: 'once',
      })
      assert.equal(answered.result.resolved, 1)
      await socket.waitFor(frame => frame.params?.type === 'message.complete')
      assert.equal(harness.host.lastApprovalOutcome, 'allowed-once')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('an open approval survives a reconnect and is listed in open_requests', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(2500)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const first = await openSocket(harness.base, cookie)
    let pending
    try {
      await first.waitFor(frame => frame.params?.type === 'gateway.ready')
      await first.call('prompt.submit', { session_id: 'sess-mock', text: 'hold the turn' })
      await first.waitFor(frame => frame.params?.type === 'message.start')
      pending = harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'waiting' })
      await first.waitFor(frame => frame.method === 'approval')
    } finally {
      first.ws.close()
    }
    await new Promise(resolve => setTimeout(resolve, 80))

    const second = await openSocket(harness.base, cookie)
    try {
      await second.waitFor(frame => frame.params?.type === 'gateway.ready')
      const resumed = await second.call('session.resume', {
        session_id: 'sess-mock', profile: 'default', omit_messages: true,
      })
      const open = resumed.result.open_requests
      assert.equal(open.length, 1)
      assert.equal(open[0].method, 'approval')
      assert.equal(open[0].params.request_id, pending.approval_id)

      const replay = await second.call('session.events.since', { session_id: 'sess-mock', last_seen: 0 })
      assert.deepEqual(replay.result.open_requests.map(row => row.id), open.map(row => row.id))

      const answered = await second.call('approval.respond', {
        session_id: 'sess-mock', request_id: pending.approval_id, choice: 'once',
      })
      assert.equal(answered.result.resolved, 1)
      // The answer settles our pending request; the runner then posts it to the
      // facade, so give that round trip a moment.
      const deadline = Date.now() + 3000
      while (harness.host.lastApprovalOutcome !== 'allowed-once' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(harness.host.lastApprovalOutcome, 'allowed-once')
    } finally {
      second.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a request raised with no socket is registered and replayed on attach', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(2500)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'away' })
      await socket.waitFor(frame => frame.params?.type === 'message.start')
    } finally {
      socket.ws.close()
    }
    // No socket is connected here; the host asks anyway.
    harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'no phone' })
    await new Promise(resolve => setTimeout(resolve, 80))

    const again = await openSocket(harness.base, cookie)
    try {
      const resumed = await again.call('session.resume', { session_id: 'sess-mock', profile: 'default', omit_messages: true })
      assert.equal(resumed.result.open_requests.length, 1)
      assert.equal(resumed.result.open_requests[0].method, 'approval')
    } finally {
      again.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('interrupt withdraws an open request with the host frame shape', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(4000)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'stop me' })
      await socket.waitFor(frame => frame.params?.type === 'message.start')
      const pending = harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'stop me' })
      const card = await socket.waitFor(frame => frame.method === 'approval')

      const interrupted = await socket.call('session.interrupt', { session_id: 'sess-mock' })
      assert.equal(interrupted.result.interrupted, true)
      assert.equal(interrupted.result.status, 'interrupted', 'the contract vocabulary, not "ok"')

      const cancel = await socket.waitFor(frame => frame.params?.type === 'request.cancel')
      assert.equal(cancel.params.payload.id, card.id)
      assert.equal(cancel.params.payload.method, 'approval')
      assert.equal(cancel.params.payload.reason, 'interrupted')

      const settled = await socket.waitFor(frame =>
        frame.params?.type === 'session.info' && frame.params.payload.running === false)
      assert.equal(settled.params.payload.running, false)

      const late = await socket.call('approval.respond', {
        session_id: 'sess-mock', request_id: pending.approval_id, choice: 'once',
      })
      assert.equal(late.result.resolved, 0)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})


test('a failed bind releases the listeners already bound', async () => {
  const { createServer } = await import('node:http')
  const probe = createServer()
  const freePort = await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port))
  })
  await new Promise(resolve => probe.close(resolve))

  const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-bind-'))
  const config = {
    enabled: true,
    port: 0,
    bindHost: '127.0.0.1',
    dir,
    tokenTtlSeconds: 3600,
    logRequests: false,
    gatewayEnabled: true,
    gatewayPort: freePort,
    gatewayBindHost: '127.0.0.1',
    // TEST-NET-1 is not an address of this machine, so the second bind fails.
    gatewayLanHost: '192.0.2.1',
    internalToken: 'test-internal-token-0123456789abcdef',
    historyWindow: 800,
    historyPage: 200,
  }
  const gateway = createGatewayServer({
    config,
    facadeUrl: 'http://127.0.0.1:1',
    facadeAuth: {
      verifyCookie: () => false,
      verifyPassword: () => false,
      issueCookie: () => 'test-cookie',
    },
    logger: { info: () => {}, warn: () => {} },
  })
  await assert.rejects(gateway.listen(), /EADDRNOTAVAIL|EADDRINUSE|ENOTFOUND|EINVAL/)
  // The loopback listener from the successful first bind must be gone.
  const rebind = createServer()
  await new Promise((resolve, reject) => {
    rebind.once('error', reject)
    rebind.listen(freePort, '127.0.0.1', resolve)
  })
  await new Promise(resolve => rebind.close(resolve))
  await gateway.close()
})


test('projects.tree lists the DSH workspaces with their sessions', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const tree = await socket.call('projects.tree', { profile: 'default' })
      assert.equal(tree.result.projects.length, 1)
      assert.equal(tree.result.projects[0].id, 'ws-mock')
      assert.equal(tree.result.projects[0].label, 'mock workspace')
      assert.deepEqual(tree.result.projects[0].sessionIds, ['sess-mock'])
      assert.equal(tree.result.projects[0].isAuto, false)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('config.set applies a model and an effort and echoes the host fields', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')

      const model = await socket.call('config.set', {
        session_id: 'sess-mock',
        profile: 'default',
        scope: 'session',
        key: 'model',
        value: 'deepseek-v4-pro --provider deepseek-official --session',
        confirm_expensive_model: false,
      })
      assert.equal(model.result.ok, true)
      assert.equal(model.result.key, 'model')
      assert.equal(model.result.scope, 'session')
      assert.equal(model.result.value, 'deepseek-v4-pro --provider deepseek-official --session')
      assert.equal(model.result.confirm_required, false)

      const effort = await socket.call('config.set', {
        session_id: 'sess-mock',
        profile: 'default',
        scope: 'session',
        key: 'reasoning',
        value: 'high',
      })
      assert.equal(effort.result.key, 'reasoning')
      assert.equal(effort.result.value, 'high')

      // The picker's state is restored from the resume snapshot.
      const resumed = await socket.call('session.resume', { session_id: 'sess-mock', profile: 'default', omit_messages: true })
      assert.equal(resumed.result.info.reasoning_effort, 'high')

      // Fast and yolo are not DSH settings. A 200 that echoes them made the phone
      // show a state the host never stored; a key-level refusal lets the control
      // revert and keeps config.set itself available.
      const yolo = await socket.call('config.set', { session_id: 'sess-mock', key: 'yolo', value: 'on' })
      assert.equal(yolo.error.code, -32000)
      const fast = await socket.call('config.set', { session_id: 'sess-mock', key: 'fast', value: 'on' })
      assert.equal(fast.error.code, -32000)

      // A key DSH cannot write fails alone; -32601 would mark config.set itself
      // unavailable and take the model/effort/Fast controls with it.
      const refused = await socket.call('config.set', { session_id: 'sess-mock', key: 'personality', value: 'x' })
      assert.equal(refused.error.code, -32000)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})


test('transcript pages carry the host row id and keep it stable across pages', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(5)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      for (const text of ['one', 'two', 'three']) {
        const sent = await socket.call('prompt.submit', { session_id: 'sess-mock', text })
        assert.equal(sent.result.status, 'streaming')
        await socket.waitFor(frame =>
          frame.params?.type === 'message.complete' && String(frame.params.payload.text).includes('Echo: ' + text))
      }
    } finally {
      socket.ws.close()
    }
    const newest = await api(harness.base, '/api/sessions/sess-mock/messages?order=latest&limit=2&offset=0', { cookie })
    const older = await api(harness.base, '/api/sessions/sess-mock/messages?limit=2&offset=2&order=latest', { cookie })
    assert.ok(newest.json.messages.every(row => Number.isInteger(row.id)), 'every row needs the host id')
    assert.deepEqual(newest.json.messages.map(row => row.id), [2, 3])
    assert.deepEqual(older.json.messages.map(row => row.id), [1])
    assert.equal(newest.json.messages[0].content, 'two')
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})


test('a submit while a turn runs is queued and starts one turn at a time', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(250)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const first = await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'first' })
      assert.equal(first.result.status, 'streaming')
      const second = await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'second' })
      assert.equal(second.result.status, 'queued')

      const firstComplete = await socket.waitFor(frame =>
        frame.params?.type === 'message.complete' && String(frame.params.payload.text).includes('Echo: first'), 5000)
      assert.ok(firstComplete)

      const secondComplete = await socket.waitFor(frame =>
        frame.params?.type === 'message.complete' && String(frame.params.payload.text).includes('Echo: second'), 5000)
      assert.ok(secondComplete)

      const starts = socket.frames.filter(frame => frame.params?.type === 'message.start')
      assert.equal(starts.length, 2, 'one start per turn, never a second stream for the same turn')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('session.steer answers the queued/rejected vocabulary', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(400)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'busy' })
      const steered = await socket.call('session.steer', { session_id: 'sess-mock', text: 'guide it' })
      assert.equal(steered.result.status, 'queued')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})


test('a new chat moves folder before its first message, and is created there', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(5)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default' })
      const draftId = created.result.session_id
      assert.match(draftId, /^dsh-draft-/)

      // The attach a new chat performs has to answer for a session that does not exist yet,
      // and the composer's chips start populated from the host's defaults.
      const resumed = await socket.call('session.resume', { session_id: draftId, profile: 'default', omit_messages: true })
      assert.equal(resumed.result.session_id, draftId)
      assert.equal(resumed.result.info.running, false)
      assert.equal(resumed.result.info.cwd, process.cwd(), 'a new chat starts in DSH current workspace')
      assert.ok(resumed.result.info.model, 'the model chip has a value')
      assert.ok(resumed.result.info.reasoning_effort, 'the effort chip has a value')

      // Picks made before the first message are recorded on the draft, never sent
      // to a session that does not exist.
      const effort = await socket.call('config.set', {
        session_id: draftId, profile: 'default', scope: 'session', key: 'reasoning', value: 'medium',
      })
      assert.equal(effort.result.value, 'medium')
      const model = await socket.call('config.set', {
        session_id: draftId, profile: 'default', scope: 'session', key: 'model',
        value: 'deepseek-v4-pro --provider deepseek-official --session',
      })
      assert.equal(model.result.key, 'model')

      const moved = await socket.call('session.workspace.move', {
        profile: 'default', session_key: draftId, cwd: '/tmp',
      })
      assert.equal(moved.result.cwd, '/tmp')
      await socket.call('session.title', { session_id: draftId, title: 'moved chat' })

      const submitted = await socket.call('prompt.submit', { session_id: draftId, text: 'hello there' })
      assert.equal(submitted.result.status, 'streaming')
      // The DSH session is created at the chosen folder, and the frames the phone
      // sees still carry the id it holds.
      assert.equal(harness.host.lastEnsure.workspacePath, '/tmp')
      const delta = await socket.waitFor(frame => frame.params?.type === 'message.delta')
      assert.equal(delta.params.session_id, draftId)
      await socket.waitFor(frame => frame.params?.type === 'message.complete')

      // The draft's effort was applied to the real session before the turn.
      const promoted = await socket.call('session.resume', { session_id: draftId, profile: 'default', omit_messages: true })
      assert.equal(promoted.result.info.reasoning_effort, 'medium')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('moving a chat that already ran is refused instead of silently reverting', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const moved = await socket.call('session.workspace.move', {
        profile: 'default', session_key: 'sess-mock', cwd: '/tmp/some-project',
      })
      assert.equal(moved.error.code, -32000)
      assert.match(String(moved.error.message), /cannot change a session's folder/i)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})


test('session.title renames a real session through the facade', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const renamed = await socket.call('session.title', { session_id: 'sess-mock', title: 'Renamed by socket' })
      assert.equal(renamed.result.title, 'Renamed by socket')
      const resumed = await socket.call('session.resume', { session_id: 'sess-mock', profile: 'default', omit_messages: true })
      assert.equal(resumed.result.info.title, 'Renamed by socket')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a promoted draft still takes model writes under its draft id', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(5)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default' })
      const draftId = created.result.session_id
      await socket.call('prompt.submit', { session_id: draftId, text: 'promote me' })
      await socket.waitFor(frame => frame.params?.type === 'message.complete')

      const changed = await socket.call('config.set', {
        session_id: draftId, profile: 'default', scope: 'session', key: 'model',
        value: 'deepseek-v4-pro --provider deepseek-official --session',
      })
      assert.equal(changed.result.key, 'model')

      const refused = await socket.call('config.set', {
        session_id: draftId, profile: 'default', scope: 'session', key: 'model',
        value: 'no-such-model --provider deepseek-official --session',
      })
      assert.equal(refused.error.code, -32000, 'the write reaches the real session')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a draft mapping survives a gateway restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-restart-'))
  const host = createMockHost()
  host.setTurnDelay(5)
  const config = {
    enabled: true,
    port: 0,
    bindHost: '127.0.0.1',
    dir,
    tokenTtlSeconds: 3600,
    logRequests: false,
    gatewayEnabled: true,
    gatewayPort: 0,
    gatewayBindHost: '127.0.0.1',
    internalToken: 'restart-internal-token-0123456789abcdef',
    historyWindow: 800,
    historyPage: 200,
  }
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  const openGateway = async () => {
    const gateway = createGatewayServer({
      config,
      facadeUrl: 'http://127.0.0.1:' + address.port,
      facadeAuth: facade.auth,
    })
    const bound = await gateway.listen()
    return { gateway, base: 'http://127.0.0.1:' + bound.port }
  }
  try {
    const first = await openGateway()
    const cookie = await signIn(first.base, facade.auth.generatedPassword)
    const socket = await openSocket(first.base, cookie)
    let draftId
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default' })
      draftId = created.result.session_id
      await socket.call('prompt.submit', { session_id: draftId, text: 'persist me' })
      await socket.waitFor(frame => frame.params?.type === 'message.complete')
    } finally {
      socket.ws.close()
    }
    await first.gateway.close()

    const second = await openGateway()
    const revived = await openSocket(second.base, cookie)
    try {
      const resumed = await revived.call('session.resume', { session_id: draftId, profile: 'default', omit_messages: true })
      assert.equal(resumed.result.session_id, draftId, 'the draft id still resolves after a restart')
      assert.equal(resumed.result.info.running, false)
    } finally {
      revived.ws.close()
      await second.gateway.close()
    }
  } finally {
    await facade.close()
  }
})

test('session.title reads the title when none is sent', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const renamed = await socket.call('session.title', { session_id: 'sess-mock', title: 'Read me back' })
      assert.equal(renamed.result.title, 'Read me back')
      // The contract's read form: no title asks for the current one.
      const read = await socket.call('session.title', { session_id: 'sess-mock' })
      assert.equal(read.result.title, 'Read me back')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('session.list carries the row fields the list decodes', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      const listed = await socket.call('session.list', {})
      const row = listed.result.sessions.find(entry => entry.id === 'sess-mock')
      assert.ok(row, 'the mock session is listed under its id')
      assert.equal(row.resolved_id, null)
      assert.equal(row.title, 'Mock session')
      assert.equal(row.source, 'gui')
      assert.equal(row.pinned, false)
      assert.equal(row.archived, false)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('session.info falls back to the catalog default when the session names no model', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      // sess-mock has never picked a model, so its row has no modelSelection
      // projection. Before the fallback this emitted session.info with no model
      // and the composer's chip went blank.
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'model please' })
      const info = await socket.waitFor(frame =>
        frame.params?.type === 'session.info' && frame.params.payload.running === true)
      assert.equal(info.params.payload.model, 'deepseek-v4-pro')
      assert.equal(info.params.payload.provider, 'deepseek-official')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('PATCH applies every field it names', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const snapshot = await api(harness.base, '/api/sessions/sess-mock/mutation-snapshot', { cookie })
    const patched = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: {
        profile: 'default',
        title: 'Both fields',
        pinned: true,
        request_id: 'r-both',
        expected_revision: snapshot.json.runtime_revision,
      },
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.json.title, 'Both fields')
    assert.equal(patched.json.pinned, true)
    const listing = await api(harness.base, '/api/sessions?profile=default&limit=20', { cookie })
    const row = listing.json.sessions.find(entry => entry.id === 'sess-mock')
    assert.equal(row.title, 'Both fields')
    assert.equal(row.pinned, true)
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('the REST list honours limit=0 and exact source names', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    // 0 is a legal page size; the old parse turned it into the 20-row default.
    const zero = await api(harness.base, '/api/sessions?profile=default&limit=0', { cookie })
    assert.equal(zero.status, 200)
    assert.equal(zero.json.limit, 0)
    assert.deepEqual(zero.json.sessions, [])
    // `sources` is a CSV of names; only an exact "cron" means "no cron rows".
    const notCron = await api(harness.base, '/api/sessions?profile=default&sources=cronx', { cookie })
    assert.ok(notCron.json.sessions.length >= 1)
    const cron = await api(harness.base, '/api/sessions?profile=default&sources=cron', { cookie })
    assert.equal(cron.json.total, 0)
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('unimplemented session collections answer a plain 404', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const search = await api(harness.base, '/api/sessions/search?q=x', { cookie })
    assert.equal(search.status, 404)
    // Not the row regex's "Session not found" for a session named "search".
    assert.equal(search.json.detail, 'Not Found')
    const stats = await api(harness.base, '/api/sessions/stats', { cookie })
    assert.equal(stats.status, 404)
    assert.equal(stats.json.detail, 'Not Found')
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('an empty prompt is refused before the draft is promoted', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default' })
      const draftId = created.result.session_id
      const refused = await socket.call('prompt.submit', { session_id: draftId, text: '   ' })
      assert.equal(refused.error.code, -32602)
      // The draft still has no messages and still starts a real turn afterwards.
      const resumed = await socket.call('session.resume', { session_id: draftId, profile: 'default', omit_messages: true })
      assert.equal(resumed.result.message_count, 0)
      const sent = await socket.call('prompt.submit', { session_id: draftId, text: 'after the refusal' })
      assert.equal(sent.result.status, 'streaming')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a socket that never advertised server requests gets no cards', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(600)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie, { advertise: false })
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'no cards' })
      await socket.waitFor(frame => frame.params?.type === 'message.start')
      const pending = harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'silent' })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(socket.frames.some(frame => frame.method === 'approval'), false)
      // The RPC still answers it; the frame is what the capability gates.
      const answered = await socket.call('approval.respond', {
        session_id: 'sess-mock', request_id: pending.approval_id, choice: 'once',
      })
      assert.equal(answered.result.resolved, 1)
      await socket.waitFor(frame => frame.params?.type === 'message.complete')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a JSON-RPC answer to a card settles it and withdraws the frame', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(400)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'answer raw' })
      await socket.waitFor(frame => frame.params?.type === 'message.start')
      harness.host.simulateApproval('sess-mock', { command: 'bash', description: 'raw answer' })
      const card = await socket.waitFor(frame => frame.method === 'approval')
      // An older client answers the request frame itself, not approval.respond.
      socket.ws.send(JSON.stringify({ jsonrpc: '2.0', id: card.id, result: { choice: 'once' } }))
      const cancel = await socket.waitFor(frame =>
        frame.params?.type === 'request.cancel' && frame.params.payload.id === card.id)
      assert.equal(cancel.params.payload.method, 'approval')
      assert.equal(cancel.params.payload.reason, 'resolved')
      await socket.waitFor(frame => frame.params?.type === 'message.complete')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a forwarded client is rate-limited on its own address', async () => {
  const harness = await boot()
  try {
    const wrong = { provider: 'basic', username: 'dsh', password: 'not-the-password' }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await api(harness.base, '/auth/password-login', {
        method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: wrong,
      })
      assert.equal(refused.status, 401)
    }
    // That client is locked out…
    const locked = await api(harness.base, '/auth/password-login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      body: { provider: 'basic', username: 'dsh', password: harness.password },
    })
    assert.equal(locked.status, 429)
    // …but another phone behind the same tailscale serve proxy is not.
    const other = await api(harness.base, '/auth/password-login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body: { provider: 'basic', username: 'dsh', password: harness.password },
    })
    assert.equal(other.status, 200)
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('two concurrent submits on a fresh draft share one session and run in order', async () => {
  const harness = await boot()
  harness.host.setTurnDelay(150)
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default' })
      const draftId = created.result.session_id
      // Two frames in flight before either promotion resolves: they must share
      // one DSH session, not create two and orphan one message.
      const first = socket.call('prompt.submit', { session_id: draftId, text: 'first' })
      const second = socket.call('prompt.submit', { session_id: draftId, text: 'second' })
      const [one, two] = await Promise.all([first, second])
      assert.deepEqual([one.result.status, two.result.status].sort(), ['queued', 'streaming'])

      await socket.waitFor(frame =>
        frame.params?.type === 'message.complete' && String(frame.params.payload.text).includes('first'))
      await socket.waitFor(frame =>
        frame.params?.type === 'message.complete' && String(frame.params.payload.text).includes('second'))

      // The second turn starts only after the first settles.
      const sequence = socket.frames
        .filter(frame => frame.params?.session_id === draftId)
        .filter(frame => frame.params?.type === 'message.start' || frame.params?.type === 'message.complete')
        .map(frame => frame.params.type)
      assert.deepEqual(sequence, ['message.start', 'message.complete', 'message.start', 'message.complete'])

      const listing = await api(harness.base, '/api/sessions?profile=default&limit=100', { cookie })
      const promoted = listing.json.sessions.filter(row => row.id !== 'sess-mock')
      assert.equal(promoted.length, 1, 'the draft promoted exactly one DSH session')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('session.interrupt with no turn answers not_interrupted', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const idle = await socket.call('session.interrupt', { session_id: 'sess-mock' })
      assert.equal(idle.result.status, 'not_interrupted')
      assert.equal(idle.result.interrupted, false)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('a turn advances the write-fence revision', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const before = await api(harness.base, '/api/sessions/sess-mock/mutation-snapshot', { cookie })
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'advance the fence' })
      await socket.waitFor(frame =>
        frame.params?.type === 'session.info' && frame.params.payload.running === false)
      const after = await api(harness.base, '/api/sessions/sess-mock/mutation-snapshot', { cookie })
      assert.ok(after.json.runtime_revision > before.json.runtime_revision,
        'a turn must move the revision a write compares against')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('the in-chat Files surface lists, previews and downloads inside a chat folder', async () => {
  // The mock session's folder is a fixture, not process.cwd(): a checkout under
  // $DSH_HOME must still pass, because the deny list would fence it out.
  const sessionFolder = mkdtempSync(join(tmpdir(), 'hermes-session-'))
  const harness = await boot({ hostCwd: sessionFolder })
  const folder = mkdtempSync(join(tmpdir(), 'hermes-files-'))
  const outside = mkdtempSync(join(tmpdir(), 'hermes-outside-'))
  try {
    writeFileSync(join(sessionFolder, 'session-root.txt'), 'root\n')
    writeFileSync(join(folder, 'demo.md'), 'hello files\n')
    // A NUL byte makes the facade's text read answer 404: the binary tell.
    writeFileSync(join(folder, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    writeFileSync(join(folder, 'huge.log'), 'x'.repeat(512 * 1024 + 10))
    mkdirSync(join(folder, 'sub'))
    writeFileSync(join(folder, 'sub', 'deep.txt'), 'deep\n')
    writeFileSync(join(outside, 'secret.txt'), 'not yours\n')

    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      // A new chat in that folder: its draft folder is what the fence admits.
      const created = await socket.call('session.create', { profile: 'default', cwd: folder })
      assert.equal(created.result.info.terminal_backend, 'local')
      assert.equal(created.result.info.cwd, folder)

      const enc = value => encodeURIComponent(value)
      const list = await api(harness.base, '/api/fs/list?path=' + enc(folder), { cookie })
      assert.equal(list.status, 200)
      assert.deepEqual(list.json.entries.map(entry => entry.name).sort(), ['demo.md', 'huge.log', 'pic.png', 'sub'])
      assert.equal(list.json.entries.find(entry => entry.name === 'sub').isDirectory, true)
      assert.equal(list.json.entries.find(entry => entry.name === 'demo.md').isDirectory, false)

      const nested = await api(harness.base, '/api/fs/list?path=' + enc(join(folder, 'sub')), { cookie })
      assert.deepEqual(nested.json.entries.map(entry => entry.name), ['deep.txt'])

      const text = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'demo.md')), { cookie })
      assert.equal(text.status, 200)
      assert.equal(text.json.binary, false)
      assert.equal(text.json.text, 'hello files\n')
      assert.equal(text.json.byteSize, 12)
      assert.equal(text.json.language, 'md')
      assert.equal(text.json.truncated, false)

      const binary = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'pic.png')), { cookie })
      assert.equal(binary.status, 200)
      assert.equal(binary.json.binary, true)
      assert.equal(binary.json.byteSize, 6)

      // A preview returns the host's 512 KiB cap, flagged as truncated.
      const huge = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'huge.log')), { cookie })
      assert.equal(huge.status, 200)
      assert.equal(huge.json.truncated, true)
      assert.equal(Buffer.byteLength(huge.json.text), 512 * 1024)

      const missing = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'nope.txt')), { cookie })
      assert.equal(missing.status, 404)
      assert.equal(missing.json.detail, 'File not found')

      // The client maps this exact detail to its "this is a folder" error.
      const directory = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'sub')), { cookie })
      assert.equal(directory.status, 400)
      assert.equal(directory.json.detail, 'Path points to a directory')

      const raw = await fetch(harness.base + '/api/fs/download?path=' + enc(join(folder, 'demo.md')), { headers: { cookie } })
      assert.equal(raw.status, 200)
      assert.match(raw.headers.get('content-type'), /text\/plain/)
      assert.equal(await raw.text(), 'hello files\n')

      const image = await fetch(harness.base + '/api/fs/download?path=' + enc(join(folder, 'pic.png')), { headers: { cookie } })
      assert.equal(image.status, 200)
      assert.equal(image.headers.get('content-type'), 'image/png')
      assert.deepEqual([...Buffer.from(await image.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])

      // The chat folder is the boundary, and the facade's state is never served.
      const forbidden = await api(harness.base, '/api/fs/list?path=' + enc(outside), { cookie })
      assert.equal(forbidden.status, 403)
      assert.match(forbidden.json.detail, /outside the session workspace/)
      const forbiddenFile = await api(harness.base, '/api/fs/read-text?path=' + enc(join(outside, 'secret.txt')), { cookie })
      assert.equal(forbiddenFile.status, 403)
      const traversal = await api(harness.base, '/api/fs/list?path=' + enc(join(folder, '..', outside.split('/').pop())), { cookie })
      assert.equal(traversal.status, 403)

      // A symlink inside the folder cannot point out of it: the fence resolves it.
      symlinkSync(join(outside, 'secret.txt'), join(folder, 'escape.txt'))
      const linked = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'escape.txt')), { cookie })
      assert.equal(linked.status, 403)

      // Even a draft opened on the state directory cannot read it: deny wins.
      await socket.call('session.create', { profile: 'default', cwd: harness.dir })
      writeFileSync(join(harness.dir, 'probe.txt'), 'token\n')
      const stateDir = await api(harness.base, '/api/fs/read-text?path=' + enc(join(harness.dir, 'probe.txt')), { cookie })
      assert.equal(stateDir.status, 403)

      // A relative path has no session to resolve against on this route.
      const relative = await api(harness.base, '/api/fs/list?path=demo.txt', { cookie })
      assert.equal(relative.status, 400)
      assert.match(relative.json.detail, /absolute/)

      // The session's own folder is a root too, not only the draft's.
      const workspace = await api(harness.base, '/api/fs/list?path=' + enc(sessionFolder), { cookie })
      assert.equal(workspace.status, 200)
      assert.ok(workspace.json.entries.some(entry => entry.name === 'session-root.txt'))
    } finally {
      socket.ws.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(sessionFolder, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('the Files guard refuses credentials, caps large sources and resolves relative MEDIA paths', async () => {
  const sessionFolder = mkdtempSync(join(tmpdir(), 'hermes-session-'))
  const harness = await boot({ hostCwd: sessionFolder })
  const folder = mkdtempSync(join(tmpdir(), 'hermes-files-'))
  const outside = mkdtempSync(join(tmpdir(), 'hermes-outside-'))
  try {
    writeFileSync(join(folder, '.env'), 'SECRET=1\n')
    writeFileSync(join(folder, '.git-credentials'), 'https://user:pass@example.invalid\n')
    writeFileSync(join(folder, 'credentials'), '{}\n')
    writeFileSync(join(folder, 'photon-sidecar.json'), '{"token":"x"}\n')
    mkdirSync(join(folder, '.git'))
    writeFileSync(join(folder, '.git', 'config'), '[core]\n')
    mkdirSync(join(folder, 'node_modules'))
    writeFileSync(join(folder, 'node_modules', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(folder, 'mcp-tokens'))
    writeFileSync(join(folder, 'mcp-tokens', 'server.json'), '{}\n')
    mkdirSync(join(folder, '.ssh'))
    writeFileSync(join(folder, '.ssh', 'config'), 'Host *\n')
    mkdirSync(join(folder, 'media'))
    writeFileSync(join(folder, 'media', 'clip.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    // A sparse file over the 64 MiB source cap, without writing 64 MiB.
    const huge = join(folder, 'huge.bin')
    const descriptor = openSync(huge, 'w')
    ftruncateSync(descriptor, 64 * 1024 * 1024 + 1)
    closeSync(descriptor)
    writeFileSync(join(outside, 'secret.txt'), 'not yours\n')

    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const created = await socket.call('session.create', { profile: 'default', cwd: folder })
      const draftId = created.result.session_id
      const enc = value => encodeURIComponent(value)

      // The listing hides credential stores and the host's build/VCS caches.
      const list = await api(harness.base, '/api/fs/list?path=' + enc(folder), { cookie })
      assert.equal(list.status, 200)
      const names = list.json.entries.map(entry => entry.name)
      for (const hidden of ['.env', '.git-credentials', 'credentials', 'photon-sidecar.json', '.git', 'node_modules', 'mcp-tokens', '.ssh']) {
        assert.equal(names.includes(hidden), false, hidden + ' must not be listed')
      }
      assert.ok(names.includes('media'))

      // Credential material is refused wherever it sits, with the host's wording.
      for (const relative of ['.env', '.git-credentials', 'credentials', 'photon-sidecar.json', 'mcp-tokens/server.json', '.ssh/config']) {
        const denied = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, relative)), { cookie })
        assert.equal(denied.status, 403, relative)
        assert.equal(denied.json.detail, 'Access to sensitive files is not allowed')
      }
      // A hidden VCS file is still readable when asked for: only the listing hides it.
      const gitConfig = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, '.git', 'config')), { cookie })
      assert.equal(gitConfig.status, 200)

      // A directory is not a file, on either route (the client maps this detail).
      const dirRead = await api(harness.base, '/api/fs/read-text?path=' + enc(join(folder, 'media')), { cookie })
      assert.equal(dirRead.status, 400)
      assert.equal(dirRead.json.detail, 'Path points to a directory')
      const dirDownload = await api(harness.base, '/api/fs/download?path=' + enc(join(folder, 'media')), { cookie })
      assert.equal(dirDownload.status, 400)
      assert.equal(dirDownload.json.detail, 'Path points to a directory')

      // The 64 MiB source cap, on both routes, before anything is buffered.
      const hugeRead = await api(harness.base, '/api/fs/read-text?path=' + enc(huge), { cookie })
      assert.equal(hugeRead.status, 413)
      assert.equal(hugeRead.json.detail, 'File too large')
      const hugeDownload = await api(harness.base, '/api/fs/download?path=' + enc(huge), { cookie })
      assert.equal(hugeDownload.status, 413)
      assert.equal(hugeDownload.json.detail, 'File too large')

      // A relative MEDIA path resolves against the session, then the fence admits it.
      const media = await fetch(harness.base + '/api/fs/download?path=' + enc('media/clip.png') + '&session_id=' + enc(draftId), { headers: { cookie } })
      assert.equal(media.status, 200)
      assert.deepEqual([...Buffer.from(await media.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])

      // Without a session a relative path cannot resolve; attachment refs are not ours.
      const noSession = await api(harness.base, '/api/fs/download?path=' + enc('media/clip.png'), { cookie })
      assert.equal(noSession.status, 400)
      const attachment = await api(harness.base, '/api/fs/download?path=' + enc('attachment:abc') + '&session_id=' + enc(draftId), { cookie })
      assert.equal(attachment.status, 400)
      assert.equal(attachment.json.detail, 'attachment references are not supported')

      // A resolved relative path that lands outside the chat folder is fenced.
      const escape = await api(harness.base, '/api/fs/download?path=' + enc('..' + '/' + outside.split('/').pop() + '/secret.txt') + '&session_id=' + enc(draftId), { cookie })
      assert.equal(escape.status, 403)
    } finally {
      socket.ws.close()
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(sessionFolder, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('session.info names the local terminal backend the Files entry needs', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const resumed = await socket.call('session.resume', { session_id: 'sess-mock', profile: 'default', omit_messages: true })
      assert.equal(resumed.result.info.terminal_backend, 'local')
      await socket.call('prompt.submit', { session_id: 'sess-mock', text: 'files please' })
      const info = await socket.waitFor(frame =>
        frame.params?.type === 'session.info' && frame.params.payload.running === true)
      assert.equal(info.params.payload.terminal_backend, 'local')
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('the in-chat Git menu reads status, changes, diffs and branches (read-only)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hermes-git-'))
  const chatFolder = join(repo, 'project')
  mkdirSync(chatFolder)
  const identity = ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(chatFolder, 'app.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', [...identity, 'commit', '-qm', 'initial'], { cwd: repo })
  writeFileSync(join(chatFolder, 'app.txt'), 'one\ntwo\n')
  writeFileSync(join(chatFolder, 'new.txt'), 'fresh\n')
  writeFileSync(join(chatFolder, '.env'), 'SECRET=1\n')
  const notARepo = mkdtempSync(join(tmpdir(), 'hermes-norepo-'))
  const harness = await boot({ hostCwd: chatFolder })
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const enc = value => encodeURIComponent(value)
      // A chat folder inside a repository resolves the root above it.
      const created = await socket.call('session.create', { profile: 'default', cwd: chatFolder })
      assert.equal(created.result.info.terminal_backend, 'local')
      const rootReply = await api(harness.base, '/api/fs/git-root?path=' + enc(chatFolder), { cookie })
      assert.equal(rootReply.status, 200)
      const repoRoot = rootReply.json.root
      assert.equal(repoRoot, realpathSync(repo))

      const status = await api(harness.base, '/api/git/status?path=' + enc(repoRoot), { cookie })
      assert.equal(status.status, 200)
      assert.equal(status.json.branch, 'main')
      assert.equal(status.json.detached, false)
      assert.equal(status.json.untracked, 1)
      assert.deepEqual(status.json.files.map(file => file.path).sort(), ['project/app.txt', 'project/new.txt'])
      assert.equal(status.json.files.some(file => file.path.includes('.env')), false)
      assert.equal(status.json.files.find(file => file.path === 'project/new.txt').untracked, true)
      assert.equal(status.json.files.find(file => file.path === 'project/app.txt').staged, false)

      const changes = await api(harness.base, '/api/git/review/list?path=' + enc(repoRoot) + '&scope=uncommitted', { cookie })
      assert.equal(changes.status, 200)
      assert.equal(changes.json.base, null)
      assert.deepEqual(changes.json.files.map(row => row.path), ['project/app.txt', 'project/new.txt'])
      assert.equal(changes.json.files.find(row => row.path === 'project/new.txt').status, '?')
      assert.equal(changes.json.files.some(row => row.path.includes('.env')), false)

      const diff = await api(harness.base, '/api/git/review/diff?path=' + enc(repoRoot) + '&file=' + enc('project/app.txt') + '&scope=uncommitted&staged=false', { cookie })
      assert.equal(diff.status, 200)
      assert.match(diff.json.diff, /\+two/)
      const newFile = await api(harness.base, '/api/git/file-diff?path=' + enc(repoRoot) + '&file=' + enc('project/new.txt'), { cookie })
      assert.equal(newFile.status, 200)
      assert.match(newFile.json.diff, /\+fresh/)

      const branches = await api(harness.base, '/api/git/branches?path=' + enc(repoRoot), { cookie })
      assert.equal(branches.status, 200)
      const main = branches.json.branches.find(row => row.name === 'main')
      assert.equal(main.checkedOut, true)
      assert.equal(main.isDefault, true)
      assert.equal(main.isRemote, false)

      const head = await api(harness.base, '/api/git/review/rev-parse?path=' + enc(repoRoot), { cookie })
      assert.equal(head.status, 200)
      assert.match(head.json.sha, /^[0-9a-f]{40}$/)

      // A credential file is refused by the diff routes, as the Files guard does.
      const secret = await api(harness.base, '/api/git/review/diff?path=' + enc(repoRoot) + '&file=' + enc('project/.env') + '&scope=uncommitted', { cookie })
      assert.equal(secret.status, 403)
      assert.equal(secret.json.detail, 'Access to sensitive files is not allowed')

      // A path that is neither a chat folder nor the root of one is fenced.
      const outside = await api(harness.base, '/api/git/status?path=' + enc(notARepo), { cookie })
      assert.equal(outside.status, 403)
      assert.match(outside.json.detail, /outside the session workspace/)

      // A chat folder outside a repository answers the host's empty shapes.
      await socket.call('session.create', { profile: 'default', cwd: notARepo })
      const noRoot = await api(harness.base, '/api/fs/git-root?path=' + enc(notARepo), { cookie })
      assert.equal(noRoot.status, 200)
      assert.equal(noRoot.json.root, null)
      const noStatus = await api(harness.base, '/api/git/status?path=' + enc(notARepo), { cookie })
      assert.equal(noStatus.status, 200)
      assert.equal(noStatus.json, null)
      const noChanges = await api(harness.base, '/api/git/review/list?path=' + enc(notARepo) + '&scope=uncommitted', { cookie })
      assert.deepEqual(noChanges.json, { files: [], base: null })

      // Writes are refused with a reason; the menu is read-only for now.
      const stage = await api(harness.base, '/api/git/review/stage', {
        cookie, method: 'POST', body: { path: repoRoot, file: 'project/app.txt' },
      })
      assert.equal(stage.status, 400)
      assert.match(stage.json.detail, /not supported/i)
    } finally {
      socket.ws.close()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(notARepo, { recursive: true, force: true })
    await harness.gateway.close()
    await harness.facade.close()
  }
})

test('the Git surface refuses ref injection, symlink escapes and deny trees', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hermes-git-guard-'))
  const chatFolder = join(repo, 'project')
  mkdirSync(chatFolder)
  const identity = ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false']
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'unchanged\n')
  writeFileSync(join(repo, 'gone.txt'), 'deleted soon\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', [...identity, 'commit', '-qm', 'initial'], { cwd: repo })
  rmSync(join(repo, 'gone.txt'))
  // Credential trees inside a repository (the home-dotfiles case) and a link out.
  mkdirSync(join(repo, '.ssh'))
  writeFileSync(join(repo, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
  mkdirSync(join(repo, '.dsh', 'hermes-facade'), { recursive: true })
  writeFileSync(join(repo, '.dsh', 'hermes-facade', 'internal.token'), 'TOKEN\n')
  const outside = mkdtempSync(join(tmpdir(), 'hermes-git-outside-'))
  writeFileSync(join(outside, 'id_rsa'), 'OUTSIDE KEY\n')
  symlinkSync(outside, join(repo, 'harvest'))
  const harness = await boot({ hostCwd: chatFolder })
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const enc = value => encodeURIComponent(value)
      await socket.call('session.create', { profile: 'default', cwd: chatFolder })
      const rootReply = await api(harness.base, '/api/fs/git-root?path=' + enc(chatFolder), { cookie })
      const repoRoot = rootReply.json.root
      assert.equal(rootReply.status, 200)

      const status = await api(harness.base, '/api/git/status?path=' + enc(repoRoot), { cookie })
      assert.equal(status.status, 200)
      const statusPaths = status.json.files.map(file => file.path)
      assert.equal(statusPaths.some(file => file.startsWith('.ssh/')), false)
      assert.equal(statusPaths.some(file => file.startsWith('.dsh/')), false)
      assert.ok(statusPaths.includes('gone.txt'))

      const changes = await api(harness.base, '/api/git/review/list?path=' + enc(repoRoot) + '&scope=uncommitted', { cookie })
      assert.equal(changes.status, 200)
      const changePaths = changes.json.files.map(row => row.path)
      assert.equal(changePaths.some(file => file.startsWith('.ssh/')), false)
      assert.equal(changePaths.some(file => file.startsWith('.dsh/')), false)

      // Credential trees and a symlinked directory are refused for a diff.
      for (const file of ['.ssh/id_ed25519', '.dsh/hermes-facade/internal.token', 'harvest/id_rsa']) {
        const denied = await api(harness.base, '/api/git/review/diff?path=' + enc(repoRoot) + '&file=' + enc(file) + '&scope=uncommitted', { cookie })
        assert.equal(denied.status, 403, file)
        assert.equal(JSON.stringify(denied.json).includes('KEY'), false)
      }

      // An unchanged tracked file is not served as a whole-file diff.
      const unchanged = await api(harness.base, '/api/git/review/diff?path=' + enc(repoRoot) + '&file=' + enc('README.md') + '&scope=uncommitted', { cookie })
      assert.equal(unchanged.status, 200)
      assert.equal(unchanged.json.diff, '')

      // A deleted (uncommitted) row is a normal diff, not a 400.
      const deleted = await api(harness.base, '/api/git/file-diff?path=' + enc(repoRoot) + '&file=' + enc('gone.txt'), { cookie })
      assert.equal(deleted.status, 200)
      assert.match(deleted.json.diff, /gone\.txt/)

      // `base` cannot smuggle a git option (--output would write a file).
      const pwned = join(outside, 'pwned')
      const hostile = await api(harness.base, '/api/git/review/list?path=' + enc(repoRoot) + '&scope=lastTurn&base=' + enc('--output=' + pwned), { cookie })
      assert.equal(hostile.status, 400)
      assert.equal(existsSync(pwned), false)
      const hostileRef = await api(harness.base, '/api/git/review/rev-parse?path=' + enc(repoRoot) + '&ref=' + enc('--output=' + pwned), { cookie })
      assert.equal(hostileRef.status, 400)
      assert.equal(existsSync(pwned), false)
    } finally {
      socket.ws.close()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    await harness.gateway.close()
    await harness.facade.close()
  }
})





