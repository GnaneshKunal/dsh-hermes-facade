import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFacadeServer } from '../src/server.mjs'
import { createGatewayServer } from '../src/hermes/server.mjs'
import { createMockHost } from '../scripts/standalone.mjs'

/**
 * One enabled registry package the profile installed itself: the row the phone
 * toggles and updates.
 */
const PROFILE_BUNDLE = {
  name: '@acme/dsh-acme',
  official: false,
  availability: 'profile',
  version: '1.4.0',
  meta: { title: 'Acme Plugin', description: 'Lets Acme chat\nwith DSH' },
  enabled: true,
  installed: true,
  source: '@acme/dsh-acme@^1.4.0',
  optional: false,
  removable: true,
  update: 'registry',
  rows: [{ rowId: 'acme', moduleName: '@acme/dsh-acme' }],
  overrides: [],
}

/** One bundle the installation ships, selected off and read-only. */
const INSTALL_BUNDLE = {
  name: '@deepseek-ai/dsh-agent',
  official: true,
  availability: 'installation',
  version: '0.9.2',
  meta: { title: { en: 'Agent', de: 'Agent (Deutsch)' }, description: { en: 'Runs the agent\nloop' } },
  enabled: false,
  installed: true,
  listedByDefault: true,
  optional: true,
  removable: false,
  readOnlyReason: 'management-required',
  rows: [],
  overrides: ['agent'],
}

/** An on-demand catalog entry: no listed version, only the version it would install. */
const CATALOG_BUNDLE = {
  name: '@acme/dsh-catalog',
  official: false,
  availability: 'missing',
  installTarget: { spec: '@acme/dsh-catalog@2.0.0', version: '2.0.0' },
  description: '@acme catalog bundle\nbuilt for on-demand install',
  enabled: false,
  installed: false,
  optional: false,
  removable: true,
  rows: [],
  overrides: [],
}

/** An enabled package pinned to a git commit. */
const GIT_BUNDLE = {
  name: '@acme/dsh-git',
  official: false,
  availability: 'profile',
  version: '0.2.0',
  meta: { title: 'Acme Git' },
  enabled: true,
  installed: true,
  source: 'github:acme/dsh-git#0123456789abcdef0123456789abcdef01234567',
  optional: false,
  removable: true,
  update: 'git',
  rows: [],
  overrides: [],
}

/** An enabled package installed from a local path, so nothing can replace it. */
const LOCAL_BUNDLE = {
  name: '@acme/dsh-local',
  official: false,
  availability: 'profile',
  version: '0.1.0',
  description: 'installed from a path',
  enabled: true,
  installed: true,
  source: 'file:/Users/acme/dsh-local',
  optional: false,
  removable: true,
  rows: [],
  overrides: [],
}

/** A bundle the host reports without a name, so no row can address it. */
const NAMELESS_BUNDLE = {
  official: false,
  availability: 'missing',
  enabled: true,
  installed: false,
  optional: false,
  removable: false,
  rows: [],
  overrides: [],
}

/** The key the phone sends back for PROFILE_BUNDLE: the package name. */
const KEY = '@acme/dsh-acme'

/**
 * The row Hermex decodes for one bundle.
 * @param {object} fields row fields.
 * @returns {object} row.
 */
function row(fields) {
  return {
    key: fields.key,
    name: fields.name,
    version: fields.version,
    description: fields.description,
    source: fields.source,
    status: fields.status,
    update_available: fields.update_available,
    settings_schema: [],
  }
}

/** The row the phone shows for PROFILE_BUNDLE. */
const PROFILE_ROW = row({
  key: KEY,
  name: 'Acme Plugin',
  version: '1.4.0',
  description: 'Lets Acme chat with DSH',
  source: 'user',
  status: 'enabled',
  update_available: true,
})

/** The row the phone shows for INSTALL_BUNDLE. */
const INSTALL_ROW = row({
  key: '@deepseek-ai/dsh-agent',
  name: 'Agent',
  version: '0.9.2',
  description: 'Runs the agent loop',
  source: 'bundled',
  status: 'disabled',
  update_available: false,
})

