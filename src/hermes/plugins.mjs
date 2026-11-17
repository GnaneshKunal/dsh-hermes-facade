/**
 * Pure conversions between DeepSeek Harness's plugin bundles and the
 * `plugins.manage` shapes Hermex 2.1.0 decodes for Settings → Server →
 * Plugins.
 *
 * Nothing here reads DSH state or touches the gateway: the dispatcher fetches
 * BundleInfo[] from the `pluginManager/listBundles` Remote, maps it with these
 * functions, and hands a toggle's ChangeResult and an update's
 * PluginUpdateResult back through them. A row is one plugin PACKAGE - name,
 * version, description, the thing the user installed - not one Loader
 * composition entry, so the screen never shows the host's internal wiring. DSH
 * has no per-plugin settings form, so `settings_schema` stays empty rather than
 * being invented.
 *
 * @module dsh-hermes-facade/src/hermes/plugins
 */

import { PROFILE_NAME } from './protocol.mjs'

/**
 * RPC codes the Hermex Plugins screen maps to a message: 4064 is a Profile the
 * host does not have, 4021 invalid params, 4020 a plugin it does not know, and
 * 5026 a refusal whose message the app shows verbatim.
 */
export const PLUGIN_CODES = Object.freeze({
  unknownProfile: 4064,
  invalidParams: 4021,
  missing: 4020,
  refused: 5026,
})

/** Every action `plugins.manage` can carry; the facade implements list, toggle and update. */
const ACTIONS = ['list', 'toggle', 'install', 'remove', 'update', 'settings']

/** Actions that name one plugin. */
const KEYED_ACTIONS = new Set(['toggle', 'remove', 'update', 'settings'])

/**
 * Build an RPC error with an explicit JSON-RPC code.
 * @param {number} code code.
 * @param {string} message message.
 * @returns {Error} error carrying `rpcCode`.
 */
export function pluginError(code, message) {
  const error = new Error(message)
  error.rpcCode = code
  return error
}

/**
 * Read one localizable meta field: the text itself, or its English entry.
 * @param {string|object|undefined} value `PluginLocalizedMeta` field.
 * @returns {string|undefined} display text.
 */
function localized(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  const english = value.en
  return typeof english === 'string' && english.length > 0 ? english : undefined
}

/**
 * Flatten a description to the single line the row carries.
 * @param {string|object|undefined} value localized meta text, or the package
 *   manifest's own `description`.
 * @returns {string} one line, empty when the bundle has no description.
 */
function descriptionOf(value) {
  const text = localized(value)
  return text === undefined ? '' : text.replace(/\s+/g, ' ').trim()
}

/**
 * One BundleInfo as the row Hermex decodes.
 *
 * A bundle with no `name` cannot be addressed by key, so it is dropped instead
 * of being listed as a plugin the screen could never toggle. The row's key is
 * the package name itself - the same string `setBundleEnabled`, `listVersions`
 * and `updateBundle` take.
 *
 * @param {object} bundle `pluginManager/listBundles` entry.
 * @returns {object|null} row, or null when the bundle cannot be addressed.
 */
export function pluginRowOf(bundle) {
  const key = String(bundle?.name ?? '')
  if (key.length === 0) return null
  const meta = bundle?.meta
  const listed = bundle?.version
  const installTarget = bundle?.installTarget?.version
  return {
    key,
    // A translated title wins; the package name is the honest fallback when the
    // manifest carries no display text.
    name: localized(meta?.title) || key,
    version: typeof listed === 'string' && listed.length > 0
      ? listed
      : (typeof installTarget === 'string' ? installTarget : ''),
    // The localized summary wins; the least fallback is the package manifest's
    // own untranslated description.
    description: descriptionOf(meta?.description) || descriptionOf(bundle?.description),
    // Only a bundle the profile declares is the user's own install; anything
    // else comes with the installation and is read-only through `plugins.manage`.
    source: bundle?.availability === 'profile' ? 'user' : 'bundled',
    status: bundle?.enabled === true ? 'enabled' : 'disabled',
    // `update` is how updateBundle can replace the bundle, and is absent
    // exactly when it cannot.
    update_available: bundle?.update === 'registry' || bundle?.update === 'git',
    // DSH has no per-plugin settings form, so the app renders no settings row.
    settings_schema: [],
  }
}

/**
 * The reply `plugins.manage` list sends.
 *
 * Rows keep the order the host listed the bundles in, and both counts are always
 * present so the screen can show its header either way. `user_count` counts the
 * user's own profile installs and `bundled_count` what the installation ships,
 * both read off each row's `source`.
 *
 * @param {Array<object>|unknown} bundles `pluginManager/listBundles` entries.
 * @returns {{plugins: object[], user_count: number, bundled_count: number}} reply.
 */
