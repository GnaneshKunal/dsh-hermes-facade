/**
 * Pure conversions between DeepSeek Harness's plugin inventory and the
 * `plugins.manage` shapes Hermex 2.1.0 decodes for Settings → Server →
 * Plugins.
 *
 * Nothing here reads DSH state or touches the gateway: the dispatcher fetches
 * PluginInfo[] from the `pluginManager/listPlugins` Remote, maps it with
 * these functions, and hands a toggle's ChangeResult back through them. The
 * inventory carries no package version and DSH has no plugin settings form, so
 * both stay empty rather than being invented.
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

/** Every action `plugins.manage` can carry; the facade implements list and toggle. */
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
 * @param {string|object|undefined} value `PluginLocalizedMeta.description`.
 * @returns {string} one line, empty when the entry has no description.
 */
function descriptionOf(value) {
  const text = localized(value)
  return text === undefined ? '' : text.replace(/\s+/g, ' ').trim()
}

/**
 * One PluginInfo as the row Hermex decodes.
 *
 * A row with no `entryId` cannot be addressed by key, so it is dropped instead
 * of being listed as a plugin the screen could never toggle. Hermex has no
 * version or settings field for a plugin, so those stay empty.
 *
 * @param {object} info `pluginManager/listPlugins` entry.
 * @returns {object|null} row, or null when the entry cannot be addressed.
 */
export function pluginRowOf(info) {
  const key = String(info?.entryId ?? '')
  if (key.length === 0) return null
  const meta = info?.meta
  return {
    key,
    name: localized(meta?.title) || String(info?.moduleName ?? '') || key,
    version: '',
    description: descriptionOf(meta?.description),
    // Only a row the profile patch owns is writable by the user; the rest ship
    // with the installation and are read-only through `plugins.manage`.
    source: info?.patchId !== undefined ? 'user' : 'bundled',
    status: info?.enabled === true ? 'enabled' : 'disabled',
    update_available: false,
    // DSH has no per-plugin settings form, so the app renders no settings row.
    settings_schema: [],
  }
}

/**
 * The reply `plugins.manage` list sends.
 *
 * Rows keep the inventory's order, which is the Loader's composition order, and
 * both counts are always present so the screen can show its header either way.
 *
 * @param {Array<object>|unknown} infos `pluginManager/listPlugins` entries.
 * @returns {{plugins: object[], user_count: number, bundled_count: number}} reply.
 */
export function pluginsBodyOf(infos) {
  const plugins = []
  for (const info of Array.isArray(infos) ? infos : []) {
    const row = pluginRowOf(info)
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
 * @param {object|undefined} change `pluginManager/setPluginEnabled` result.
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
