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

/**
 * Create an empty stream registry.
 * @returns {object} registry.
 */
export function createStreamRegistry() {
  /** @type {Map<string, object>} */
  const streams = new Map()

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
      for (const channel of record.channels) {
        if (!channel.closed) channel.close()
      }
      record.channels.clear()
    },

    /**
     * Drop finished streams older than a cutoff.
     * @param {number} maxAgeMs maximum age.
     * @returns {number} number removed.
     */
    prune(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs
      let removed = 0
      for (const [id, record] of streams) {
        if (record.terminal !== null && record.createdAt < cutoff) {
          streams.delete(id)
          removed += 1
        }
      }
      return removed
    },
  }
}
