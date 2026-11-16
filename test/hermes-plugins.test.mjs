import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseManageParams,
  PLUGIN_CODES,
  pluginError,
  pluginRowOf,
  pluginsBodyOf,
  toggleReplyOf,
} from '../src/hermes/plugins.mjs'
import { PROFILE_NAME } from '../src/hermes/protocol.mjs'

/**
 * The error a call throws.
 * @param {Function} fn call.
 * @returns {Error} the thrown error.
 */
function errorOf(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return assert.fail('the call should have thrown')
}

/** One writable, enabled entry as pluginManager/listPlugins returns it. */
const WRITABLE = {
  entryId: 'plugins/my-plugin.js',
  moduleName: '@acme/dsh-plugin',
  meta: { title: 'Acme Plugin', description: 'Lets Acme chat with DSH' },
  enabled: true,
  fiberPhase: 'active',
  patchId: 'my-plugin',
}

/** One read-only entry, the kind the installation ships. */
const READ_ONLY = {
  entryId: 'dsh-agent',
  moduleName: '@deepseek-ai/dsh-agent',
  meta: { title: 'Agent' },
  enabled: false,
  fiberPhase: null,
  readOnlyReason: 'management-required',
}

/** An entry the Loader reports without an id, so nothing can address it. */
const UNADDRESSABLE = { moduleName: '@deepseek-ai/dsh-anonymous', enabled: true, fiberPhase: 'active' }

test('PLUGIN_CODES pins the codes the Plugins screen decodes', () => {
  assert.deepEqual(PLUGIN_CODES, { unknownProfile: 4064, invalidParams: 4021, missing: 4020, refused: 5026 })
})

test('pluginRowOf maps a full PluginInfo onto the row Hermex decodes', () => {
  assert.deepEqual(pluginRowOf(WRITABLE), {
    key: 'plugins/my-plugin.js',
    name: 'Acme Plugin',
    version: '',
    description: 'Lets Acme chat with DSH',
    source: 'user',
    status: 'enabled',
    update_available: false,
    settings_schema: [],
  })
})

test('pluginRowOf reads a string title', () => {
  const row = pluginRowOf({ ...READ_ONLY, meta: { title: 'Agent' } })
  assert.equal(row.name, 'Agent')
})

test('pluginRowOf reads a localized title and description object', () => {
  const row = pluginRowOf({
    ...WRITABLE,
    meta: {
      title: { en: 'Terminal Tools', de: 'Terminalwerkzeuge' },
      description: { en: 'Runs commands', de: 'Fuehrt Befehle aus' },
    },
  })
  assert.equal(row.name, 'Terminal Tools')
  assert.equal(row.description, 'Runs commands')
})

test('pluginRowOf flattens a multiline description to one line', () => {
  const row = pluginRowOf({ ...WRITABLE, meta: { description: '  Runs\n\ncommands\t\twith   care  ' } })
  assert.equal(row.description, 'Runs commands with care')
})

test('pluginRowOf falls back to moduleName when meta is missing', () => {
  assert.deepEqual(pluginRowOf({ ...READ_ONLY, meta: undefined }), {
    key: 'dsh-agent',
    name: '@deepseek-ai/dsh-agent',
    version: '',
    description: '',
    source: 'bundled',
    status: 'disabled',
    update_available: false,
    settings_schema: [],
  })
})

test('pluginRowOf falls back to the key when moduleName is empty too', () => {
  const row = pluginRowOf({
    entryId: 'row-only',
    moduleName: '',
    enabled: false,
    fiberPhase: null,
    readOnlyReason: 'unaddressable',
  })
  assert.equal(row.name, 'row-only')
})

test('pluginRowOf marks a read-only row as bundled', () => {
  const row = pluginRowOf(READ_ONLY)
  assert.equal(row.source, 'bundled')
  assert.equal(row.status, 'disabled')
})

test('pluginRowOf marks a patch row as user', () => {
  assert.equal(pluginRowOf(WRITABLE).source, 'user')
})

test('pluginRowOf reads anything but true as disabled', () => {
  assert.equal(pluginRowOf({ ...WRITABLE, enabled: undefined }).status, 'disabled')
  assert.equal(pluginRowOf({ ...WRITABLE, enabled: 'yes' }).status, 'disabled')
  assert.equal(pluginRowOf({ ...WRITABLE, enabled: null }).status, 'disabled')
})

