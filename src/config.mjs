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
  return {
    enabled: raw.enabled !== false,
    port,
    bindHost,
    dir: stateDir(raw.dir),
    tokenTtlSeconds: Number.isSafeInteger(raw.tokenTtlSeconds) && raw.tokenTtlSeconds > 0
      ? raw.tokenTtlSeconds
      : 30 * 24 * 60 * 60,
    logRequests: raw.logRequests === true,
    // "auto" binds every non-loopback IPv4 (Wi-Fi LAN and Tailscale) in
    // addition to the configured bind host. A string binds exactly that one.
    lanHost: raw.lanHost === 'auto'
      ? 'auto'
      : (typeof raw.lanHost === 'string' && raw.lanHost.length > 0 ? raw.lanHost : undefined),
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
