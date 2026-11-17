import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFacadeServer } from '../src/server.mjs'
import { createGatewayServer } from '../src/hermes/server.mjs'
import { createMockHost } from '../scripts/standalone.mjs'

/** One writable entry as pluginManager/listPlugins returns it. */
const WRITABLE = {
  entryId: 'plugins/acme.js',
  moduleName: '@acme/dsh-plugin',
  meta: { title: 'Acme Plugin', description: 'Lets Acme chat\nwith DSH' },
  enabled: true,
  fiberPhase: 'active',
  patchId: 'acme',
}

/** One read-only entry, the kind the installation ships. */
const READ_ONLY = {
  entryId: 'dsh-agent',
  moduleName: '@deepseek-ai/dsh-agent',
  meta: { title: { en: 'Agent', de: 'Agent (Deutsch)' } },
  enabled: false,
  fiberPhase: null,
  readOnlyReason: 'management-required',
}

/** An entry the Loader reports without an id, so no row can address it. */
const UNADDRESSABLE = { moduleName: '@deepseek-ai/dsh-anonymous', enabled: true, fiberPhase: 'active' }

/** The key the phone sends back for WRITABLE: the inventory row's entryId. */
const KEY = 'plugins/acme.js'

/**
 * The row Hermex decodes for WRITABLE, in the status a toggle left it in.
 * @param {string} status enabled|disabled.
 * @returns {object} row.
 */
function writableRow(status) {
  return {
    key: KEY,
    name: 'Acme Plugin',
    version: '',
    description: 'Lets Acme chat with DSH',
    source: 'user',
    status,
    update_available: false,
    settings_schema: [],
  }
}

/**
 * A stubbed host.plugins surface over a mutable inventory.
 *
 * list() answers copies of the inventory: the dispatcher re-reads it after a
 * toggle, so only a fresh read can put the new status in the reply and a row the
 * dispatcher kept from before the change stays visibly stale.
 *
 * @param {object} options options.
 * @param {Array<object>} options.infos pluginManager/listPlugins rows.
 * @param {boolean} [options.available] what the availability probe answers.
 * @param {object|Function} [options.change] the ChangeResult setEnabled answers.
 * @returns {object} stub with its surface, recorded calls and setChange.
 */
function pluginStub({ infos, available = true, change = { changed: true, application: 'applied' } } = {}) {
  const state = { infos, listCalls: 0, setEnabledCalls: [] }
  let answer = change
  return {
    state,
    surface: {
      async available() { return available },
      async list() {
        state.listCalls += 1
        return structuredClone(state.infos)
      },
      async setEnabled(...args) {
        // Record the raw arguments so a test can prove nothing extra is sent.
        state.setEnabledCalls.push(args)
        const [id, enabled] = args
        const entry = state.infos.find(info => String(info?.entryId ?? '') === id)
        if (entry !== undefined) entry.enabled = enabled === true
        return typeof answer === 'function' ? answer(...args) : answer
      },
    },
    setChange(next) { answer = next },
  }
}

/**
 * Boot the facade and the gateway on ephemeral ports.
 * @returns {Promise<object>} harness.
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-plugins-wire-'))
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
    host,
    memoryHome: dir,
    uploadsDir: dir + '-uploads',
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
 *
 * plugins.manage needs no reverse requests, so this socket does not advertise
 * server-request support the way the stock client does.
 *
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
    const id = 'wire-' + Math.random().toString(36).slice(2, 8)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return waitFor(frame => frame.id === id)
  }
  return { ws, frames, waitFor, call }
}

/**
 * Run one test body against a fresh gateway and a signed-in socket.
 *
 * Every test boots its own servers and closes them here, so a stub left on one
 * test's host can never answer for another test.
 *
 * @param {(socket: object, harness: object) => Promise<void>} body test body.
 * @returns {Promise<void>} resolves once the servers are closed.
 */
async function withSocket(body) {
  const harness = await boot()
  try {
    const cookie = await signIn(harness.base, harness.password)
    const socket = await openSocket(harness.base, cookie)
    try {
      await body(socket, harness)
    } finally {
      socket.ws.close()
    }
  } finally {
    await harness.gateway.close()
    await harness.facade.close()
  }
}

