import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-'))
  const host = createMockHost()
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
 * @returns {Promise<object>} socket harness.
 */
async function openSocket(base, cookie) {
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

    const renamed = await api(harness.base, '/api/sessions/sess-mock', {
      cookie,
      method: 'PATCH',
      body: { profile: 'default', title: 'Renamed by test', request_id: 'r-1', expected_revision: 0 },
    })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.json.title, 'Renamed by test')
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
      assert.equal(submitted.result.status, 'accepted')

      await socket.waitFor(frame => frame.params?.type === 'message.start')
      const delta = await socket.waitFor(frame => frame.params?.type === 'message.delta')
      assert.ok(delta.params.payload.text.length > 0)
      const complete = await socket.waitFor(frame => frame.params?.type === 'message.complete')
      assert.equal(complete.params.payload.status, 'completed')
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
