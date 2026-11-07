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
    /**
     * Append durable events to a session, for tests that need a long transcript
     * without running a turn for each message.
     * @param {string} sessionId session id.
     * @param {Array<object>} events events to append.
     * @returns {object} session record.
     */
    seed(sessionId, events = []) {
      const record = ensure(sessionId)
      for (const event of events) record.events.push(event)
      record.updatedAt = Date.now()
      return record
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
        default: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            reasoning: {
              efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }],
              defaultEffort: 'high',
            },
          }],
        }],
        failures: [],
      }
    },
    warm() {},
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
      // The real projection is {lastUsed, pending|next}; the flat shape is the
      // early-draft spelling this mock used to return.
      const projection = record?.projections?.values?.modelSelection
      return projection?.lastUsed ?? undefined
    },
    async selectModel({ sessionId, model, provider, reasoningEffort }) {
      const catalog = await this.models()
      const group = catalog.groups.find(entry => entry.id === (provider ?? catalog.default.provider))
        ?? catalog.groups.find(entry => entry.models.some(entryModel => entryModel.id === model))
      const entry = group?.models.find(candidate => candidate.id === model)
      if (entry === undefined) throw new Error('model "' + model + '" is not available in the model catalog')
      const record = ensure(sessionId)
      const selection = {
        provider: group.id,
        model: entry.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }
      record.projections = {
        values: {
          ...record.projections.values,
          modelSelection: { lastUsed: selection, pending: null },
        },
      }
      this.lastSelectedModel = selection
      return selection
    },
    async reasoning({ sessionId }) {
      const catalog = await this.models()
      const selection = sessionId ? await this.modelSelection(sessionId) : undefined
      const model = catalog.groups[0].models[0]
      const offered = model.reasoning.efforts.map(effort => effort.id)
      return {
        provider: selection?.provider ?? catalog.default.provider,
        model: selection?.model ?? catalog.default.model,
        effort: selection?.reasoningEffort ?? model.reasoning.defaultEffort,
        supportedEfforts: offered,
      }
    },
    async setReasoningEffort({ sessionId, effort }) {
      const record = ensure(sessionId)
      const state = await this.reasoning({ sessionId })
      const wanted = state.supportedEfforts.includes(effort)
        ? effort
        : { xhigh: 'max', none: 'off', minimal: 'low' }[effort]
      if (wanted === undefined || !state.supportedEfforts.includes(wanted)) {
        throw new Error('effort "' + effort + '" is not offered by ' + state.provider + '/' + state.model + '; use one of ' + state.supportedEfforts.join(', '))
      }
      record.projections = {
        values: {
          ...record.projections.values,
          modelSelection: {
            lastUsed: { provider: state.provider, model: state.model, reasoningEffort: wanted },
            pending: null,
          },
        },
      }
      return { ok: true, effort: wanted, provider: state.provider, model: state.model, supportedEfforts: state.supportedEfforts }
    },
    async listDir(sessionId, reference) {
      const { readdir, stat } = await import('node:fs/promises')
      const { basename, dirname, join } = await import('node:path')
      const target = await this.resolvePath(sessionId, reference)
      if (target === undefined) return undefined
      const dirents = await readdir(target, { withFileTypes: true }).catch(() => undefined)
      if (dirents === undefined) return undefined
      const entries = []
      for (const dirent of dirents) {
        const full = join(target, dirent.name)
        const stats = await stat(full).catch(() => undefined)
        entries.push({
          name: dirent.name,
          path: full,
          is_dir: dirent.isDirectory(),
          kind: dirent.isDirectory() ? 'dir' : 'file',
          ...(stats === undefined ? {} : { size: stats.size, modified: Math.floor(stats.mtimeMs / 1000) }),
        })
      }
      entries.sort((left, right) => (left.is_dir === right.is_dir ? left.name.localeCompare(right.name) : (left.is_dir ? -1 : 1)))
      return {
        path: target,
        name: basename(target) || target,
        parent: dirname(target),
        entries,
        dirs: entries.filter(entry => entry.is_dir).map(entry => entry.name),
        files: entries.filter(entry => !entry.is_dir).map(entry => entry.name),
        count: entries.length,
      }
    },
    async readText(sessionId, reference) {
      const { readFile } = await import('node:fs/promises')
      const { basename, extname } = await import('node:path')
      const target = await this.resolvePath(sessionId, reference)
      if (target === undefined) return undefined
      const body = await readFile(target).catch(() => undefined)
      if (body === undefined || body.includes(0)) return undefined
      const content = body.toString('utf8')
      return {
        content,
        path: target,
        name: basename(target),
        language: extname(target).replace(/^\./, '').toLowerCase(),
        size: body.length,
        lines: content.length === 0 ? 0 : content.split('\n').length,
      }
    },
    async resolvePath(sessionId, reference) {
      const { join } = await import('node:path')
      const raw = String(reference ?? '').trim()
      if (raw.startsWith('/')) return raw
      const cwd = sessions.get(sessionId)?.cwd ?? process.cwd()
      return raw.length === 0 ? cwd : join(cwd, raw)
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