/** The row the phone shows for GIT_BUNDLE. */
const GIT_ROW = row({
  key: '@acme/dsh-git',
  name: 'Acme Git',
  version: '0.2.0',
  description: '',
  source: 'user',
  status: 'enabled',
  // Registry-only: a git-pinned bundle updates on the host, so the phone offers
  // no Update button for it.
  update_available: false,
})

/** The row the phone shows for LOCAL_BUNDLE. */
const LOCAL_ROW = row({
  key: '@acme/dsh-local',
  name: '@acme/dsh-local',
  version: '0.1.0',
  description: 'installed from a path',
  source: 'user',
  status: 'enabled',
  update_available: false,
})

/**
 * The PluginVersionList a registry answers for a bundle newer than the install.
 * @param {Array<object>} versions published versions, newest first.
 * @param {string|null} [registry] the registry that answered.
 * @returns {object} version list.
 */
function listedVersions(versions, registry = 'https://registry.npmjs.org') {
  return { status: 'listed', installed: '1.4.0', registry, attempts: [], versions, omitted: 0 }
}

/**
 * A stub host.plugins surface over a mutable bundle list.
 *
 * Every read answers a copy taken now: the dispatcher re-reads the bundle after
 * a write, so only a read made after the change can put the new state in the
 * reply, and a row the dispatcher kept from before the change stays visibly
 * stale. state.events records the order the calls ran in.
 *
 * @param {object} options options.
 * @param {Array<object>} options.bundles pluginManager/listBundles rows.
 * @param {boolean} [options.available] what the availability probe answers.
 * @param {object|Function} [options.change] the ChangeResult setBundleEnabled answers.
 * @param {object|Function} [options.versions] the PluginVersionList listVersions answers.
 * @param {object|Function} [options.update] the PluginUpdateResult updateBundle answers.
 * @returns {object} stub with its surface, recorded calls and setters.
 */
function bundleStub({
  bundles,
  available = true,
  change = { changed: true, application: 'applied' },
  versions = listedVersions([]),
  update = { from: '1.4.0', to: '1.5.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: KEY } },
} = {}) {
  const state = {
    bundles,
    events: [],
    listBundlesCalls: 0,
    setBundleEnabledCalls: [],
    listVersionsCalls: [],
    updateBundleCalls: [],
  }
  let changeAnswer = change
  let versionsAnswer = versions
  let updateAnswer = update
  return {
    state,
    surface: {
      async available() {
        state.events.push('available')
        return available
      },
      async listBundles() {
        state.events.push('list')
        state.listBundlesCalls += 1
        return structuredClone(state.bundles)
      },
      async setBundleEnabled(...args) {
        state.events.push('set')
        // Record the raw arguments so a test can prove nothing extra is sent.
        state.setBundleEnabledCalls.push(args)
        const [name, enabled] = args
        const bundle = state.bundles.find(candidate => String(candidate?.name ?? '') === name)
        if (bundle !== undefined) bundle.enabled = enabled === true
        return typeof changeAnswer === 'function' ? changeAnswer(...args) : changeAnswer
      },
      async listVersions(...args) {
        state.events.push('versions')
        state.listVersionsCalls.push(args)
        return typeof versionsAnswer === 'function' ? versionsAnswer(...args) : versionsAnswer
      },
      async updateBundle(...args) {
        state.events.push('update')
        state.updateBundleCalls.push(args)
        const [name, version] = args
        const bundle = state.bundles.find(candidate => String(candidate?.name ?? '') === name)
        if (bundle !== undefined) bundle.version = version
        return typeof updateAnswer === 'function' ? updateAnswer(...args) : updateAnswer
      },
    },
    setChange(next) { changeAnswer = next },
    setVersions(next) { versionsAnswer = next },
    setUpdate(next) { updateAnswer = next },
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

test('plugins.manage list answers the bundle inventory as Hermex rows', async () => {
  await withSocket(async (socket, harness) => {
    harness.host.plugins = bundleStub({
      bundles: [
        INSTALL_BUNDLE,
        NAMELESS_BUNDLE,
        PROFILE_BUNDLE,
        CATALOG_BUNDLE,
        GIT_BUNDLE,
        LOCAL_BUNDLE,
        // A launch-mode bundle the desktop hides, and one the installation holds
        // back until the profile selects it: neither may reach the phone.
        { ...PROFILE_BUNDLE, name: '@deepseek-ai/dsh-headless', enabled: true },
        {
          ...PROFILE_BUNDLE,
          name: '@acme/dsh-held-back',
          availability: 'installation',
          listedByDefault: false,
          enabled: false,
          installed: false,
        },
      ],
    }).surface
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    assert.equal(reply.error, undefined)
    // One row per manageable bundle, in the host's order. The nameless bundle,
    // the hidden launch-mode bundle, the held-back one and the on-demand catalog
    // entry (nothing installed under it) are all dropped rather than offered as
    // rows the screen could never act on, and both counts travel.
    assert.deepEqual(reply.result, {
      plugins: [INSTALL_ROW, PROFILE_ROW, GIT_ROW, LOCAL_ROW],
      user_count: 3,
      bundled_count: 1,
    })
    // Hermex has no catalog tier, version or name for a plugin; sending them
    // would leave the screen rendering fields DSH never fills.
    for (const listed of reply.result.plugins) {
      assert.equal('catalog_tier' in listed, false)
      assert.equal('catalog_version' in listed, false)
      assert.equal('catalog_name' in listed, false)
    }
  })
})

test('plugins.manage toggle pins the setBundleEnabled arguments and answers the re-read row', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [{ ...structuredClone(PROFILE_BUNDLE), enabled: false }] })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(reply.error, undefined)
    // The host receives the bundle package name and the boolean, and nothing
    // else: they are exactly pluginManager/setBundleEnabled's name and enabled.
    assert.deepEqual(stub.state.setBundleEnabledCalls, [[KEY, true]])
    // The row travels only after the write, so the reply shows the status the
    // toggle left behind rather than the one the request started from.
    assert.deepEqual(stub.state.events, ['available', 'list', 'set', 'list'])
    assert.deepEqual(reply.result, {
      ok: true,
      unchanged: false,
      restart_required: false,
      gateway_reloaded: false,
      activation: {},
      name: KEY,
      plugin: PROFILE_ROW,
    })
  })
})

