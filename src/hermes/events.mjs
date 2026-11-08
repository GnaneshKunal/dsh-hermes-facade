/**
 * In-memory event fan-out for the gateway socket.
 *
 * Hermes multiplexes every session's events onto one WebSocket and each screen
 * admits only its own session. Sequence numbers are per session and contiguous
 * from 1: a returning client calls session.events.since with its cursor and the
 * reply must have no hole, or it throws the screen away and rebuilds.
 *
 * @module dsh-hermes-facade/src/hermes/events
 */

/** Most events kept per session for replay. */
// A single long agent turn can emit more than a thousand tool/reasoning
// frames; a returning client replays from its cursor, so a 1000-event ring
// loses the start of the turn and rebuilds from a transcript that does not
// contain the in-flight rows. 5000 covers a typical hour-long turn.
const DEFAULT_RETAIN = 5000

/**
 * The live-session list refresh event.
 *
 * The session list and the Bot inbox re-read session.active_list when this
 * arrives, and the client dispatches it on params.type alone (no payload).
 * @type {string}
 */
export const SESSIONS_CHANGED = 'sessions.changed'

/**
 * Build the params of one event notification.
 * @param {string} type event type.
 * @param {number} seq sequence.
 * @param {object} payload payload.
 * @param {string} [sessionId] owning session.
 * @returns {object} params.
 */
export function eventParams(type, seq, payload, sessionId) {
  return {
    type,
    seq,
    ...(typeof sessionId === 'string' && sessionId.length > 0 ? { session_id: sessionId } : {}),
    payload,
  }
}

/**
 * Build one event notification.
 * @param {string} type event type.
 * @param {number} seq sequence.
 * @param {object} payload payload.
 * @param {string} [sessionId] owning session.
 * @returns {object} JSON-RPC notification.
 */
export function eventFrame(type, seq, payload, sessionId) {
  return { jsonrpc: '2.0', method: 'event', params: eventParams(type, seq, payload, sessionId) }
}

/**
 * Announce that the set of live sessions changed.
 *
 * The list is process-wide, not one session's story, so the frame carries no
 * session id and takes no sequence number: a reattaching screen reads the
 * current list anyway, so there is nothing to replay.
 *
 * @param {object} hub event hub.
 * @returns {void}
 */
export function publishSessionsChanged(hub) {
  hub.publish(SESSIONS_CHANGED, {})
}

/**
 * Create the hub.
 * @param {object} [options] options.
 * @param {(sessionId: string) => string} [options.epochOf] per-session replay epoch.
 * @param {number} [options.retain] ring size per session.
 * @returns {object} hub.
 */
export function createEventHub({ epochOf = () => 'epoch-1', retain = DEFAULT_RETAIN } = {}) {
  const sequences = new Map()
  const pendingSince = new Map()
  const rings = new Map()
  const connections = new Set()

  /**
   * Start feeding one connection.
   * @param {object} connection websocket connection.
   * @returns {void}
   */
  function attach(connection) {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))

    // A first replay is answered from the ring only (a real host also parks
    // later frames); the count is small and every frame we keep is answerable.
  }

  /**
   * Publish one event to every open socket and the session ring.
   * @param {string} type event type.
   * @param {object} payload payload.
   * @param {string} [sessionId] owning session.
   * @returns {{frame: object, seq: number}} publication.
   */
  function publish(type, payload, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      const frame = eventFrame(type, 0, payload)
      for (const connection of connections) {
        try { connection.sendJson(frame) } catch { connections.delete(connection) }
      }
      return { frame, seq: 0 }
    }
    const seq = (sequences.get(sessionId) ?? 0) + 1
    sequences.set(sessionId, seq)
    const frame = eventFrame(type, seq, payload, sessionId)
    let ring = rings.get(sessionId)
    if (ring === undefined) { ring = []; rings.set(sessionId, ring) }
    ring.push(eventParams(type, seq, payload, sessionId))
    while (ring.length > retain) ring.shift()
    for (const connection of connections) {
      try { connection.sendJson(frame) } catch { connections.delete(connection) }
    }
    return { frame, seq }
  }

  /**
   * The session.events.since reply.
   * @param {string} sessionId session id.
   * @param {number} lastSeen client cursor.
   * @returns {object} reply with latest_seq, epoch, truncated and events.
   */
  function since(sessionId, lastSeen) {
    const epoch = epochOf(sessionId)
    const ring = rings.get(sessionId) ?? []
    const cursor = Number.isSafeInteger(lastSeen) && lastSeen > 0 ? lastSeen : 0
    const latest = sequences.get(sessionId) ?? 0
    const events = ring.filter(record => record.seq > cursor)
    const truncated = events.length > 0 && events[0].seq > cursor + 1
    return { latest_seq: latest, epoch, truncated, events }
  }

  /**
   * Current sequence for a session.
   * @param {string} sessionId session id.
   * @returns {number} seq.
   */
  function head(sessionId) {
    return sequences.get(sessionId) ?? 0
  }

  /**
   * Forget a session's ring and cursor (a deleted session).
   * @param {string} sessionId session id.
   * @returns {void}
   */
  function forget(sessionId) {
    sequences.delete(sessionId)
    rings.delete(sessionId)
    pendingSince.delete(sessionId)
  }

  return { attach, publish, since, head, forget, connections, pendingSince }
}
