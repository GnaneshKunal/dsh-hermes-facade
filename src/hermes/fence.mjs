/**
 * One path fence for every file surface the Hermes listener exposes.
 *
 * Hermex sends absolute host paths (its own check is explicitly not a security
 * boundary), so the listener must decide what a signed-in client may read. A
 * path is served only when its realpath is inside one of the roots the caller
 * names (the DSH workspaces and the working folders of known sessions), and
 * never when it is inside the facade's state directory or a known secret
 * directory. Symlinks are resolved first, so a link cannot point out of a root.
 *
 * @module dsh-hermes-facade/src/hermes/fence
 */

import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/**
 * Whether `child` is `parent` or lives below it.
 * @param {string} child absolute path.
 * @param {string} parent absolute path.
 * @returns {boolean} inside.
 */
function inside(child, parent) {
  if (child === parent) return true
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/**
 * Realpath a root once, falling back to the plain absolute path when it does
 * not exist (a root that vanished must not fail the whole request).
 * @param {string} value path.
 * @returns {Promise<string>} resolved path.
 */
async function realOrResolved(value) {
  try { return await realpath(value) } catch { return resolve(value) }
}

/**
 * Create the fence.
 * @param {object} options options.
 * @param {string[]} [options.deny] directories that are never served.
 * @returns {{check: Function}} fence.
 */
export function createPathFence({ deny = [] } = {}) {
  const denied = deny.filter(value => typeof value === 'string' && value.length > 0)

  /**
   * Decide whether a client path may be served.
   * @param {string} target client-supplied path.
   * @param {string[]} allowedRoots directories the caller may read.
   * @returns {Promise<{ok: true, path: string} | {ok: false, missing?: boolean, forbidden?: boolean}>} verdict.
   */
  async function check(target, allowedRoots) {
    const absolute = resolve(String(target))
    let real
    try { real = await realpath(absolute) } catch { return { ok: false, missing: true } }
    // Deny first: a workspace under a secret directory must not open it.
    for (const root of denied) {
      if (inside(real, await realOrResolved(root))) return { ok: false, forbidden: true }
    }
    for (const root of allowedRoots) {
      if (typeof root !== 'string' || root.length === 0) continue
      if (inside(real, await realOrResolved(root))) return { ok: true, path: real }
    }
    return { ok: false, forbidden: true }
  }

  return { check }
}