test('plugins.manage list answers the host inventory as Hermex rows', async () => {
  await withSocket(async (socket, harness) => {
    harness.host.plugins = pluginStub({ infos: [READ_ONLY, UNADDRESSABLE, WRITABLE] }).surface
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    assert.equal(reply.error, undefined)
    // Rows keep the inventory's order, the entry with no entryId is dropped
    // instead of becoming an unaddressable row, and both counts travel.
    assert.deepEqual(reply.result, {
      plugins: [
        {
          key: 'dsh-agent',
          name: 'Agent',
          version: '',
          description: '',
          source: 'bundled',
          status: 'disabled',
          update_available: false,
          settings_schema: [],
        },
        writableRow('enabled'),
      ],
      user_count: 1,
      bundled_count: 1,
    })
    // Hermex has no catalog tier, version or name for a plugin; sending them
    // would leave the screen rendering fields DSH never fills.
    for (const row of reply.result.plugins) {
      assert.equal('catalog_tier' in row, false)
      assert.equal('catalog_version' in row, false)
      assert.equal('catalog_name' in row, false)
    }
  })
})

test('plugins.manage toggle pins the setEnabled arguments and answers the re-read row', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [{ ...WRITABLE, enabled: false }], change: { changed: true, application: 'applied' } })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(reply.error, undefined)
    // The host receives the listed key and the boolean, and nothing else: they
    // are exactly pluginManager/setPluginEnabled's id and enabled.
    assert.deepEqual(stub.state.setEnabledCalls, [[KEY, true]])
    // The reply's row is the inventory read after the write, so it shows the
    // status the toggle left behind rather than the one the request started from.
    assert.deepEqual(reply.result, {
      ok: true,
      unchanged: false,
      restart_required: false,
      gateway_reloaded: false,
      activation: {},
      name: KEY,
      plugin: writableRow('enabled'),
    })
  })
})

test('plugins.manage toggle reports a restart only for the result that asks for one', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [{ ...WRITABLE, enabled: false }] })
    harness.host.plugins = stub.surface
    const cases = [
      { label: 'applied', change: { changed: true, application: 'applied' }, enable: true, restartRequired: false, unchanged: false },
      { label: 'restart-required', change: { changed: true, application: 'restart-required', restartReason: 'no-hmr' }, enable: false, restartRequired: true, unchanged: false },
    ]
    for (const entry of cases) {
      stub.setChange(entry.change)
      const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: entry.enable })
      assert.equal(reply.error, undefined, entry.label + ' must be answered')
      assert.equal(reply.result.restart_required, entry.restartRequired, entry.label + ' restart_required')
      assert.equal(reply.result.ok, true, entry.label + ' ok')
      assert.equal(reply.result.unchanged, entry.unchanged, entry.label + ' unchanged')
      // A plugin toggle never reloads this facade's gateway and never defers a
      // live activation.
      assert.equal(reply.result.gateway_reloaded, false, entry.label + ' gateway_reloaded')
      assert.deepEqual(reply.result.activation, {}, entry.label + ' activation')
      assert.equal(reply.result.name, KEY, entry.label + ' name')
    }
  })
})

test('plugins.manage refuses an overridden toggle instead of claiming it applied', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [{ ...WRITABLE, enabled: false }] })
    harness.host.plugins = stub.surface
    // DSH saved the patch, but a higher-priority layer keeps the old state, so
    // the toggle is not in effect even though `changed` is true.
    stub.setChange({ changed: true, application: 'overridden', error: { code: 'management-required' } })
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(reply.result, undefined, 'an overridden change must not answer as applied')
    assert.equal(reply.error.code, 5026)
    assert.match(reply.error.message, /higher-priority layer keeps that plugin as it was/)
    assert.match(reply.error.message, /management-required/)
    assert.equal(stub.state.setEnabledCalls.length, 1, 'the host was still asked once')
  })
})

test('plugins.manage answers plugin:null when the post-toggle read fails', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [{ ...WRITABLE, enabled: false }] })
    harness.host.plugins = stub.surface
    // A real ChangeResult names its target, which is what the reply falls back
    // to for `name` when there is no row to read.
    stub.setChange({ changed: true, application: 'applied', target: KEY })
    const realList = stub.surface.list
    let reads = 0
    // The first read finds the row; the read-back after the change fails.
    stub.surface.list = async () => {
      reads += 1
      if (reads > 1) throw new Error('inventory read failed')
      return realList()
    }
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(reply.error, undefined)
    assert.equal(reply.result.ok, true)
    assert.equal(reply.result.name, KEY)
    // A null row is the client's cue to re-read: the pre-toggle row would show
    // a state the host may no longer be in.
    assert.equal(reply.result.plugin, null)
  })
})

test('plugins.manage refuses an unknown plugin key with 4020 before writing', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [WRITABLE] })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: 'plugins/nope.js', enable: true })
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, 4020)
    assert.equal(reply.error.message, 'No plugin on this host has that key')
    assert.deepEqual(stub.state.setEnabledCalls, [], 'an unknown key must not reach the switch')
  })
})