test('plugins.manage toggle reports a restart only for the result that asks for one', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
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
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
    harness.host.plugins = stub.surface
    // DSH saved the patch, but a higher-priority layer keeps the old state, so
    // the toggle is not in effect even though changed is true.
    stub.setChange({ changed: true, application: 'overridden', error: { code: 'management-required' } })
    const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: KEY, enable: true })
    assert.equal(reply.result, undefined, 'an overridden change must not answer as applied')
    assert.equal(reply.error.code, 5026)
    assert.match(reply.error.message, /higher-priority layer keeps that plugin as it was/)
    assert.match(reply.error.message, /management-required/)
    assert.deepEqual(stub.state.setBundleEnabledCalls, [[KEY, true]], 'the host was still asked once')
  })
})

test('plugins.manage answers plugin:null when the post-toggle read fails', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
    harness.host.plugins = stub.surface
    // A real ChangeResult names its target, which is what the reply falls back
    // to for name when there is no row to read.
    stub.setChange({ changed: true, application: 'applied', target: KEY })
    const realList = stub.surface.listBundles
    let reads = 0
    // The first read finds the bundle; the read-back after the change fails.
    stub.surface.listBundles = async () => {
      reads += 1
      if (reads > 1) throw new Error('bundle read failed')
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

test('plugins.manage never acts on a package the phone is not shown', async () => {
  await withSocket(async (socket, harness) => {
    // A launch-mode bundle is real and even enabled, but the desktop hides it and
    // the phone must not be able to switch it: selecting one on a live profile can
    // leave the next start in a mode this profile cannot compose.
    const hidden = { ...PROFILE_BUNDLE, name: '@deepseek-ai/dsh-headless', enabled: true }
    const stub = bundleStub({ bundles: [hidden] })
    harness.host.plugins = stub.surface

    const toggle = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: '@deepseek-ai/dsh-headless', enable: false })
    assert.equal(toggle.result, undefined)
    assert.equal(toggle.error.code, 5026)
    assert.match(toggle.error.message, /not a plugin this host manages from the phone/)
    assert.deepEqual(stub.state.setBundleEnabledCalls, [], 'a hidden bundle must never reach the switch')

    const update = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: '@deepseek-ai/dsh-headless' })
    assert.equal(update.result, undefined)
    assert.equal(update.error.code, 5026)
    assert.deepEqual(stub.state.listVersionsCalls, [], 'and it is never asked for a version list')
  })
})

