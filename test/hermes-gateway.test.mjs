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
      // The client maps "streaming"/"queued" to a started/queued turn; anything
      // else rolls the optimistic message back into the composer.
      assert.equal(submitted.result.status, 'streaming')

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

      const yolo = await socket.call('config.set', { session_id: 'sess-mock', key: 'yolo', value: 'on' })
      assert.equal(yolo.result.key, 'yolo')
      assert.equal(yolo.result.value, '1')

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


test('session.workspace.move files the session under the target workspace', async () => {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await socket.waitFor(frame => frame.params?.type === 'gateway.ready')
      const moved = await socket.call('session.workspace.move', {
        profile: 'default', session_key: 'sess-mock', cwd: '/tmp/some-project',
      })
      assert.equal(moved.result.cwd, process.cwd(), 'answers the folder the session really uses')
      assert.deepEqual(harness.host.lastAdopt, { sessionId: 'sess-mock', workspacePath: '/tmp/some-project' })
      assert.equal(moved.result.git_repo_root, null)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
})

