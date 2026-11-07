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
 * @module dsh-hermes-facade/src/hermes/files
 */

import { stat } from 'node:fs/promises'

/** Most text a preview returns, matching the host's 512 KiB cap. */
const PREVIEW_BYTES = 512 * 1024

/**
 * Build the Files routes.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} options.fence shared path fence.
 * @param {() => Promise<string[]>} options.rootsOf directories a client may read.
 * @returns {object} routes.
 */
export function createFileRoutes({ backend, fence, rootsOf }) {
  /**
   * Fence one path, mapping a verdict to the status the client understands.
   * @param {string} raw client path.
   * @returns {Promise<{path?: string, status?: number, detail?: string, missing?: boolean}>} target.
   */
  async function targetOf(raw) {
    const target = String(raw ?? '').trim()
    if (target.length === 0) return { status: 400, detail: 'path required' }
    // The app builds absolute host paths; a relative one has no session to
    // resolve against on this route, so refuse it instead of guessing.
    if (!target.startsWith('/')) return { status: 400, detail: 'path must be absolute' }
    const verdict = await fence.check(target, await rootsOf())
    if (verdict.ok === true) return { path: verdict.path }
    if (verdict.missing === true) return { status: 404, detail: 'Path not found' }
    return { status: 403, detail: 'Path is outside the session workspace' }
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
    return { status: 200, body: { entries } }
  }

  /**
   * A text preview, or the fact that the file is binary.
   * @param {URL} url request url.
   * @returns {Promise<object>} reply.
   */
  async function readText(url) {
    const target = await targetOf(url.searchParams.get('path'))
    if (target.path === undefined) return { status: target.status, body: { detail: target.detail } }
    const reply = await backend.call('GET', '/api/file', { query: { path: target.path } })
    if (reply.status === 200) {
      const file = reply.json ?? {}
      const content = typeof file.content === 'string' ? file.content : ''
      const bytes = Buffer.from(content)
      const truncated = bytes.length > PREVIEW_BYTES
      const text = truncated ? bytes.subarray(0, PREVIEW_BYTES).toString('utf8') : content
      return {
        status: 200,
        body: {
          binary: false,
          byteSize: Number.isSafeInteger(file.size) ? file.size : bytes.length,
          language: typeof file.language === 'string' ? file.language : '',
          path: target.path,
          text,
          truncated,
        },
      }
    }
    // The facade answers 404 for a binary file and for a missing one. The fence
    // admitted the path, so `stat` tells them apart without reading bytes here.
    let info
    try { info = await stat(target.path) } catch { return { status: 404, body: { detail: 'File not found' } } }
    if (info.isFile() !== true) return { status: 400, body: { detail: 'Path points to a directory' } }
    return { status: 200, body: { binary: true, byteSize: info.size, language: '', path: target.path, truncated: false } }
  }

  /**
   * The file's bytes, for Quick Look, Save to Files and media playback.
   * @param {URL} url request url.
   * @returns {Promise<object>} reply with `bytes` when successful.
   */
  async function download(url) {
    const target = await targetOf(url.searchParams.get('path'))
    if (target.path === undefined) return { status: target.status, body: { detail: target.detail } }
    const sessionId = url.searchParams.get('session_id') ?? ''
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
