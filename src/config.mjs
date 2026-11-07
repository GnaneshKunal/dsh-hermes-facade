/**
 * Facade configuration: defaults and on-disk secrets.
 *
 * @module dsh-hermes-facade/src/config
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Default loopback port. */
export const DEFAULT_PORT = 9120

/** Default bind address; loopback only. */
export const DEFAULT_BIND = '127.0.0.1'

/** Default loopback port for the Hermes-protocol (gateway) listener. */
export const DEFAULT_GATEWAY_PORT = 9121

/**
 * Resolve the facade state directory.
 * @param {string} [override] explicit directory.
 * @returns {string} absolute path.
 */
export function stateDir(override) {
  if (typeof override === 'string' && override.length > 0) return override
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'hermes-facade')
}

/**
 * Normalise plugin config.
 * @param {object} [raw] patch-row config.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw = {}) {
  const port = Number.isSafeInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT
  const bindHost = typeof raw.bindHost === 'string' && raw.bindHost.length > 0 ? raw.bindHost : DEFAULT_BIND
  const dir = stateDir(raw.dir)
  // Never inherit a widened bindHost here: setting bindHost to 0.0.0.0 (or a LAN
  // address) for the webui listener must not also publish the Hermes listener.
  // It takes an explicit gatewayBindHost to widen it.
  const gatewayBindHost = typeof raw.gatewayBindHost === 'string' && raw.gatewayBindHost.length > 0
    ? raw.gatewayBindHost
    : DEFAULT_BIND
  const lanHost = raw.lanHost === 'auto'
    ? 'auto'
    : (typeof raw.lanHost === 'string' && raw.lanHost.length > 0 ? raw.lanHost : undefined)
  // The Hermes listener follows the webui listener's LAN policy unless it says
  // otherwise: with lanHost: auto (or a host), it is widened the same way.
  // gatewayLanHost: 'off' forces loopback-only again.
  const gatewayLanHostRaw = raw.gatewayLanHost
  const gatewayLanHost = gatewayLanHostRaw === 'auto'
    ? 'auto'
    : (typeof gatewayLanHostRaw === 'string' && gatewayLanHostRaw.length > 0
      ? (gatewayLanHostRaw === 'off' ? undefined : gatewayLanHostRaw)
      : lanHost)
  return {
    enabled: raw.enabled !== false,
    port,
    bindHost,
    dir,
    // Hermes-protocol listener: a second, independent port for Hermex 2.x hosts.
    // Disabled with gatewayEnabled:false; the webui listener is unaffected either way.
    gatewayEnabled: raw.gatewayEnabled !== false,
    gatewayPort: Number.isSafeInteger(raw.gatewayPort) && raw.gatewayPort > 0 && raw.gatewayPort < 65536
      ? raw.gatewayPort
      : DEFAULT_GATEWAY_PORT,
    gatewayBindHost,
    // "auto" (or a host) also binds every non-loopback IPv4 for the Hermes
    // listener; it inherits lanHost unless set, and 'off' forces loopback-only.
    gatewayLanHost,
    // Shared secret the two listeners use to talk to each other over loopback.
    // Never leaves the machine: the gateway forwards to the facade with it
    // instead of replaying the phone's cookie.
    internalToken: ensureSecret(join(dir, 'internal.token')),
    tokenTtlSeconds: Number.isSafeInteger(raw.tokenTtlSeconds) && raw.tokenTtlSeconds > 0
      ? raw.tokenTtlSeconds
      : 30 * 24 * 60 * 60,
    logRequests: raw.logRequests === true,
    // "auto" binds every non-loopback IPv4 (Wi-Fi LAN and Tailscale) in
    // addition to the configured bind host. A string binds exactly that one.
    defaultWorkspace: typeof raw.defaultWorkspace === 'string' && raw.defaultWorkspace.length > 0
      ? raw.defaultWorkspace
      : undefined,
    // Transcript window: how many recent display messages are read from the host
    // and how large the first page is. Hermex asks for 50 then pages backwards;
    // a bigger window makes old chats open complete and lets the facade answer
    // scroll-back requests without a second host read per page.
    historyWindow: Number.isSafeInteger(raw.historyWindow) && raw.historyWindow >= 50
      ? raw.historyWindow
      : 800,
    historyPage: Number.isSafeInteger(raw.historyPage) && raw.historyPage > 0
      ? raw.historyPage
      : 200,
    // How long a finished chat stream stays replayable. The journal is pruned
    // when the next stream finishes; leaving this unset keeps the 30-minute
    // default. 0 drops a finished journal as soon as its turn ends.
    streamRetainMs: Number.isSafeInteger(raw.streamRetainMs) && raw.streamRetainMs >= 0
      ? raw.streamRetainMs
      : undefined,
    lanHost,
  }
}

/**
 * Read a file if it exists.
 * @param {string} path path.
 * @returns {string|undefined} contents.
 */
export function readOptional(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * Ensure a 0600 random hex secret exists.
 * @param {string} path secret path.
 * @returns {string} secret.
 */
export function ensureSecret(path) {
  const existing = readOptional(path)
  if (typeof existing === 'string' && existing.trim().length >= 32) return existing.trim()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString('hex')
  writeFileSync(path, secret + '\n', { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
  return secret
}