test('plugins.manage refuses an unknown plugin key with 4020 before writing', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
    harness.host.plugins = stub.surface
    const toggle = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: '@acme/nope', enable: true })
    assert.equal(toggle.result, undefined)
    assert.equal(toggle.error.code, 4020)
    assert.equal(toggle.error.message, 'No plugin on this host has that key')
    const update = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: '@acme/nope' })
    assert.equal(update.result, undefined)
    assert.equal(update.error.code, 4020)
    assert.deepEqual(stub.state.setBundleEnabledCalls, [], 'an unknown key must not reach the switch')
    assert.deepEqual(stub.state.listVersionsCalls, [], 'an unknown key must not reach the registry')
  })
})

test('plugins.manage refuses a read-only bundle with 5026 in DSH wording', async () => {
  await withSocket(async (socket, harness) => {
    const cases = [
      { label: 'management-required', reason: 'management-required', phrase: /part of the DSH installation/ },
      // listBundles reports only 'management-required' for a bundle today, so the
      // union's other value never reaches here; a reason this facade does not know
      // still refuses in plain words rather than sending a code to the phone.
      { label: 'an unknown reason', reason: 'some-future-reason', phrase: /^DSH cannot enable or disable that plugin from here\.$/ },
    ]
    for (const entry of cases) {
      const stub = bundleStub({ bundles: [{ ...structuredClone(INSTALL_BUNDLE), readOnlyReason: entry.reason }] })
      harness.host.plugins = stub.surface
      const reply = await socket.call('plugins.manage', { action: 'toggle', profile: 'default', key: '@deepseek-ai/dsh-agent', enable: true })
      assert.equal(reply.result, undefined, entry.label + ' must not answer a result')
      assert.equal(reply.error.code, 5026, entry.label + ' must be refused')
      // The phone shows this sentence verbatim, so it has to say why the row is
      // read-only, not merely that the change failed.
      assert.match(reply.error.message, entry.phrase, entry.label + ' must say why')
      assert.deepEqual(stub.state.setBundleEnabledCalls, [], entry.label + ' must not reach the switch')
    }
  })
})

test('plugins.manage forwards a failed change as 5026 in the host wording', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
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

test('plugins.manage update installs the newest eligible version and answers the toggle shape', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({
      bundles: [structuredClone(PROFILE_BUNDLE)],
      // Newest first: 2.0.0 rejects this DSH build, 1.9.0 declares no bundle,
      // 1.7.0 is a prerelease and 1.6.0 is deprecated, so 1.5.0 is the first
      // version DSH's own update candidate would take. The phone has no version
      // chooser and no confirmation, so it must not install either of those.
      versions: listedVersions([
        { version: '2.0.0', tags: [], prerelease: false, bundle: true, incompatible: { name: KEY, version: '2.0.0', runtimeVersion: '0.9.0', requirements: ['engines.dsh'] } },
        { version: '1.9.0', tags: [], prerelease: false, bundle: false },
        { version: '1.7.0', tags: [], prerelease: true, bundle: true },
        { version: '1.6.0', tags: [], prerelease: false, bundle: true, deprecated: 'superseded by 1.7.0' },
        { version: '1.5.0', tags: ['latest'], publishedAt: '2026-11-01T00:00:00.000Z', prerelease: false, bundle: true },
        { version: '1.4.1', tags: [], prerelease: false, bundle: true },
      ]),
      update: {
        from: '1.4.0',
        to: '1.5.0',
        step: 'install',
        result: { changed: true, application: 'applied', stage: 'install', target: KEY, enabled: true, version: '1.5.0' },
      },
    })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
    assert.equal(reply.error, undefined)
    assert.deepEqual(stub.state.listVersionsCalls, [[KEY]])
    // The version and the registry that answered are exactly updateBundle's
    // arguments: the phone never chooses either.
    assert.deepEqual(stub.state.updateBundleCalls, [[KEY, '1.5.0', { registry: 'https://registry.npmjs.org' }]])
    // The row travels only after the update: the read-back shows the version the
    // update installed.
    assert.deepEqual(stub.state.events, ['available', 'list', 'versions', 'update', 'list'])
    assert.deepEqual(reply.result, {
      ok: true,
      unchanged: false,
      restart_required: false,
      gateway_reloaded: false,
      activation: {},
      name: KEY,
      plugin: { ...PROFILE_ROW, version: '1.5.0' },
    })
  })
})