export function pluginsBodyOf(bundles) {
  const plugins = []
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    const row = pluginRowOf(bundle)
    if (row !== null) plugins.push(row)
  }
  let userCount = 0
  for (const row of plugins) if (row.source === 'user') userCount += 1
  return { plugins, user_count: userCount, bundled_count: plugins.length - userCount }
}

/**
 * The reply `plugins.manage` toggle sends for one ChangeResult.
 *
 * `activation` stays a bare object: the client reads `activation.deferred` and
 * `activation.live_now.mcp_servers`, and both absent mean "nothing deferred and
 * no failed server". `gateway_reloaded` is always false because a plugin
 * toggle never restarts this facade's gateway.
 *
 * A result with no `application` claims nothing beyond "not cancelled": the
 * dispatcher refuses a failed, cancelled or overridden change before it builds
 * this reply, so `ok` is only ever false for a host this facade cannot explain.
 *
 * @param {object|undefined} change `pluginManager/setBundleEnabled` result.
 * @param {object|null|undefined} row the row read back after the change, or
 *   null when that read failed - the client then takes its own read() fallback.
 * @returns {object} reply.
 */
export function toggleReplyOf(change, row) {
  const application = change?.application
  return {
    // `overridden` saved the patch while a higher-priority layer keeps the old
    // state, so it is not an applied toggle; the dispatcher refuses it first.
    ok: application !== 'failed' && application !== 'cancelled' && application !== 'overridden',
    unchanged: change?.changed !== true,
    restart_required: application === 'restart-required',
    gateway_reloaded: false,
    activation: {},
    name: row?.key ?? String(change?.target ?? ''),
    plugin: row ?? null,
  }
}

/**
 * The reply `plugins.manage` update sends for one PluginUpdateResult.
 *
 * An update answers with the same shape a toggle does because it changes the
 * same bundle: `unchanged` and `restart_required` describe the inner
 * ChangeResult of the step that ran. Nothing newer to install is not a failure -
 * the update simply did nothing - so an absent update answers ok + unchanged.
 *
 * @param {object|undefined} update `pluginManager/updateBundle` result, absent
 *   when no newer version was offered.
 * @param {object|null|undefined} row the row read back after the update, or
 *   null when that read failed - the client then takes its own read() fallback.
 * @returns {object} reply.
 */
export function updateReplyOf(update, row) {
  // An absent update means the registry offered nothing replaceable; the
  // default claims only "not changed", which is exactly that answer.
  return toggleReplyOf(update?.result ?? { changed: false, application: 'applied' }, row)
}

/**
 * Validate one `plugins.manage` request.
 *
 * Unknown actions and malformed arguments answer 4021, a Profile other than
 * this installation's answers 4064, and nothing is coerced: a toggle whose
 * `enable` is not a boolean is refused rather than guessed at.
 *
 * @param {object|undefined|null} params request params.
 * @returns {{action: string, profile: string, key: string, enable: boolean}} the request.
 */
export function parseManageParams(params) {
  const input = params !== null && typeof params === 'object' ? params : {}
  const action = String(input.action ?? '').trim()
  if (!ACTIONS.includes(action)) {
    throw pluginError(
      PLUGIN_CODES.invalidParams,
      'plugins.manage does not know the action "' + action +
        '"; expected list, toggle, install, remove, update or settings',
    )
  }
  const requested = input.profile
  const profile = requested === undefined || requested === null || requested === '' ? PROFILE_NAME : String(requested)
  if (profile !== PROFILE_NAME) {
    throw pluginError(
      PLUGIN_CODES.unknownProfile,
      'DeepSeek Harness has one Profile, "' + PROFILE_NAME + '", not "' + profile + '"',
    )
  }
  // The client sends a key for the four actions that address one listed row;
  // `install` names a catalog package instead, and the dispatcher refuses it
  // before that name would matter, so it carries no key here.
  const keyed = KEYED_ACTIONS.has(action)
  const key = keyed ? String(input.key ?? input.name ?? '') : ''
  if (keyed && key.length === 0) {
    throw pluginError(PLUGIN_CODES.invalidParams, 'plugins.manage ' + action + ' needs a plugin key')
  }
  if (action === 'toggle' && typeof input.enable !== 'boolean') {
    throw pluginError(PLUGIN_CODES.invalidParams, 'plugins.manage toggle needs enable as true or false')
  }
  return { action, profile, key, enable: input.enable === true }
}
