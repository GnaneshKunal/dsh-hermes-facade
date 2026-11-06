#!/usr/bin/env node
/**
 * Run the facade outside dsh, against an in-memory mock agent.
 *
 * This exists to develop and test the wire contract without restarting the
 * host: the real host adapter can only load inside a running `dsh web`.
 *
 *   node scripts/standalone.mjs --port 9120
 *
 * The mock agent streams a canned reply token by token and can simulate an
 * approval with a POST to /mock/approval.
 *
 * @module dsh-hermes-facade/scripts/standalone
 */

import { createFacadeServer } from '../src/server.mjs'
import { resolveConfig } from '../src/config.mjs'

/**
 * Minimal async queue used by the mock follow stream.
 * @returns {object} queue.
 */
function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  return {
    push(item) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value: item, done: false })
      else items.push(item)
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => waiters.push(resolve))
        },
        return() { return Promise.resolve({ value: undefined, done: true }) },
      }
    },
  }
}

/**
 * Build an in-memory host that behaves like the DSH adapter.
 * @returns {object} mock host.
 */
export function createMockHost() {
  const sessions = new Map()
  const queues = new Map()
  const listeners = new Set()
  const pendingApprovals = new Map()
  let seq = 0

  /**
   * Notify interaction listeners.
   * @param {object} notice notice.
   * @returns {void}
   */
  function notify(notice) {
    for (const listener of listeners) listener(notice)
  }

  /**
   * Create a session record.
   * @param {string} [id] session id.
   * @returns {object} record.
   */
  function ensure(id) {
    const sessionId = id ?? 'sess-' + Math.random().toString(36).slice(2, 8)
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        updatedAt: Date.now(),
        running: false,
        cwd: process.cwd(),
        projections: { values: { title: 'Mock session' } },
        events: [],
      })
      queues.set(sessionId, createQueue())
    }
    return sessions.get(sessionId)
  }

  ensure('sess-mock')

  return {
    setClientPredicate() {},
    onInteraction(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async listSessions() { return [...sessions.values()] },
    async readSession(sessionId) {
      const record = sessions.get(sessionId)
      return { item: record, events: record ? record.events : [], projections: {} }
    },
    async ensureSession(sessionId, workspacePath, workspaceId) {
      this.lastEnsure = { sessionId, workspacePath, workspaceId }
      return ensure(sessionId).sessionId
    },
    async prompt({ sessionId, text }) {
      const record = ensure(sessionId)
      record.running = true
      record.updatedAt = Date.now()
      record.events.push({ type: 'user/message', seq: seq++, time: Date.now(), data: { content: [{ type: 'text', text }] } })
      const queue = queues.get(sessionId)
      const reply = 'Echo: ' + text
      setTimeout(() => {
        for (const word of reply.split(' ')) {
          queue.push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: word + ' ' } } })
        }
        queue.push({ type: 'event', event: { type: 'assistant/message', seq: seq++, time: Date.now(), data: { message: { content: [{ type: 'text', text: reply }] } } } })
        queue.push({ type: 'event', event: { type: 'turn/end', seq: seq++, time: Date.now(), data: { turn: 1, reason: { kind: 'stop' } } } })
        record.running = false
      }, 10)
      return { accepted: true }
    },
    async cancel(sessionId) { const record = sessions.get(sessionId); if (record) record.running = false },
    follow(sessionId) { return queues.get(sessionId) ?? createQueue() },
    async models() {
      // Mirrors the real ModelCatalog shape (groups/default), not a flat list.
      return {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }],
        failures: [],
      }
    },
    async commands() { return [] },
    async workspaces() {
      return { workspaces: [{ id: 'ws-mock', name: 'mock workspace', path: process.cwd(), sessionIds: ['sess-mock'] }] }
    },
    async workspaceIndex() {
      const { workspaces } = await this.workspaces()
      const index = new Map()
      for (const workspace of workspaces) for (const id of workspace.sessionIds) index.set(id, { id: workspace.id, name: workspace.name })
      return index
    },
    async renameSession({ sessionId, title }) {
      const record = sessions.get(sessionId)
      if (record) record.projections = { values: { ...record.projections.values, title } }
      return { ok: true }
    },
    async pinSession() { return { ok: true } },
    async archiveSession() { return { ok: true } },
    async forkSession({ sessionId }) {
      const created = ensure(undefined)
      created.projections = { values: { title: 'Fork of ' + ((sessions.get(sessionId)?.projections.values.title) ?? sessionId) } }
      return { ok: true, sessionId: created.sessionId }
    },
    async adoptSession({ sessionId, workspacePath }) {
      this.lastAdopt = { sessionId, workspacePath }
      return { ok: true, workspaceId: 'ws-mock' }
    },
    async modelSelection(sessionId) {
      const record = sessions.get(sessionId)
      const selection = record?.projections?.values?.modelSelection
      return selection ?? undefined
    },
    async setReasoningEffort({ sessionId, effort }) {
      const record = sessions.get(sessionId)
      if (record) {
        record.projections = { values: { ...record.projections.values, modelSelection: { ...(record.projections.values.modelSelection ?? {}), reasoningEffort: effort } } }
      }
      return { ok: true }
    },
    async readMedia(sessionId, reference) {
      const { readFile } = await import('node:fs/promises')
      const { extname } = await import('node:path')
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.md': 'text/plain; charset=utf-8' }
      try {
        const body = await readFile(String(reference))
        return { body, contentType: types[extname(String(reference)).toLowerCase()] ?? 'application/octet-stream' }
      } catch { return undefined }
    },
    pendingApproval(sessionId) { return pendingApprovals.get(sessionId) },
    pendingClarification() { return undefined },
    respondApproval({ approvalId, choice }) {
      const entry = [...pendingApprovals.entries()].find(([, value]) => value.approval_id === approvalId)
      if (!entry) return { ok: false }
      pendingApprovals.delete(entry[0])
      notify({ kind: 'approval-resolved', sessionId: entry[0] })
      console.log('mock: approval ' + approvalId + ' -> ' + choice)
      return { ok: true }
    },
    respondClarification() { return { ok: true } },
    dispose() {},
    /**
     * Simulate an agent asking for approval.
     * @param {string} sessionId session id.
     * @returns {object} pending payload.
     */
    simulateApproval(sessionId = 'sess-mock') {
      const pending = { approval_id: 'ap-' + Math.random().toString(36).slice(2, 8), command: 'bash', description: 'Run npm test' }
      pendingApprovals.set(sessionId, pending)
      notify({ kind: 'approval', sessionId, pending })
      return pending
    },
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('standalone.mjs')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg > 0 ? Number.parseInt(process.argv[portArg + 1], 10) : undefined
  const lan = process.argv.includes('--lan')
  const config = resolveConfig({ port, dir: process.env.HERMES_FACADE_DIR, lanHost: lan ? 'auto' : undefined })
  const host = createMockHost()
  const facade = createFacadeServer({ config, host })
  await facade.listen()
  for (const bound of facade.addresses ?? []) {
    console.log('hermes-facade (standalone, MOCK agent) on http://' + bound.host + ':' + bound.port)
  }
  if (facade.auth.generatedPassword) console.log('password: ' + facade.auth.generatedPassword)
  else console.log('password: (existing) see ' + facade.auth.passwordPath)
  const shutdown = async () => { await facade.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
