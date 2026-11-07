/**
 * Client-facing session ids for the gateway.
 *
 * Hermex opens a session the moment a new chat attaches, before the user has
 * picked a folder or sent anything. DSH cannot change a session's cwd once it is
 * created (its workspace membership is validated against the creation cwd), so
 * the gateway keeps a chat's id as a local draft and only creates the DSH
 * session when the first prompt goes out, in the folder the composer picked.
 * Every call for that id resolves to the real session, while every frame sent to
 * the phone keeps the draft id it already holds.
 *
 * @module dsh-hermes-facade/src/hermes/sessions
 */

import { randomUUID } from 'node:crypto'

/**
 * Create the registry.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {object} [options.logger] logger.
 * @returns {object} registry.
 */
export function createSessionRegistry({ backend, logger = console }) {
  /** client id -> {id, cwd?, title?, createdAt, backendId?} */
  const drafts = new Map()
  let counter = 0

  /**
   * Mint a draft id and remember what the composer picked.
   * @param {object} [input] draft fields.
   * @param {string} [input.cwd] working folder chosen at creation.
   * @returns {object} draft record.
   */
  function createDraft({ cwd } = {}) {
    const id = 'dsh-draft-' + (++counter) + '-' + randomUUID().slice(0, 8)
    const entry = {
      id,
      createdAt: Math.floor(Date.now() / 1000),
      backendId: undefined,
      ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
    }
    drafts.set(id, entry)
    return entry
  }

  /**
   * The draft behind an id, if any.
   * @param {string} id client id.
   * @returns {object|undefined} draft.
   */
  function draft(id) {
    return drafts.get(String(id))
  }

  /**
   * The DSH session an id maps to; a draft that was never promoted maps to itself.
   * @param {string} id client id.
   * @returns {string} backend session id.
   */
  function resolve(id) {
    const entry = drafts.get(String(id))
    return entry !== undefined && typeof entry.backendId === 'string' && entry.backendId.length > 0
      ? entry.backendId
      : String(id)
  }

  /**
   * Whether an id is a gateway draft (possibly already promoted).
   * @param {string} id client id.
   * @returns {boolean} draft.
   */
  function isDraft(id) {
    return drafts.has(String(id))
  }

  /**
   * Create the DSH session for a draft, in the folder the composer chose.
   * @param {string} id client id.
   * @returns {Promise<string>} backend session id.
   */
  async function promote(id) {
    const entry = drafts.get(String(id))
    if (entry === undefined) return String(id)
    if (typeof entry.backendId === 'string' && entry.backendId.length > 0) return entry.backendId
    const created = await backend.call('POST', '/api/session/new', {
      body: { ...(typeof entry.cwd === 'string' && entry.cwd.length > 0 ? { workspace: entry.cwd } : {}) },
    })
    const backendId = created.json?.session?.session_id
    if (created.status !== 200 || typeof backendId !== 'string' || backendId.length === 0) {
      throw new Error(String(created.json?.error ?? created.json?.detail ?? ('session create failed (HTTP ' + created.status + ')')))
    }
    entry.backendId = backendId
    if (typeof entry.title === 'string' && entry.title.length > 0) {
      await backend.call('POST', '/api/session/rename', { body: { session_id: backendId, title: entry.title } }).catch(() => {})
    }
    return backendId
  }

  /**
   * Remember a title for a draft that has not been promoted yet.
   * @param {string} id client id.
   * @param {string} title title.
   * @returns {void}
   */
  function noteTitle(id, title) {
    const entry = drafts.get(String(id))
    if (entry !== undefined) entry.title = title
  }

  /**
   * Forget a draft whose chat is gone.
   * @param {string} id client id.
   * @returns {void}
   */
  function forget(id) {
    drafts.delete(String(id))
  }

  return { createDraft, draft, resolve, isDraft, promote, noteTitle, forget }
}
