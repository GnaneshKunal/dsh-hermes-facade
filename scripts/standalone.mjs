#!/usr/bin/env node
/**
 * Run the facade outside dsh, against an in-memory mock agent.
 *
 * This exists to develop and test the wire contract without restarting the
 * host: the real host adapter can only load inside a running `dsh web`.
 *
 *   node scripts/standalone.mjs --port 9120
 *
 * The mock agent streams a canned reply token by token, an approval arrives
 * through the mock host's pending-approval switch, and `--turn-outcome failed`
 * (or `cancelled`) makes every turn end the way a real failure or Stop does.
 *
 * @module dsh-hermes-facade/scripts/standalone
 */

import { createFacadeServer } from '../src/server.mjs'
import { createGatewayServer } from '../src/hermes/server.mjs'
import { resolveConfig } from '../src/config.mjs'
import { approvalDecision } from '../src/host.mjs'

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
export function createMockHost({ cwd = process.cwd() } = {}) {
  const sessions = new Map()
  const queues = new Map()
  const listeners = new Set()
  let sessionUsageOverride
  const schedules = new Map()
  let scheduleSequence = 0
  /** Pending approvals keyed by the id the phone answers with, with display fields. */
  const pendingApprovals = new Map()
  // Registry-global visibility sets, mirroring the real workspace baseline.
  const pinned = new Set()
  const archived = new Set()
  /** Pending clarifications, same shape. */
  const pendingClarifications = new Map()
  /** Standing grants for the mock, mirroring src/host.mjs ("session"/"always"). */
  const sessionGrants = new Map()
  const alwaysGrants = new Set()
  let seq = 0
  /** How the next mocked turns end: 'completed', 'failed' or 'cancelled'. */
  let turnOutcome = 'completed'
  /** Every prompt the mock accepted, for assertions about images/files. */
  const promptLog = []
  /** Delay before a mocked reply streams, so a test can interleave. */
  let turnDelay = 10

  /**
   * Whether a standing grant answers this ask without a new card.
   * @param {string} sessionId session id.
   * @param {string} toolName tool name.
   * @returns {boolean} granted.
   */
  function granted(sessionId, toolName) {
    if (toolName.length === 0) return false
    if (alwaysGrants.has(toolName)) return true
    return sessionGrants.get(sessionId)?.has(toolName) === true
  }

  /**
   * Remember an "Allow session" / "Always allow" choice.
   * @param {string} sessionId session id.
   * @param {string} toolName tool name.
   * @param {string} scope session|always.
   * @returns {void}
   */
  function rememberGrant(sessionId, toolName, scope) {
    if (toolName.length === 0) return
    if (scope === 'always') {
      alwaysGrants.add(toolName)
      return
    }
    if (scope !== 'session') return
    const tools = sessionGrants.get(sessionId) ?? new Set()
    tools.add(toolName)
    sessionGrants.set(sessionId, tools)
  }

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
        cwd,
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
    async sessionUsage(sessionId) {
      if (!sessions.has(sessionId)) return {}
      if (sessionUsageOverride !== undefined) return sessionUsageOverride
      return { input_tokens: 1234, output_tokens: 56, context_length: 200000, last_prompt_tokens: 4321 }
    },
    setSessionUsage(values) { sessionUsageOverride = values },
    async usageReport(days = 30) {
      return {
        usage: {
          totals: { total_input: 1200, total_output: 300, total_cache_read: 100, total_sessions: 2, total_estimated_cost: 0.42 },
          daily: [{ day: '2026-11-07', input_tokens: 1200, output_tokens: 300, cache_read_tokens: 100, sessions: 2, estimated_cost: 0.42 }],
          period_days: days,
        },
        models: {
          models: [{ model: 'deepseek-v4-pro', provider: 'deepseek-official', input_tokens: 1200, output_tokens: 300, cache_read_tokens: 100, sessions: 2, estimated_cost: 0.42 }],
          period_days: days,
        },
      }
    },
    async listSkills() {
      return [{ name: 'demo-skill', description: 'A demo skill', path: '/virtual/demo-skill/SKILL.md' }]
    },
    async readSkill(name) {
      if (name !== 'demo-skill') return null
      return { name, content: '# Demo skill\n', path: '/virtual/demo-skill/SKILL.md' }
    },
    async listSchedules() { return [...schedules.values()] },
    async createSchedule(request) {
      if (request?.prompt === 'reject me') {
        throw Object.assign(new Error('title must be 1-120 characters'), { code: 'schedule/input-invalid' })
      }
      const now = new Date()
      const timing = request?.timing ?? {}
      const entry = {
        id: 'sched-' + (++scheduleSequence),
        kind: timing.kind,
        title: String(request?.title ?? ''),
        prompt: String(request?.prompt ?? ''),
        status: 'active',
        target: request?.target ?? { kind: 'new' },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        scheduledAt: new Date(now.getTime() + 300000).toISOString(),
      }
      if (timing.kind === 'every') entry.everySeconds = timing.every_seconds
      if (timing.kind === 'cron') { entry.expression = timing.cron.expression; entry.timeZone = timing.cron.time_zone }
      if (timing.kind === 'daily') { entry.time = timing.daily.time; entry.timeZone = timing.daily.time_zone }
      if (timing.kind === 'at') entry.scheduledAt = timing.at
      if (timing.kind === 'rrule') entry.rrule = timing.rrule
      schedules.set(entry.id, entry)
      return entry
    },
    async editSchedule(request) {
      const entry = schedules.get(String(request?.id ?? ''))
      if (request?.action === 'delete') {
        if (entry === undefined) return { id: request?.id, deleted: false, code: 'schedule_not_found' }
        schedules.delete(entry.id)
        return { id: entry.id, deleted: true }
      }
      if (entry === undefined) return { id: request?.id, code: 'schedule_not_found' }
      const patch = request?.patch ?? {}
      if (typeof patch.title === 'string') entry.title = patch.title
      if (typeof patch.prompt === 'string') entry.prompt = patch.prompt
      if (patch.active === true) entry.status = 'active'
      if (patch.active === false) entry.status = 'paused'
      if (patch.timing !== undefined) {
        const timing = patch.timing
        for (const key of ['expression', 'timeZone', 'everySeconds', 'time', 'weekdays', 'rrule', 'afterSeconds']) delete entry[key]
        entry.kind = timing.kind
        if (timing.kind === 'every') entry.everySeconds = timing.every_seconds
        if (timing.kind === 'cron') { entry.expression = timing.cron.expression; entry.timeZone = timing.cron.time_zone }
        if (timing.kind === 'daily') { entry.time = timing.daily.time; entry.timeZone = timing.daily.time_zone }
        if (timing.kind === 'at') entry.scheduledAt = timing.at
        if (timing.kind === 'rrule') entry.rrule = timing.rrule
      }
      entry.updatedAt = new Date().toISOString()
      return entry
    },
    async runSchedule(id) {
      const entry = schedules.get(String(id ?? ''))
      if (entry === undefined) return { id, code: 'schedule_not_found' }
      const now = new Date().toISOString()
      entry.lastDelivery = {
        scheduledAt: entry.scheduledAt,
        deliveredAt: now,
        messageId: 'msg-' + entry.id,
        targetSessionId: 'sess-mock',
      }
      return entry
    },
    async scheduleHistory(id, limit) {
      const entry = schedules.get(String(id ?? ''))
      if (entry === undefined) return { id, code: 'schedule_not_found' }
      const records = entry.lastDelivery === undefined ? [] : [entry.lastDelivery]
      return {
        id: entry.id,
        records: records.slice(0, limit),
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 7, records: 100 },
      }
    },
    async searchSessions(query) {
      const needle = String(query ?? '').toLowerCase()
      const items = []
      if (needle.length === 0) return { items, hasMore: false }
      for (const record of sessions.values()) {
        // DSH's search covers message content only; titles are the host's own
        // supplement lane, so the mock must not match them here.
        let snippet
        {
          for (const event of record.events) {
            const content = event?.data?.message?.content ?? event?.data?.content
            const text = Array.isArray(content)
              ? content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
              : (typeof content === 'string' ? content : '')
            if (text.toLowerCase().includes(needle)) { snippet = text.slice(0, 160); break }
          }
        }
        if (snippet !== undefined) items.push({ sessionId: record.sessionId, snippet })
      }
      return { items, hasMore: false }
    },
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
    async prompt({ sessionId, text, images = [] }) {
      const record = ensure(sessionId)
      record.running = true
      record.updatedAt = Date.now()
      promptLog.push({ sessionId, text, images })
      const content = [{ type: 'text', text }]
      for (const image of images) {
        content.push({ type: 'image', attachment: { attachmentId: 'att-' + seq, mediaType: image.mediaType, name: image.name } })
      }
      record.events.push({ type: 'user/message', seq: seq++, time: Date.now(), data: { content } })
      const queue = queues.get(sessionId)
      const reply = 'Echo: ' + text
      // A failure still streams its partial answer, then closes with the reason a
      // real provider error carries; a cancel mirrors what the Stop button does.
      const reason = turnOutcome === 'failed'
        ? { kind: 'error', error: { message: 'mock provider failure', code: 'UNKNOWN' } }
        : turnOutcome === 'cancelled'
          ? { kind: 'aborted', reason: { kind: 'user' } }
          : { kind: 'completed' }
      setTimeout(() => {
        for (const word of reply.split(' ')) {
          queue.push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: word + ' ' } } })
        }
        queue.push({ type: 'event', event: { type: 'assistant/message', seq: seq++, time: Date.now(), data: { message: { content: [{ type: 'text', text: reply }] } } } })
        queue.push({ type: 'event', event: { type: 'turn/end', seq: seq++, time: Date.now(), data: { turn: 1, reason } } })
        record.running = false
      }, turnDelay)
      return { accepted: true }
    },
    async cancel(sessionId) { const record = sessions.get(sessionId); if (record) record.running = false },
    /**
     * Choose how every subsequent mocked turn ends, so the failed and cancelled
     * terminal paths are exercisable without a real provider error or a GUI.
     * @param {'completed'|'failed'|'cancelled'} outcome outcome.
     * @returns {void}
     */
    setTurnOutcome(outcome) {
      turnOutcome = outcome === 'failed' || outcome === 'cancelled' ? outcome : 'completed'
    },
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
        // A provider the catalog could not list, so /api/providers can be
        // exercised with a failing entry (the real catalog isolates these).
        failures: [{ id: 'unconfigured-provider', name: 'Unconfigured', message: 'no API key configured' }],
      }
    },
    warm() {},
    lastPrompt() { return promptLog[promptLog.length - 1] },
    async commands() { return [] },
    /**
     * Mock slash-command execution. The mock host has no command domain: it
     * acknowledges a `/goal` line the way the real command answers back, and
     * resolves nothing else, which the listener reports as an unknown command.
     * @param {object} input input.
     * @param {string} input.sessionId session whose agent receives the command.
     * @param {string} input.line complete slash-command line.
     * @returns {Promise<{commandId: string, result: {kind: string, text: string}}|undefined>} execution.
     */
    async executeCommand({ sessionId, line } = {}) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('executeCommand needs a sessionId')
      const text = String(line ?? '').trim()
      if (!/^\/goal(?:\s|$)/.test(text)) return undefined
      return { commandId: 'mock-command', result: { kind: 'success', text: 'Mock goal command: ' + text } }
    },
    /** The mock host keeps no goal state, so no session has a current goal. */
    async sessionGoal() { return undefined },
    /**
     * Mock speech-to-text for the dictation route: a fixed transcript, so the
     * wire can be exercised without a microphone or a recognizer.
     * @param {object} request request.
     * @param {string} request.audioBase64 base64 recording.
     * @returns {Promise<{text: string, provider: string}>} transcript.
     */
    async transcribe({ audioBase64 } = {}) {
      if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
        throw Object.assign(new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording'), {
          code: 'speech/invalid-audio',
          details: { reason: 'encoding-or-size' },
        })
      }
      return { text: 'Mock transcript', provider: 'mock' }
    },
    async workspaces() {
      return {
        workspaces: [{ id: 'ws-mock', name: 'mock workspace', path: cwd, sessionIds: ['sess-mock'] }],
        pinnedSessionIds: [...pinned],
        archivedSessionIds: [...archived],
      }
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
    async pinSession({ sessionId, pinned: want }) {
      if (want === false) pinned.delete(sessionId)
      else pinned.add(sessionId)
      return { ok: true }
    },
    async archiveSession({ sessionId, archived: want }) {
      if (want === false) archived.delete(sessionId)
      else {
        archived.add(sessionId)
        // DSH drops a pin when a session is archived (the two are exclusive).
        pinned.delete(sessionId)
      }
      return { ok: true }
    },
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
    async readText(sessionId, reference, options = {}) {
      const { readFile } = await import('node:fs/promises')
      const { basename, extname } = await import('node:path')
      const target = await this.resolvePath(sessionId, reference)
      if (target === undefined) return undefined
      const body = await readFile(target).catch(() => undefined)
      if (body === undefined || body.includes(0)) return undefined
      const maxBytes = Number.isSafeInteger(options?.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : undefined
      const slice = maxBytes === undefined ? body : body.subarray(0, maxBytes)
      const content = slice.toString('utf8')
      return {
        content,
        path: target,
        name: basename(target),
        language: extname(target).replace(/^\./, '').toLowerCase(),
        size: body.length,
        lines: content.length === 0 ? 0 : content.split('\n').length,
        truncated: slice.length < body.length,
      }
    },
    async resolvePath(sessionId, reference) {
      const { join } = await import('node:path')
      const raw = String(reference ?? '').trim()
      if (raw.startsWith('/')) return raw
      const base = sessions.get(sessionId)?.cwd ?? cwd
      return raw.length === 0 ? base : join(base, raw)
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
    pendingApproval(sessionId) {
      for (const entry of pendingApprovals.values()) {
        if (entry.sessionId === sessionId) return { ...entry.pending }
      }
      return undefined
    },
    pendingClarification(sessionId) {
      for (const entry of pendingClarifications.values()) {
        if (entry.sessionId === sessionId) return { ...entry.pending }
      }
      return undefined
    },
    respondApproval({ approvalId, choice }) {
      const entry = pendingApprovals.get(approvalId)
      if (entry === undefined) return { ok: false, stale: true }
      const decision = approvalDecision(choice)
      if (decision === undefined) return { ok: false, error: 'unknown approval choice: ' + String(choice) }
      pendingApprovals.delete(approvalId)
      rememberGrant(entry.sessionId, entry.pending.command ?? '', decision.scope)
      this.lastApprovalOutcome = decision.outcome
      notify({ kind: 'approval-resolved', sessionId: entry.sessionId, approvalId, reason: 'answered' })
      return { ok: true, choice: decision.scope, outcome: decision.outcome }
    },
    respondClarification({ clarifyId, response }) {
      const entry = pendingClarifications.get(clarifyId)
      if (entry === undefined) return { ok: false, stale: true }
      pendingClarifications.delete(clarifyId)
      this.lastClarificationResponse = { clarifyId, response }
      notify({ kind: 'clarify-resolved', sessionId: entry.sessionId, clarifyId, reason: 'answered' })
      return { ok: true }
    },
    dispose() {},
    /**
     * Delay before each mocked reply streams, so a test can interleave a host
     * request (approval, clarification) with an open chat stream.
     * @param {number} value milliseconds.
     * @returns {void}
     */
    setTurnDelay(value) { turnDelay = Number.isFinite(value) ? value : 10 },
    /**
     * Simulate an agent asking for approval. A standing grant from an earlier
     * "session"/"always" answer means no card is recorded.
     * @param {string} sessionId session id.
     * @param {object} [overrides] pending fields to override.
     * @returns {object} pending payload.
     */
    simulateApproval(sessionId = 'sess-mock', overrides = {}) {
      const pending = {
        approval_id: overrides.approval_id ?? 'ap-' + Math.random().toString(36).slice(2, 8),
        command: overrides.command ?? 'bash',
        description: overrides.description ?? 'Run npm test',
      }
      if (granted(sessionId, pending.command)) return pending
      pendingApprovals.set(pending.approval_id, { sessionId, pending })
      notify({ kind: 'approval', sessionId, pending })
      return pending
    },
    /**
     * Simulate an agent asking for clarification.
     * @param {string} sessionId session id.
     * @param {object} [overrides] pending fields to override.
     * @returns {object} pending payload.
     */
    simulateClarification(sessionId = 'sess-mock', overrides = {}) {
      const pending = {
        clarify_id: overrides.clarify_id ?? 'cq-' + Math.random().toString(36).slice(2, 8),
        question: overrides.question ?? 'Which database should I use?',
        choices_offered: overrides.choices_offered ?? ['SQLite', 'Postgres'],
        session_id: sessionId,
        requested_at: Math.floor(Date.now() / 1000),
      }
      pendingClarifications.set(pending.clarify_id, { sessionId, pending })
      notify({ kind: 'clarify', sessionId, pending })
      return pending
    },
    /**
     * Simulate a prompt resolving without the phone (timeout, GUI answer, or a
     * cancelled turn), so tests can watch the retraction clear the card.
     * @param {string} sessionId session id.
     * @param {string} [kind] approval|clarify.
     * @returns {void}
     */
    simulatePromptResolved(sessionId = 'sess-mock', kind = 'approval') {
      if (kind === 'clarify') {
        for (const [id, entry] of pendingClarifications) {
          if (entry.sessionId === sessionId) pendingClarifications.delete(id)
        }
        notify({ kind: 'clarify-resolved', sessionId, reason: 'timeout' })
        return
      }
      for (const [id, entry] of pendingApprovals) {
        if (entry.sessionId === sessionId) pendingApprovals.delete(id)
      }
      notify({ kind: 'approval-resolved', sessionId, reason: 'timeout' })
    },
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('standalone.mjs')
if (isMain) {
  const portArg = process.argv.indexOf('--port')
  const port = portArg > 0 ? Number.parseInt(process.argv[portArg + 1], 10) : undefined
  const lan = process.argv.includes('--lan')
  const outcomeArg = process.argv.indexOf('--turn-outcome')
  const turnOutcome = outcomeArg > 0 ? process.argv[outcomeArg + 1] : undefined
  const gatewayArg = process.argv.indexOf('--gateway-port')
  const gatewayPort = gatewayArg > 0 ? Number.parseInt(process.argv[gatewayArg + 1], 10) : undefined
  const config = resolveConfig({
    port,
    dir: process.env.HERMES_FACADE_DIR,
    lanHost: lan ? 'auto' : undefined,
    gatewayEnabled: gatewayPort !== undefined,
    ...(gatewayPort === undefined ? {} : { gatewayPort }),
  })
  const host = createMockHost()
  if (turnOutcome !== undefined) host.setTurnOutcome(turnOutcome)
  const facade = createFacadeServer({ config, host })
  const address = await facade.listen()
  for (const bound of facade.addresses ?? []) {
    console.log('hermes-facade (standalone, MOCK agent) on http://' + bound.host + ':' + bound.port)
  }
  let gateway
  if (gatewayPort !== undefined) {
    gateway = createGatewayServer({
      config,
      facadeUrl: 'http://127.0.0.1:' + address.port,
      facadeAuth: facade.auth,
      host,
    })
    const gatewayAddress = await gateway.listen()
    console.log('hermes-gateway (standalone, MOCK agent) on http://' + gatewayAddress.host + ':' + gatewayAddress.port)
  }
  if (facade.auth.generatedPassword) console.log('password: ' + facade.auth.generatedPassword)
  else console.log('password: (existing) see ' + facade.auth.passwordPath)
  if (turnOutcome !== undefined) console.log('mock turn outcome: ' + turnOutcome + ' (every turn ends this way)')
  const shutdown = async () => { if (gateway !== undefined) await gateway.close(); await facade.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
