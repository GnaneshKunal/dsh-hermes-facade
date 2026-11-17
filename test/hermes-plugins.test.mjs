import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseManageParams,
  PLUGIN_CODES,
  pluginError,
  pluginRowOf,
  pluginsBodyOf,
  toggleReplyOf,
  updateReplyOf,
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

/** One enabled bundle the profile declares, with a registry update to offer. */
const USER_BUNDLE = {
  name: '@acme/dsh-terminal',
  official: false,
  availability: 'profile',
  installTarget: { spec: '@acme/dsh-terminal', version: '1.2.0' },
  version: '1.2.0',
  meta: { title: 'Acme Terminal', description: 'Runs commands on the host' },
  enabled: true,
  installed: true,
  optional: true,
  removable: true,
  update: 'registry',
  rows: [],
  overrides: [],
}

/** One bundle the installation ships, so the profile does not own it. */
const SHIPPED_BUNDLE = {
  name: '@deepseek-ai/dsh-agent',
  official: true,
  availability: 'installation',
  meta: { title: 'Agent' },
  enabled: false,
  installed: true,
  optional: false,
  removable: false,
  readOnlyReason: 'management-required',
  rows: [],
  overrides: [],
}

/** One git-pinned bundle whose install target carries its version. */
const GIT_BUNDLE = {
  name: '@acme/dsh-git-pinned',
  official: false,
  availability: 'profile',
  installTarget: { spec: 'github:acme/dsh-git-pinned#abc123', version: '0.9.0' },
  enabled: false,
  installed: true,
  optional: true,
  removable: true,
  update: 'git',
  rows: [],
  overrides: [],
}

test('PLUGIN_CODES pins the codes the Plugins screen decodes', () => {
  assert.deepEqual(PLUGIN_CODES, { unknownProfile: 4064, invalidParams: 4021, missing: 4020, refused: 5026 })
})

test('pluginRowOf maps a full BundleInfo onto the row Hermex decodes', () => {
  assert.deepEqual(pluginRowOf(USER_BUNDLE), {
    key: '@acme/dsh-terminal',
    name: 'Acme Terminal',
    version: '1.2.0',
    description: 'Runs commands on the host',
    source: 'user',
    status: 'enabled',
    update_available: true,
    settings_schema: [],
  })
})

test('pluginRowOf reads a string title', () => {
  assert.equal(pluginRowOf(SHIPPED_BUNDLE).name, 'Agent')
})

test('pluginRowOf reads a localized title and description object', () => {
  const row = pluginRowOf({
    ...USER_BUNDLE,
    meta: {
      title: { en: 'Terminal Tools', de: 'Terminalwerkzeuge' },
      description: { en: 'Runs commands', de: 'Fuehrt Befehle aus' },
    },
  })
  assert.equal(row.name, 'Terminal Tools')
  assert.equal(row.description, 'Runs commands')
})

test('pluginRowOf falls back to the package name and manifest description', () => {
  const row = pluginRowOf({
    ...USER_BUNDLE,
    meta: { title: { de: 'Nur Deutsch' } },
    description: 'Package manifest text',
  })
  assert.equal(row.name, '@acme/dsh-terminal')
  assert.equal(row.description, 'Package manifest text')
})

test('pluginRowOf flattens a multiline description to one line', () => {
  const localizedRow = pluginRowOf({ ...USER_BUNDLE, meta: { description: '  Runs\n\ncommands\t\twith   care  ' } })
  assert.equal(localizedRow.description, 'Runs commands with care')
  const manifestRow = pluginRowOf({
    ...SHIPPED_BUNDLE,
    meta: undefined,
    description: 'Runs\ncommands\twith   care',
  })
  assert.equal(manifestRow.description, 'Runs commands with care')
})

test('pluginRowOf falls back to the package name when meta is missing', () => {
  assert.deepEqual(pluginRowOf({ ...SHIPPED_BUNDLE, meta: undefined }), {
    key: '@deepseek-ai/dsh-agent',
    name: '@deepseek-ai/dsh-agent',
    version: '',
    description: '',
    source: 'bundled',
    status: 'disabled',
    update_available: false,
    settings_schema: [],
  })
})