test('pluginRowOf drops a row that has no entryId', () => {
  assert.equal(pluginRowOf({}), null)
  assert.equal(pluginRowOf({ entryId: '' }), null)
  assert.equal(pluginRowOf(undefined), null)
  assert.equal(pluginRowOf(null), null)
  assert.equal(pluginRowOf(UNADDRESSABLE), null)
})

test('pluginsBodyOf keeps order, drops unaddressable rows and counts sources', () => {
  const body = pluginsBodyOf([WRITABLE, READ_ONLY, UNADDRESSABLE])
  assert.deepEqual(body, {
    plugins: [
      {
        key: 'plugins/my-plugin.js',
        name: 'Acme Plugin',
        version: '',
        description: 'Lets Acme chat with DSH',
        source: 'user',
        status: 'enabled',
        update_available: false,
        settings_schema: [],
      },
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
    ],
    user_count: 1,
    bundled_count: 1,
  })
})

test('pluginsBodyOf sends both counts as numbers', () => {
  const body = pluginsBodyOf([WRITABLE, READ_ONLY, READ_ONLY])
  assert.equal(typeof body.user_count, 'number')
  assert.equal(typeof body.bundled_count, 'number')
  assert.equal(body.user_count, 1)
  assert.equal(body.bundled_count, 2)
})

test('pluginsBodyOf treats a non-array argument as empty', () => {
  assert.deepEqual(pluginsBodyOf(undefined), { plugins: [], user_count: 0, bundled_count: 0 })
  assert.deepEqual(pluginsBodyOf(null), { plugins: [], user_count: 0, bundled_count: 0 })
  assert.deepEqual(pluginsBodyOf({ plugins: [WRITABLE] }), { plugins: [], user_count: 0, bundled_count: 0 })
})

test('toggleReplyOf reports an applied toggle', () => {
  const row = pluginRowOf(WRITABLE)
  const change = {
    changed: true,
    application: 'applied',
    stage: 'enable',
    target: 'plugins/my-plugin.js',
    enabled: true,
  }
  assert.deepEqual(toggleReplyOf(change, row), {
    ok: true,
    unchanged: false,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: 'plugins/my-plugin.js',
    plugin: row,
  })
})

test('toggleReplyOf reports a restart-required toggle', () => {
  const row = pluginRowOf(WRITABLE)
  const change = {
    changed: true,
    application: 'restart-required',
    restartReason: 'no-hmr',
    stage: 'enable',
    target: 'plugins/my-plugin.js',
    enabled: true,
  }
  assert.deepEqual(toggleReplyOf(change, row), {
    ok: true,
    unchanged: false,
    restart_required: true,
    gateway_reloaded: false,
    activation: {},
    name: 'plugins/my-plugin.js',
    plugin: row,
  })
})

test('toggleReplyOf reports an overridden toggle as applied and unchanged', () => {
  const row = pluginRowOf(WRITABLE)
  assert.deepEqual(toggleReplyOf({ application: 'overridden', target: 'plugins/my-plugin.js' }, row), {
    ok: true,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: 'plugins/my-plugin.js',
    plugin: row,
  })
})

test('toggleReplyOf reports a failed toggle as not ok', () => {
  const change = {
    changed: false,
    application: 'failed',
    stage: 'enable',
    target: 'plugins/my-plugin.js',
    error: { code: 'operation-error' },
  }
  assert.deepEqual(toggleReplyOf(change, null), {
    ok: false,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: 'plugins/my-plugin.js',
    plugin: null,
  })
})

test('toggleReplyOf reads a cancelled toggle as not ok', () => {
  assert.equal(toggleReplyOf({ application: 'cancelled', changed: false }, null).ok, false)
})

test('toggleReplyOf tolerates a missing or partial change', () => {
  const expected = {
    ok: true,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: '',
    plugin: null,
  }
  assert.deepEqual(toggleReplyOf(undefined, null), expected)
  assert.deepEqual(toggleReplyOf({}, null), expected)
  assert.deepEqual(toggleReplyOf({ application: 'applied' }, undefined), expected)
})

test('toggleReplyOf keeps the row it was listed as', () => {
  const row = pluginRowOf(READ_ONLY)
  assert.equal(toggleReplyOf({ application: 'applied' }, row).plugin, row)
  assert.equal(toggleReplyOf({ application: 'applied' }, row).name, 'dsh-agent')
})

test('parseManageParams defaults list to the one Profile', () => {
  assert.deepEqual(parseManageParams({ action: 'list' }), {
    action: 'list',
    profile: PROFILE_NAME,
    key: '',
    enable: false,
  })
})

