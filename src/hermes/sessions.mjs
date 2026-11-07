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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How long an unpromoted draft is kept across restarts. */
const DRAFT_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Read the persisted mappings.
 * @param {string|undefined} dir state directory.
 * @returns {object[]} draft records.
 */
function loadDrafts(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return []
  const path = join(dir, 'hermes-drafts.json')
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const rows = Array.isArray(parsed?.drafts) ? parsed.drafts : []
    const cutoff = Math.floor(Date.now() / 1000) - DRAFT_TTL_SECONDS
    return rows.filter(row => row !== null && typeof row === 'object' &&
      typeof row.id === 'string' && row.id.length > 0 &&
      (!Number.isFinite(row.createdAt) || row.createdAt >= cutoff))
  } catch { return [] }
}

/**
 * Write the mappings atomically.
 * @param {string|undefined} dir state directory.
 * @param {object[]} rows draft records.
 * @returns {void}
 */
function writeDrafts(dir, rows) {
  if (typeof dir !== 'string' || dir.length === 0) return
  const path = join(dir, 'hermes-drafts.json')
  const temporary = path + '.tmp'
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify({ version: 1, drafts: rows }) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  } catch { /* the mapping is a convenience, never a blocker */ }
}

/**
 * Create the registry.
 * @param {object} options options.
 * @param {object} options.backend facade client.
 * @param {string} [options.dir] state directory for persisted mappings.
 * @param {object} [options.logger] logger.
 * @returns {object} registry.
 */
export function createSessionRegistry({ backend, dir, logger = console }) {
  /** client id -> {id, cwd?, title?, createdAt, backendId?, model?, provider?, effort?} */
  const drafts = new Map()
  for (const row of loadDrafts(dir)) {
    if (Number.isFinite(row.createdAt)) drafts.set(row.id, { ...row })
  }
  let counter = drafts.size
  /** In-flight promotions by draft id, so concurrent submits share one creation. */
  const promotions = new Map()
  let saveTimer

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
    scheduleSave()
    return entry
  }

  /**
   * Persist the mapping shortly after a change, coalescing a burst.
   * @returns {void}
   */
  function scheduleSave() {
    // Writes are small and rare (a chat is created, moved, renamed or promoted
    // once), and a shutdown must not lose the mapping, so write through.
    writeDrafts(dir, [...drafts.values()])
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
   *
   * Two prompt.submit frames can arrive before either has promoted the draft;
   * both used to call `session/new` and create two DSH sessions, orphaning the
   * first message. The in-flight promise is shared per draft id, so concurrent
   * callers wait for the one creation and receive the same backend id.
   *
   * @param {string} id client id.
   * @returns {Promise<string>} backend session id.
   */
  async function promote(id) {
    const key = String(id)
    const entry = drafts.get(key)
    if (entry === undefined) return String(id)
    if (typeof entry.backendId === 'string' && entry.backendId.length > 0) return entry.backendId
    const inflight = promotions.get(key)
    if (inflight !== undefined) return inflight
    const creation = createDraftSession(entry)
    promotions.set(key, creation)
    try {
      return await creation
    } finally {
      promotions.delete(key)
    }
  }

  /**
   * Create the DSH session behind one draft and apply its composer picks.
   * @param {object} entry draft record.
   * @returns {Promise<string>} backend session id.
   */
  async function createDraftSession(entry) {
    const created = await backend.call('POST', '/api/session/new', {
      body: {
        ...(typeof entry.cwd === 'string' && entry.cwd.length > 0 ? { workspace: entry.cwd } : {}),
        ...(typeof entry.model === 'string' && entry.model.length > 0 ? { model: entry.model } : {}),
        ...(typeof entry.provider === 'string' && entry.provider.length > 0 ? { provider: entry.provider } : {}),
      },
    })
    const backendId = created.json?.session?.session_id
    if (created.status !== 200 || typeof backendId !== 'string' || backendId.length === 0) {
      throw new Error(String(created.json?.error ?? created.json?.detail ?? ('session create failed (HTTP ' + created.status + ')')))
    }
    entry.backendId = backendId
    scheduleSave()
    // The composer's picks are applied before the first turn, so it runs on them.
    if (typeof entry.effort === 'string' && entry.effort.length > 0) {
      await backend.call('POST', '/api/reasoning', {
        body: { session_id: backendId, effort: entry.effort },
      }).catch(() => {})
    }
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
    if (entry === undefined) return
    entry.title = title
    scheduleSave()
  }

  /**
   * Merge fields into a draft and persist the change (folder, model, effort).
   * @param {string} id client id.
   * @param {object} patch fields.
   * @returns {object|undefined} the draft.
   */
  function update(id, patch) {
    const entry = drafts.get(String(id))
    if (entry === undefined) return undefined
    Object.assign(entry, patch)
    scheduleSave()
    return entry
  }

  /**
   * Forget a draft whose chat is gone.
   * @param {string} id client id.
   * @returns {void}
   */
  function forget(id) {
    if (drafts.delete(String(id))) scheduleSave()
  }

  /**
   * Working folders the composer picked for drafts that have not been promoted.
   * The Files fence needs them: a new chat's folder is browsable before its
   * first message creates a DSH session.
   * @returns {string[]} folders.
   */
  function cwds() {
    const folders = []
    for (const entry of drafts.values()) {
      if (typeof entry.cwd === 'string' && entry.cwd.length > 0) folders.push(entry.cwd)
    }
    return folders
  }

  return { createDraft, draft, resolve, isDraft, promote, noteTitle, update, cwds, forget, save: scheduleSave }
}
