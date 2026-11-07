/**
 * Append-only JSONL logs for the facade.
 *
 * Two files live in the facade state directory (~/.dsh/hermes-facade/):
 *
 *   access.log             one line per HTTP request, when logRequests is on
 *   unknown-endpoints.log  one line per request for an endpoint the facade does
 *                          not implement — always on, because "the app called
 *                          something we do not serve" is the diagnosis we need
 *                          most often and asking the user to flip a flag first
 *                          costs a restart and a lost reproduction.
 *
 * Logging must never break a request: every failure here is swallowed.
 *
 * @module dsh-hermes-facade/src/log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Rotate a log once it grows past this size; one previous generation is kept. */
export const DEFAULT_MAX_BYTES = 1024 * 1024

/** Longest string value kept for one field (body, query) before truncation. */
const MAX_FIELD_CHARS = 4000

/**
 * Truncate one value to a sane length for a log line.
 * @param {unknown} value any JSON value.
 * @param {number} [limit] character budget.
 * @returns {unknown} the value, or a truncated string.
 */
export function clip(value, limit = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') return value
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

/**
 * Create the facade's log writers.
 * @param {object} options options.
 * @param {string} options.dir state directory.
 * @param {{warn?: Function}} [options.logger] logger for console lines.
 * @param {boolean} [options.enabled] write access.log lines.
 * @param {number} [options.maxBytes] rotation threshold.
 * @returns {object} log facade.
 */
export function createRequestLog({ dir, logger = console, enabled = false, maxBytes = DEFAULT_MAX_BYTES }) {
  const accessPath = join(dir, 'access.log')
  const unknownPath = join(dir, 'unknown-endpoints.log')
  let prepared = false

  /**
   * Ensure the state directory exists.
   * @returns {boolean} whether writes can proceed.
   */
  function prepare() {
    if (prepared) return true
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      prepared = true
    } catch {
      prepared = false
    }
    return prepared
  }

  /**
   * Append one JSON line, rotating first when the file is already large.
   * @param {string} path file path.
   * @param {object} record payload.
   * @returns {void}
   */
  function write(path, record) {
    if (!prepare()) return
    try {
      const stats = statSync(path, { throwIfNoEntry: false })
      if (stats !== undefined && stats.size > maxBytes) renameSync(path, path + '.1')
    } catch { /* rotation is best effort */ }
    try {
      appendFileSync(path, JSON.stringify(record) + '\n')
    } catch { /* logging must never break a request */ }
  }

  return {
    accessPath,
    unknownPath,
    /** Whether access.log lines are being written. */
    enabled,
    /**
     * Record one finished HTTP request.
     * @param {object} record request summary.
     * @returns {void}
     */
    request(record) {
      if (!enabled) return
      write(accessPath, { at: new Date().toISOString(), ...record })
    },
    /**
     * Record one call to an endpoint the facade does not implement. Always on.
     * @param {object} record call summary.
     * @returns {void}
     */
    unknown(record) {
      const entry = { at: new Date().toISOString(), ...record }
      write(unknownPath, entry)
      try {
        logger.warn?.('hermes-facade: unknown endpoint ' + String(entry.method ?? '') + ' ' + String(entry.path ?? '') +
          (entry.kind === undefined ? '' : ' (' + String(entry.kind) + ')'))
      } catch { /* a broken logger must not break a request */ }
    },
  }
}