test('plugins.manage refuses a bundled plugin with 5026 in the installation wording', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [READ_ONLY] })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: 'dsh-agent', enable: true })
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, 5026)
    // The phone shows this sentence verbatim, so it has to say why the row is
    // read-only, not merely that the change failed.
    assert.match(reply.error.message, /part of the DSH installation/)
    assert.deepEqual(stub.state.setEnabledCalls, [], 'a bundled plugin must not reach the switch')
  })
})

test('plugins.manage forwards a failed change as 5026 in the host wording', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [WRITABLE] })
    harness.host.plugins = stub.surface
    stub.setChange({
      changed: false,
      application: 'failed',
      stage: 'enable',
      target: KEY,
      error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
    })
    const failed = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(failed.result, undefined)
    assert.equal(failed.error.code, 5026)
    // The diagnostic is the sentence the phone shows; the error code and the
    // application state stay out of it.
    assert.equal(failed.error.message, 'pnpm exited 1')

    // A failure with no diagnostic falls back to the host's error code.
    stub.setChange({ changed: false, application: 'failed', stage: 'enable', target: KEY, error: { code: 'operation-error' } })
    const coded = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: false })
    assert.equal(coded.result, undefined)
    assert.equal(coded.error.code, 5026)
    assert.equal(coded.error.message, 'operation-error')
  })
})

test('plugins.manage refuses install, remove, update and settings with 5026', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [WRITABLE] })
    harness.host.plugins = stub.surface
    for (const action of ['install', 'remove', 'update', 'settings']) {
      const params = action === 'install'
        ? { action, profile: 'default', name: '@acme/dsh-plugin' }
        : { action, profile: 'default', key: KEY }
      const reply = await socket.call('plugins.manage', params)
      assert.equal(reply.result, undefined, action + ' must not answer a result')
      assert.equal(reply.error.code, 5026, action + ' must be refused')
      // The refusal names the action and the only path DSH supports for it.
      assert.ok(
        reply.error.message.startsWith('plugins.manage ' + action + ' cannot be done from the phone'),
        action + ' must name itself and the phone',
      )
      assert.match(reply.error.message, /"dsh plugin" command/, action + ' must name the supported path')
    }
    assert.deepEqual(stub.state.setEnabledCalls, [], 'a lifecycle action must not reach the switch')
  })
})

test('plugins.manage refuses an unknown action with 4021 and another Profile with 4064', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [WRITABLE] })
    harness.host.plugins = stub.surface
    const unknown = await socket.call('plugins.manage', { action: 'explode', profile: 'default' })
    assert.equal(unknown.result, undefined)
    assert.equal(unknown.error.code, 4021)
    assert.match(unknown.error.message, /explode/)

    const profile = await socket.call('plugins.manage', { action: 'list', profile: 'work' })
    assert.equal(profile.result, undefined)
    assert.equal(profile.error.code, 4064)
    assert.match(profile.error.message, /"work"/)

    // Both refuse the request itself, so neither reads the inventory.
    assert.equal(stub.state.listCalls, 0)
  })
})

test('plugins.manage answers -32601 when the host has no plugin surface', async () => {
  await withSocket(async (socket, harness) => {
    // Strip the surface the DSH adapter adds: a host without a pluginManager is
    // what an older DSH presents. -32601 makes Hermex 2.1.0's unconditional
    // Settings row report that it cannot load plugins from this host.
    delete harness.host.plugins
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, -32601)
    assert.equal(reply.error.message, 'plugins.manage is not available on this host')
  })
})

test('plugins.manage answers -32601 when the availability probe says no and reads nothing', async () => {
  await withSocket(async (socket, harness) => {
    const stub = pluginStub({ infos: [WRITABLE], available: false })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, -32601)
    assert.equal(reply.error.message, 'plugins.manage is not available on this host')
    // A probe that already said no is not followed by a read that cannot work,
    // so no Remote call is made at all.
    assert.equal(stub.state.listCalls, 0)
  })
})

test('plugins.manage answers an error instead of an empty list when the host read fails', async () => {
  await withSocket(async (socket, harness) => {
    harness.host.plugins = {
      async available() { return true },
      async list() { throw new Error('pluginManager listPlugins failed: host is down') },
      async setEnabled() { throw new Error('plugins.manage must not write while listing') },
    }
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    // A failed read must never be answered as an empty plugins list: the phone
    // would draw an empty Plugins screen and report this host as having none.
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, -32000)
    assert.equal(reply.error.message, 'pluginManager listPlugins failed: host is down')
  })
})