test('pluginRowOf marks a profile bundle as user and everything else as bundled', () => {
  assert.equal(pluginRowOf(USER_BUNDLE).source, 'user')
  assert.equal(pluginRowOf(SHIPPED_BUNDLE).source, 'bundled')
  assert.equal(pluginRowOf({ ...USER_BUNDLE, availability: 'missing' }).source, 'bundled')
  assert.equal(pluginRowOf({ ...USER_BUNDLE, availability: undefined }).source, 'bundled')
})

test('pluginRowOf reads anything but true as disabled', () => {
  assert.equal(pluginRowOf({ ...USER_BUNDLE, enabled: undefined }).status, 'disabled')
  assert.equal(pluginRowOf({ ...USER_BUNDLE, enabled: 'yes' }).status, 'disabled')
  assert.equal(pluginRowOf({ ...USER_BUNDLE, enabled: null }).status, 'disabled')
  assert.equal(pluginRowOf(SHIPPED_BUNDLE).status, 'disabled')
})

test('pluginRowOf offers an update only when the host can replace the bundle', () => {
  assert.equal(pluginRowOf(USER_BUNDLE).update_available, true)
  assert.equal(pluginRowOf(GIT_BUNDLE).update_available, true, 'a git-pinned bundle updates to another commit')
  assert.equal(pluginRowOf(SHIPPED_BUNDLE).update_available, false)
  assert.equal(pluginRowOf({ ...USER_BUNDLE, update: undefined }).update_available, false)
})

test('pluginRowOf falls back to the install target version', () => {
  assert.equal(pluginRowOf(GIT_BUNDLE).version, '0.9.0')
  assert.equal(pluginRowOf({ ...GIT_BUNDLE, installTarget: undefined }).version, '')
  assert.equal(pluginRowOf(SHIPPED_BUNDLE).version, '')
})

test('pluginRowOf drops a bundle that has no name', () => {
  assert.equal(pluginRowOf({}), null)
  assert.equal(pluginRowOf({ name: '' }), null)
  assert.equal(pluginRowOf(undefined), null)
  assert.equal(pluginRowOf(null), null)
})