test('parseManageParams accepts the one Profile by name', () => {
  assert.deepEqual(parseManageParams({ action: 'list', profile: PROFILE_NAME }), {
    action: 'list',
    profile: PROFILE_NAME,
    key: '',
    enable: false,
  })
  assert.equal(parseManageParams({ action: 'list', profile: '' }).profile, PROFILE_NAME)
})

test('parseManageParams trims the action', () => {
  assert.equal(parseManageParams({ action: ' list ' }).action, 'list')
  assert.equal(parseManageParams({ action: ' toggle ', key: 'plugins/a.js', enable: true }).key, 'plugins/a.js')
})

test('parseManageParams reads a toggle', () => {
  const params = { action: 'toggle', profile: PROFILE_NAME, key: 'plugins/my-plugin.js', enable: true }
  assert.deepEqual(parseManageParams(params), {
    action: 'toggle',
    profile: PROFILE_NAME,
    key: 'plugins/my-plugin.js',
    enable: true,
  })
  assert.equal(parseManageParams({ action: 'toggle', key: 'plugins/my-plugin.js', enable: false }).enable, false)
})

test('parseManageParams reads a toggle key from name', () => {
  assert.equal(
    parseManageParams({ action: 'toggle', name: 'plugins/my-plugin.js', enable: true }).key,
    'plugins/my-plugin.js',
  )
})

test('parseManageParams reads an install without a key', () => {
  assert.deepEqual(parseManageParams({ action: 'install', name: '@acme/dsh-plugin' }), {
    action: 'install',
    profile: PROFILE_NAME,
    key: '',
    enable: false,
  })
  assert.equal(parseManageParams({ action: 'install', name: '@acme/dsh-plugin', enable: true }).enable, true)
})

test('parseManageParams reads the actions the dispatcher refuses', () => {
  for (const action of ['remove', 'update', 'settings']) {
    assert.equal(parseManageParams({ action, key: 'plugins/my-plugin.js' }).key, 'plugins/my-plugin.js')
  }
})

test('parseManageParams refuses an unknown action with 4021', () => {
  const error = errorOf(() => parseManageParams({ action: 'explode' }))
  assert.equal(error.rpcCode, PLUGIN_CODES.invalidParams)
  assert.match(error.message, /explode/)
})

test('parseManageParams refuses a missing action with 4021', () => {
  assert.equal(errorOf(() => parseManageParams({})).rpcCode, PLUGIN_CODES.invalidParams)
  assert.equal(errorOf(() => parseManageParams(undefined)).rpcCode, PLUGIN_CODES.invalidParams)
  assert.equal(errorOf(() => parseManageParams(null)).rpcCode, PLUGIN_CODES.invalidParams)
  assert.equal(errorOf(() => parseManageParams('list')).rpcCode, PLUGIN_CODES.invalidParams)
})

test('parseManageParams refuses a keyed action without a key with 4021', () => {
  for (const action of ['toggle', 'remove', 'update', 'settings']) {
    const error = errorOf(() => parseManageParams({ action, enable: true }))
    assert.equal(error.rpcCode, PLUGIN_CODES.invalidParams)
  }
  const empty = errorOf(() => parseManageParams({ action: 'toggle', key: '', enable: true }))
  assert.equal(empty.rpcCode, PLUGIN_CODES.invalidParams)
})

test('parseManageParams refuses a non-boolean enable with 4021 and never coerces', () => {
  for (const enable of ['true', 'false', 1, 0, null, undefined, {}]) {
    const error = errorOf(() => parseManageParams({ action: 'toggle', key: 'plugins/my-plugin.js', enable }))
    assert.equal(error.rpcCode, PLUGIN_CODES.invalidParams)
  }
})

test('parseManageParams refuses a Profile the host does not have with 4064', () => {
  const error = errorOf(() => parseManageParams({ action: 'list', profile: 'work' }))
  assert.equal(error.rpcCode, PLUGIN_CODES.unknownProfile)
  assert.match(error.message, new RegExp(PROFILE_NAME))
  assert.match(error.message, /work/)
})

test('pluginError carries the JSON-RPC code the socket answers with', () => {
  const error = pluginError(PLUGIN_CODES.refused, 'Plugin management is read-only here')
  assert.equal(error.rpcCode, PLUGIN_CODES.refused)
  assert.equal(error.message, 'Plugin management is read-only here')
})