test('plugins.manage update answers ok and unchanged when no version can replace the bundle', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
    harness.host.plugins = stub.surface
    const cases = [
      { label: 'empty list', versions: [] },
      {
        label: 'nothing eligible',
        versions: [
          { version: '1.9.0', tags: [], prerelease: false, bundle: false },
          { version: '1.8.0', tags: [], prerelease: false, bundle: true, incompatible: { name: KEY, version: '1.8.0', runtimeVersion: '0.9.0', requirements: ['engines.dsh'] } },
        ],
      },
    ]
    for (const entry of cases) {
      stub.setVersions(listedVersions(entry.versions))
      const reply = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
      assert.equal(reply.error, undefined, entry.label + ' must be answered')
      // Nothing newer is not a failure: the update did nothing, and the reply
      // says so with the row read back now.
      assert.deepEqual(reply.result, {
        ok: true,
        unchanged: true,
        restart_required: false,
        gateway_reloaded: false,
        activation: {},
        name: KEY,
        plugin: PROFILE_ROW,
      }, entry.label + ' reply')
    }
    assert.deepEqual(stub.state.updateBundleCalls, [], 'no version can be installed')
    assert.deepEqual(stub.state.listVersionsCalls, [[KEY], [KEY]], 'each update asks the registry once')
  })
})

test('plugins.manage refuses a version list the host could not read with 5026 and its reason', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({
      bundles: [structuredClone(PROFILE_BUNDLE)],
      versions: { status: 'refused', problem: 'network', reason: 'registry unreachable: ETIMEDOUT', attempts: [] },
    })
    harness.host.plugins = stub.surface
    const refused = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
    assert.equal(refused.result, undefined, 'a refused list must not answer a result')
    assert.equal(refused.error.code, 5026)
    // The phone shows the host's reason verbatim; no version can be chosen from
    // a list that was never read.
    assert.equal(refused.error.message, 'registry unreachable: ETIMEDOUT')
    assert.deepEqual(stub.state.updateBundleCalls, [], 'a refused list must not install')

    // A refusal that carries no reason still gets an honest sentence.
    stub.setVersions({ status: 'refused', problem: 'unknown', attempts: [] })
    const silent = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
    assert.equal(silent.error.code, 5026)
    assert.equal(silent.error.message, 'DSH could not read a version list for that plugin')
  })
})

test('plugins.manage refuses a git-pinned bundle with 5026 and never lists versions', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(GIT_BUNDLE)] })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: '@acme/dsh-git' })
    assert.equal(reply.result, undefined, 'a git-pinned bundle must not answer a result')
    assert.equal(reply.error.code, 5026)
    // A git copy updates to another commit of the host's checkout, which the
    // phone cannot choose; no registry call is made at all.
    assert.match(reply.error.message, /git commit on this host/)
    assert.match(reply.error.message, /not from the phone/)
    assert.deepEqual(stub.state.listVersionsCalls, [], 'a git copy has no version list')
    assert.deepEqual(stub.state.updateBundleCalls, [], 'a git copy must not be replaced from the phone')
  })
})