test('pluginsBodyOf keeps order, drops unnamed bundles and counts sources', () => {
  const body = pluginsBodyOf([USER_BUNDLE, SHIPPED_BUNDLE, { enabled: true }])
  assert.deepEqual(body, {
    plugins: [
      {
        key: '@acme/dsh-terminal',
        name: 'Acme Terminal',
        version: '1.2.0',
        description: 'Runs commands on the host',
        source: 'user',
        status: 'enabled',
        update_available: true,
        settings_schema: [],
      },
      {
        key: '@deepseek-ai/dsh-agent',
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
  const body = pluginsBodyOf([USER_BUNDLE, SHIPPED_BUNDLE, SHIPPED_BUNDLE])
  assert.equal(typeof body.user_count, 'number')
  assert.equal(typeof body.bundled_count, 'number')
  assert.equal(body.user_count, 1)
  assert.equal(body.bundled_count, 2)
})

test('pluginsBodyOf treats a non-array argument as empty', () => {
  assert.deepEqual(pluginsBodyOf(undefined), { plugins: [], user_count: 0, bundled_count: 0 })
  assert.deepEqual(pluginsBodyOf(null), { plugins: [], user_count: 0, bundled_count: 0 })
  assert.deepEqual(pluginsBodyOf({ bundles: [USER_BUNDLE] }), { plugins: [], user_count: 0, bundled_count: 0 })
})

test('toggleReplyOf reports an applied toggle', () => {
  const row = pluginRowOf(USER_BUNDLE)
  const change = {
    changed: true,
    application: 'applied',
    stage: 'enable',
    target: '@acme/dsh-terminal',
    enabled: true,
  }
  assert.deepEqual(toggleReplyOf(change, row), {
    ok: true,
    unchanged: false,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: '@acme/dsh-terminal',
    plugin: row,
  })
})

test('toggleReplyOf reports a restart-required toggle', () => {
  const row = pluginRowOf(USER_BUNDLE)
  const change = {
    changed: true,
    application: 'restart-required',
    restartReason: 'no-hmr',
    stage: 'enable',
    target: '@acme/dsh-terminal',
    enabled: true,
  }
  assert.deepEqual(toggleReplyOf(change, row), {
    ok: true,
    unchanged: false,
    restart_required: true,
    gateway_reloaded: false,
    activation: {},
    name: '@acme/dsh-terminal',
    plugin: row,
  })
})

test('toggleReplyOf never reports an overridden toggle as applied', () => {
  const row = pluginRowOf(USER_BUNDLE)
  assert.deepEqual(toggleReplyOf({ application: 'overridden', target: '@acme/dsh-terminal' }, row), {
    ok: false,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: '@acme/dsh-terminal',
    plugin: row,
  })
})

test('toggleReplyOf reports a failed toggle as not ok', () => {
  const change = {
    changed: false,
    application: 'failed',
    stage: 'enable',
    target: '@acme/dsh-terminal',
    error: { code: 'operation-error' },
  }
  assert.deepEqual(toggleReplyOf(change, null), {
    ok: false,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: '@acme/dsh-terminal',
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
  const row = pluginRowOf(SHIPPED_BUNDLE)
  assert.equal(toggleReplyOf({ application: 'applied' }, row).plugin, row)
  assert.equal(toggleReplyOf({ application: 'applied' }, row).name, '@deepseek-ai/dsh-agent')
})

test('updateReplyOf reports an update that needs a restart', () => {
  const row = pluginRowOf({ ...USER_BUNDLE, version: '1.3.0' })
  const update = {
    from: '1.2.0',
    to: '1.3.0',
    step: 'install',
    result: {
      changed: true,
      application: 'restart-required',
      restartReason: 'no-hmr',
      stage: 'install',
      target: '@acme/dsh-terminal',
      enabled: true,
    },
    restore: { changed: false, application: 'applied', stage: 'restore', target: '@acme/dsh-terminal' },
  }
  assert.deepEqual(updateReplyOf(update, row), {
    ok: true,
    unchanged: false,
    restart_required: true,
    gateway_reloaded: false,
    activation: {},
    name: '@acme/dsh-terminal',
    plugin: row,
  })
})

test('updateReplyOf reports an applied update without a restart', () => {
  const row = pluginRowOf({ ...USER_BUNDLE, version: '1.3.0' })
  const reply = updateReplyOf({
    from: '1.2.0',
    to: '1.3.0',
    step: 'install',
    result: { changed: true, application: 'applied', stage: 'install', target: '@acme/dsh-terminal', enabled: true },
  }, row)
  assert.equal(reply.ok, true)
  assert.equal(reply.unchanged, false)
  assert.equal(reply.restart_required, false)
  assert.equal(reply.plugin, row)
})

test('updateReplyOf answers ok and unchanged when nothing newer was offered', () => {
  const row = pluginRowOf(SHIPPED_BUNDLE)
  assert.deepEqual(updateReplyOf(undefined, row), {
    ok: true,
    unchanged: true,
    restart_required: false,
    gateway_reloaded: false,
    activation: {},
    name: '@deepseek-ai/dsh-agent',
    plugin: row,
  })
  assert.equal(updateReplyOf(undefined, row).plugin, row, 'the app keeps the row it already has')
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
  assert.equal(parseManageParams({ action: ' toggle ', key: '@acme/dsh-terminal', enable: true }).key, '@acme/dsh-terminal')
})

test('parseManageParams reads a toggle', () => {
  const params = { action: 'toggle', profile: PROFILE_NAME, key: '@acme/dsh-terminal', enable: true }
  assert.deepEqual(parseManageParams(params), {
    action: 'toggle',
    profile: PROFILE_NAME,
    key: '@acme/dsh-terminal',
    enable: true,
  })
  assert.equal(parseManageParams({ action: 'toggle', key: '@acme/dsh-terminal', enable: false }).enable, false)
})

test('parseManageParams reads a toggle key from name', () => {
  assert.equal(
    parseManageParams({ action: 'toggle', name: '@acme/dsh-terminal', enable: true }).key,
    '@acme/dsh-terminal',
  )
})

test('parseManageParams reads an update without an enable flag', () => {
  assert.deepEqual(parseManageParams({ action: 'update', key: '@acme/dsh-terminal' }), {
    action: 'update',
    profile: PROFILE_NAME,
    key: '@acme/dsh-terminal',
    enable: false,
  })
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
  for (const action of ['remove', 'settings']) {
    assert.equal(parseManageParams({ action, key: '@acme/dsh-terminal' }).key, '@acme/dsh-terminal')
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
    const error = errorOf(() => parseManageParams({ action: 'toggle', key: '@acme/dsh-terminal', enable }))
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
