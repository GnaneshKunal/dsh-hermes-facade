/**
 * One path fence for every file surface the Hermes listener exposes.
 *
 * Hermex sends absolute host paths (its own check is explicitly not a security
 * boundary), so the listener must decide what a signed-in client may read. A
 * path is served only when its realpath is inside one of the roots the caller
 * names (DSH workspaces and the working folders of known sessions), and never
 * when it is inside the facade's state directory, a known secret directory, or
 * a credential file/credential-directory the host's own Files guard refuses.
 * Symlinks are resolved first, so a link cannot point out of a root.
 *
 * The sensitive-name and hidden-listing sets mirror `hermes_cli/web_routers/files.py`
 * (`_is_sensitive_filename`, `_is_sensitive_path`, `_FS_READDIR_HIDDEN`) so the
 * phone cannot exfiltrate a credential store that the real host would refuse.
 *
 * @module dsh-hermes-facade/src/hermes/fence
 */

import { realpath } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

/**
 * Entries the host hides from a directory listing (build/VCS caches).
 * @type {Set<string>}
 */
export const HIDDEN_LISTING_NAMES = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.turbo', '.venv', '__pycache__',
  'build', 'dist', 'node_modules', 'target', 'venv',
])

/** Credential-store basenames the host never reads. */
const SENSITIVE_FILE_NAMES = new Set([
  'auth.json', 'auth.lock', 'credentials', 'config.yaml',
  '.anthropic_oauth.json', 'google_token.json', 'google_oauth_pending.json',
  'google_oauth.json', 'webhook_subscriptions.json', '.git-credentials',
  // The host's secret-cache stores (Bitwarden/1Password caches, Photon sidecar token).
  'bws_cache.json', 'bws_cache.enc.json', 'op_cache.json', 'photon-sidecar.json',
])

/** Directory names whose whole subtree is credential material. */
const SENSITIVE_DIR_NAMES = new Set(['mcp-tokens', 'pairing', '.ssh', '.aws', '.gnupg', '.dsh'])

/**
 * Whether a path is a credential file or lives under a credential directory.
 *
 * Whole-path, case-insensitive, and evaluated on the realpath: `.ENV` on a
 * case-insensitive mount and `mcp-tokens/<server>.json` are both refused.
 * @param {string} value absolute path.
 * @returns {boolean} sensitive.
 */
export function isSensitivePath(value) {
  const file = basename(value).toLowerCase()
  if (file === '.env' || file.startsWith('.env.') || file === '.envrc') return true
  if (SENSITIVE_FILE_NAMES.has(file)) return true
  return value.split(sep).some((part) => SENSITIVE_DIR_NAMES.has(part.toLowerCase()))
}

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
   * @returns {Promise<{ok: true, path: string} | {ok: false, missing?: boolean, forbidden?: boolean, sensitive?: boolean}>} verdict.
   */
  async function check(target, allowedRoots) {
    const absolute = resolve(String(target))
    let real
    try { real = await realpath(absolute) } catch { return { ok: false, missing: true } }
    // Deny first: a workspace under a secret directory must not open it.
    for (const root of denied) {
      if (inside(real, await realOrResolved(root))) return { ok: false, forbidden: true }
    }
    // Credential material is refused wherever it sits, even inside a chat folder.
    if (isSensitivePath(real)) return { ok: false, forbidden: true, sensitive: true }
    for (const root of allowedRoots) {
      if (typeof root !== 'string' || root.length === 0) continue
      if (inside(real, await realOrResolved(root))) return { ok: true, path: real }
    }
    return { ok: false, forbidden: true }
  }

  /**
   * Whether a real path is inside a directory that is never served.
   * Used by surfaces whose boundary is broader than a chat folder (a Git
   * repository root above the folder) before they admit it.
   * @param {string} target absolute path.
   * @returns {Promise<boolean>} denied.
   */
  async function isDenied(target) {
    const resolved = await realOrResolved(target)
    for (const root of denied) {
      if (inside(resolved, await realOrResolved(root))) return true
    }
    return false
  }

  return { check, isDenied }
}
