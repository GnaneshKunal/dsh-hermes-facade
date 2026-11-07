/**
 * Chat stream registry: one entry per POST /api/chat/start.
 *
 * A stream owns a replay journal so a reconnecting client can ask for
 * everything after a sequence number, plus the set of live SSE channels
 * currently attached.
 *
 * @module dsh-hermes-facade/src/streams
 */

/**
 * Generate a short opaque stream id.
 * @returns {string} stream id.
 */
export function newStreamId() {
  return 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** How long a finished stream stays replayable after its turn ended. */
const DEFAULT_RETAIN_MS = 30 * 60 * 1000

/** How many finished streams are kept for replay; the oldest go first. */
const DEFAULT_MAX_FINISHED = 64

/**
 * Create an empty stream registry.
 * @param {object} [options] options.
 * @param {number} [options.retainMs] replay window for a finished stream.
 * @param {number} [options.maxFinished] cap on finished streams kept for replay.
 * @returns {object} registry.
 */
export function createStreamRegistry({ retainMs = DEFAULT_RETAIN_MS, maxFinished = DEFAULT_MAX_FINISHED } = {}) {
  /** @type {Map<string, object>} */
  const streams = new Map()

  /**
   * Drop finished streams that outlived their replay window, then the oldest
   * finished streams beyond the retention cap. Live streams are never touched:
   * pruning them would break a running turn's replay.
   * @param {number} maxAgeMs replay window.
   * @param {number} keepFinished finished-stream cap.
   * @returns {number} number removed.
   */
  function pruneStreams(maxAgeMs, keepFinished) {
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    for (const [id, record] of streams) {
      if (record.terminal !== null && (record.finishedAt ?? record.createdAt) < cutoff) {
        streams.delete(id)
        removed += 1
      }
    }
    const finished = [...streams.values()]
      .filter(record => record.terminal !== null)
      .sort((left, right) => (left.finishedAt ?? left.createdAt) - (right.finishedAt ?? right.createdAt))
    const excess = finished.length - Math.max(0, keepFinished)
    for (const record of finished.slice(0, Math.max(0, excess))) {
      streams.delete(record.streamId)
      removed += 1
    }
    return removed
  }

  return {
    /**
     * Register a new stream.
     * @param {object} options options.
     * @param {string} options.sessionId session the stream belongs to.
     * @returns {object} stream record.
     */
    create({ sessionId }) {
      const record = {
        streamId: newStreamId(),
        sessionId,
        seq: 0,
        journal: [],
        channels: new Set(),
        terminal: null,
        finishedAt: null,
        createdAt: Date.now(),
      }
      streams.set(record.streamId, record)
      return record
    },

    /**
     * Look up a stream.
     * @param {string} streamId stream id.
     * @returns {object|undefined} record.
     */
    get(streamId) {
      return streams.get(streamId)
    },

    /**
     * Find the live stream for a session.
     * @param {string} sessionId session id.
     * @returns {object|undefined} record.
     */
    forSession(sessionId) {
      for (const record of streams.values()) {
        if (record.sessionId === sessionId && record.terminal === null) return record
      }
      return undefined
    },

    /**
     * Count streams that have not finished yet.
     *
     * Used by /health so an external check can wait for a quiet moment before
     * reloading the plugin (a reload closes the SSE the phone is reading).
     * @returns {number} live stream count.
     */
    activeCount() {
      let active = 0
      for (const record of streams.values()) if (record.terminal === null) active += 1
      return active
    },

    /**
     * Append one event and fan it out to attached channels.
     * @param {object} record stream record.
     * @param {string} event SSE event name.
     * @param {unknown} data payload.
     * @returns {number} the assigned sequence.
     */
    publish(record, event, data) {
      record.seq += 1
      const entry = { seq: record.seq, event, data }
      record.journal.push(entry)
      for (const channel of record.channels) {
        if (channel.closed) { record.channels.delete(channel); continue }
        channel.send(event, data, entry.seq)
      }
      return entry.seq
    },

    /**
     * Mark the stream terminal and close every attached channel.
     * @param {object} record stream record.
     * @param {string} state terminal state ("completed"|"cancelled"|"failed").
     * @returns {void}
     */
    finish(record, state) {
      if (record.terminal !== null) return
      record.terminal = state
      record.finishedAt = Date.now()
      for (const channel of record.channels) {
        if (!channel.closed) channel.close()
      }
      record.channels.clear()
      // This is the lifecycle point that used to leak: without a prune every
      // finished journal stayed in memory until the process exited. Replay only
      // matters right after the turn ends, so old finished streams go now.
      pruneStreams(retainMs, maxFinished)
    },

    /**
     * Drop finished streams older than a cutoff, plus the oldest beyond the
     * finished-stream cap.
     * @param {number} [maxAgeMs] replay window.
     * @param {number} [keepFinished] finished-stream cap.
     * @returns {number} number removed.
     */
    prune(maxAgeMs = retainMs, keepFinished = maxFinished) {
      return pruneStreams(maxAgeMs, keepFinished)
    },
  }
}