test('plugins.manage refuses a bundle with no update path with 5026', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(LOCAL_BUNDLE), structuredClone(INSTALL_BUNDLE)] })
    harness.host.plugins = stub.surface
    for (const [key, label] of [['@acme/dsh-local', 'path install'], ['@deepseek-ai/dsh-agent', 'installation-supplied']]) {
      const reply = await socket.call('plugins.manage', { action: 'update', profile: 'default', key })
      assert.equal(reply.result, undefined, label + ' must not answer a result')
      assert.equal(reply.error.code, 5026, label + ' must be refused')
      // DSH reports no update path for these, and the sentence says which ways a
      // package can arrive without one.
      assert.match(reply.error.message, /no update from the phone/, label + ' must say it cannot update')
      assert.match(reply.error.message, /installed from a path/, label + ' must name the path install')
    }
    assert.deepEqual(stub.state.listVersionsCalls, [], 'no update path means no registry call')
  })
})

test('plugins.manage forwards a failed update as 5026 in the host wording', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({
      bundles: [structuredClone(PROFILE_BUNDLE)],
      versions: listedVersions([{ version: '1.5.0', tags: [], prerelease: false, bundle: true }]),
      update: {
        from: '1.4.0',
        to: '1.5.0',
        step: 'install',
        result: {
          changed: false,
          application: 'failed',
          stage: 'install',
          target: KEY,
          error: { code: 'operation-error', diagnostic: 'pnpm exited 1' },
        },
      },
    })
    harness.host.plugins = stub.surface
    const failed = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
    assert.equal(failed.result, undefined)
    assert.equal(failed.error.code, 5026)
    // The inner ChangeResult is where the installation's own wording lives.
    assert.equal(failed.error.message, 'pnpm exited 1')

    // A failure with no diagnostic falls back to the host's error code.
    stub.setUpdate({
      from: '1.4.0',
      to: '1.5.0',
      step: 'install',
      result: { changed: false, application: 'cancelled', stage: 'install', target: KEY, error: { code: 'operation-error' } },
    })
    const coded = await socket.call('plugins.manage', { action: 'update', profile: 'default', key: KEY })
    assert.equal(coded.result, undefined)
    assert.equal(coded.error.code, 5026)
    assert.equal(coded.error.message, 'operation-error')
    assert.equal(stub.state.updateBundleCalls.length, 2, 'the host was asked each time')
  })
})

test('plugins.manage refuses install, remove and settings with 5026', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
    harness.host.plugins = stub.surface
    for (const action of ['install', 'remove', 'settings']) {
      const params = action === 'install'
        ? { action, profile: 'default', name: '@acme/dsh-acme' }
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
    assert.deepEqual(stub.state.setBundleEnabledCalls, [], 'a lifecycle action must not reach the switch')
    assert.deepEqual(stub.state.listVersionsCalls, [], 'a lifecycle action must not reach the registry')
  })
})

test('plugins.manage refuses an unknown action with 4021 and another Profile with 4064', async () => {
  await withSocket(async (socket, harness) => {
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)] })
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
    assert.equal(stub.state.listBundlesCalls, 0)
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
    const stub = bundleStub({ bundles: [structuredClone(PROFILE_BUNDLE)], available: false })
    harness.host.plugins = stub.surface
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, -32601)
    assert.equal(reply.error.message, 'plugins.manage is not available on this host')
    // A probe that already said no is not followed by a read that cannot work,
    // so no Remote call is made at all.
    assert.equal(stub.state.listBundlesCalls, 0)
  })
})

test('plugins.manage answers an error instead of an empty list when the bundle read fails', async () => {
  await withSocket(async (socket, harness) => {
    harness.host.plugins = {
      async available() { return true },
      async listBundles() { throw new Error('pluginManager listBundles failed: host is down') },
      async setBundleEnabled() { throw new Error('plugins.manage must not write while listing') },
      async listVersions() { throw new Error('plugins.manage must not list versions while listing') },
      async updateBundle() { throw new Error('plugins.manage must not update while listing') },
    }
    const reply = await socket.call('plugins.manage', { action: 'list', profile: 'default' })
    // A failed read must never be answered as an empty plugins list: the phone
    // would draw an empty Plugins screen and report this host as having none.
    assert.equal(reply.result, undefined)
    assert.equal(reply.error.code, -32000)
    assert.equal(reply.error.message, 'pluginManager listBundles failed: host is down')
  })
})
