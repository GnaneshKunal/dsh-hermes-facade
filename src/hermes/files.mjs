/**
 * The in-chat Files surface on the Hermes listener.
 *
 * Hermex opens a workspace browser for a chat whose `session.info` names a
 * local working folder: `/api/fs/list`, `/api/fs/read-text` and
 * `/api/fs/download`. The facade already implements the same reads for the
 * Legacy webui browser, so these translate its payloads into the Hermes host's
 * shapes (camelCase `isDirectory`, `byteSize`, `binary`, `truncated`) after
 * the shared path fence has admitted the target.
 *
 * Size limits mirror the host: a text source over 64 MiB is 413, a preview
 * reads only the first 512 KiB (the facade's `max_bytes`), and a download over
 * the same 64 MiB cap is refused instead of buffered whole.
 *
 * @module dsh-hermes-facade/src/hermes/files
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { HIDDEN_LISTING_NAMES, isSensitivePath } from './fence.mjs'

/** Most text a preview returns, matching the host's 512 KiB cap. */
const PREVIEW_BYTES = 512 * 1024
/** Largest source read-text/download accept, matching the host's 64 MiB cap. */
const SOURCE_MAX_BYTES = 64 * 1024 * 1024

/**
 * Build the Files routes.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.fence shared path fence.
 * @param {() => Promise<string[]>} options.rootsOf directories a client may read.
 * @param {(sessionId: string) => Promise<string|undefined>} options.cwdOf a session's folder.
 * @returns {object} routes.
 */
export function createFileRoutes({ backend, fence, rootsOf, cwdOf }) {
  /**
   * Fence one path, mapping a verdict to the status the client understands.
   * @param {string} raw client path.
   * @param {string} [sessionId] session whose folder resolves a relative path.
   * @returns {Promise<{path?: string, status?: number, detail?: string}>} target.
   */
  async function targetOf(raw, sessionId) {
    const target = String(raw ?? '').trim()
    if (target.length === 0) return { status: 400, detail: 'path required' }
    if (target.startsWith('attachment:')) {
      // The host resolves attachment references; DSH has no attachment store.
      return { status: 400, detail: 'attachment references are not supported' }
    }
    let candidate = target
    if (!target.startsWith('/')) {
      // A MEDIA path can be relative to the session; resolve it there, then
      // fence the absolute result so it cannot reach outside the chat folder.
      const cwd = sessionId === undefined || sessionId.length === 0 ? undefined : await cwdOf(sessionId)
      if (typeof cwd !== 'string' || cwd.length === 0) return { status: 400, detail: 'path must be absolute' }
      candidate = join(cwd, target)
    }
    const verdict = await fence.check(candidate, await rootsOf())
    if (verdict.ok === true) return { path: verdict.path }
    if (verdict.missing === true) return { status: 404, detail: 'File not found' }
    if (verdict.sensitive === true) return { status: 403, detail: 'Access to sensitive files is not allowed' }
    return { status: 403, detail: 'Path is outside the session workspace' }
  }

  /**
   * Stat a fenced path, mapping the host's regular-file refusals.
   * @param {string} path absolute path.
   * @returns {Promise<{info?: object, status?: number, detail?: string}>} inspection.
   */
  async function inspect(path) {
    let info
    try { info = await stat(path) } catch { return { status: 404, detail: 'File not found' } }
    if (info.isDirectory()) return { status: 400, detail: 'Path points to a directory' }
    if (!info.isFile()) return { status: 400, detail: 'Only regular files can be read' }
    return { info }
  }

  /**
   * One directory listing.
   * @param {URL} url request url.
   * @returns {Promise<object>} reply.
   */
  async function list(url) {
    const target = await targetOf(url.searchParams.get('path'))
    if (target.path === undefined) {
      // An unreadable folder is a well-formed empty listing on this host, not a
      // transport error: the client throws its folder-read failure on `error`.
      if (target.status === 404) return { status: 200, body: { entries: [], error: 'not_found' } }
      return { status: target.status, body: { detail: target.detail } }
    }
    const reply = await backend.call('GET', '/api/list', { query: { path: target.path } })
    if (reply.status !== 200) {
      return { status: 200, body: { entries: [], error: reply.status === 404 ? 'not_found' : 'unreadable' } }
    }
    const entries = (Array.isArray(reply.json?.entries) ? reply.json.entries : [])
      .map(entry => ({
        name: String(entry?.name ?? ''),
        path: String(entry?.path ?? ''),
        isDirectory: entry?.is_dir === true,
      }))
      .filter(entry => entry.name.length > 0)
      // The host hides build/VCS caches and credential stores from the browser;
      // an entry is still refused by the fence if its path is asked for.
      .filter(entry => !HIDDEN_LISTING_NAMES.has(entry.name))
      .filter(entry => !isSensitivePath(entry.path.length > 0 ? entry.path : join(target.path, entry.name)))
    return { status: 200, body: { entries } }
  }

  /**
   * A text preview, or the fact that the file is binary.
   * @param {URL} url request url.
   * @returns {Promise<object>} reply.
   */
  async function readText(url) {
    const target = await targetOf(url.searchParams.get('path'), url.searchParams.get('session_id') ?? '')
    if (target.path === undefined) return { status: target.status, body: { detail: target.detail } }
    const inspected = await inspect(target.path)
    if (inspected.info === undefined) return { status: inspected.status, body: { detail: inspected.detail } }
    if (inspected.info.size > SOURCE_MAX_BYTES) return { status: 413, body: { detail: 'File too large' } }
    // Ask for the preview window only, so a large log never lands in memory whole.
    const reply = await backend.call('GET', '/api/file', {
      query: { path: target.path, max_bytes: PREVIEW_BYTES },
    })
    if (reply.status === 200) {
      const file = reply.json ?? {}
      const content = typeof file.content === 'string' ? file.content : ''
      return {
        status: 200,
        body: {
          binary: false,
          byteSize: Number.isSafeInteger(file.size) ? file.size : inspected.info.size,
          language: typeof file.language === 'string' ? file.language : '',
          path: target.path,
          text: content,
          truncated: file.truncated === true,
        },
      }
    }
    // The facade answers 404 when the prefix is not text. The fence admitted the
    // path and `stat` says it is a regular file, so this is the binary case.
    return {
      status: 200,
      body: { binary: true, byteSize: inspected.info.size, language: '', path: target.path, truncated: false },
    }
  }

  /**
   * The file's bytes, for Quick Look, Save to Files and media playback.
   * @param {URL} url request url.
   * @returns {Promise<object>} reply with `bytes` when successful.
   */
  async function download(url) {
    const sessionId = url.searchParams.get('session_id') ?? ''
    const target = await targetOf(url.searchParams.get('path'), sessionId)
    if (target.path === undefined) return { status: target.status, body: { detail: target.detail } }
    const inspected = await inspect(target.path)
    if (inspected.info === undefined) return { status: inspected.status, body: { detail: inspected.detail } }
    if (inspected.info.size > SOURCE_MAX_BYTES) return { status: 413, body: { detail: 'File too large' } }
    const reply = await backend.download('/api/file/raw', {
      query: { path: target.path, ...(sessionId.length > 0 ? { session_id: sessionId } : {}) },
    })
    if (reply.status !== 200) {
      return { status: reply.status === 404 ? 404 : reply.status, body: { detail: 'File not found' } }
    }
    return {
      status: 200,
      headers: {
        'content-type': reply.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': reply.body.length,
        'cache-control': 'private, max-age=60',
      },
      bytes: reply.body,
    }
  }

  return { list, readText, download }
}
