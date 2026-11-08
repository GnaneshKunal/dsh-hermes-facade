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

/** Most events kept per session for replay while no turn is in flight. */
// A single long agent turn can emit more than a thousand tool/reasoning
// frames; a returning client replays from its cursor, so a short ring loses
// the start of the turn, reports `truncated`, and the app throws its screen
// away and rebuilds from a transcript that does not contain the in-flight
// rows. 5000 covers a typical hour-long turn in the quiet case.
const DEFAULT_RETAIN = 5000

/**
 * Hard ceiling on the events one turn in flight may pin in a session's ring.
 *
 * While a turn runs, its first event is pinned and eviction may not pass it,
 * so any cursor inside the turn replays without a hole however long the turn
 * is — the app keeps the rows it already drew instead of rebuilding. The pin
 * is bounded: past this many events the ordinary ring retention applies again
 * and the replay reports the truth (`truncated`), leaving the app's rebuild
 * path as the fallback. 20000 events is well past the longest turn reported
 * (about 1300 frames); the pin is released as soon as the turn settles.
 */
const DEFAULT_TURN_RETAIN = 20000

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
 * @param {number} [options.retain] ring size per session while no turn is in flight.
 * @param {number} [options.turnRetain] most events one active turn may pin.
 * @returns {object} hub.
 */
export function createEventHub({
  epochOf = () => 'epoch-1',
  retain = DEFAULT_RETAIN,
  turnRetain = DEFAULT_TURN_RETAIN,
} = {}) {
  const sequences = new Map()
  const pendingSince = new Map()
  const rings = new Map()
  const connections = new Set()
  /** session id -> first seq of the turn in flight, the replay floor it pins. */
  const turnFloors = new Map()
  // A turn ceiling below the quiet window would silently disable the guarantee,
  // so the pin always keeps at least the ordinary retention.
  const turnLimit = Math.max(retain, turnRetain)

  /**
   * Evict the oldest events past the retention the session is allowed while it
   * is in this state.
   *
   * A turn in flight pins its first event: everything from that sequence on is
   * kept, so a client whose cursor is inside the turn replays without a hole
   * and keeps the rows it already drew. The pin is bounded by `turnRetain`; a
   * turn longer than that falls back to the ordinary ring and the replay says
   * so honestly. No floor keeps the plain `retain` window.
   *
   * @param {Array<object>} ring session ring, oldest first.
   * @param {number} [floor] first seq the ring may not pass while pinned.
   * @returns {void}
   */
  function trim(ring, floor) {
    while (ring.length > retain) {
      const oldest = ring[0]
      if (floor !== undefined && ring.length <= turnLimit && oldest.seq >= floor) return
      ring.shift()
    }
  }

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
    trim(ring, turnFloors.get(sessionId))
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
   * Pin a session's replay ring at the turn that is about to start.
   *
   * Called before the turn publishes its first event, so the floor is that
   * event's sequence. Everything the turn emits is then retained until
   * `endTurn`, even past the ordinary `retain` window (bounded by
   * `turnRetain`), which is what lets a client reattaching mid-turn replay
   * from its own cursor instead of throwing the screen away.
   *
   * @param {string} sessionId session id.
   * @returns {void}
   */
  function beginTurn(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    turnFloors.set(sessionId, (sequences.get(sessionId) ?? 0) + 1)
  }

  /**
   * Release a session's turn pin and trim the ring back to the quiet window.
   *
   * A settled turn is durable history: a client that still needs its rows
   * rebuilds from the transcript, which now contains them, so the extra
   * retention is not kept.
   *
   * @param {string} sessionId session id.
   * @returns {void}
   */
  function endTurn(sessionId) {
    if (!turnFloors.delete(sessionId)) return
    const ring = rings.get(sessionId)
    if (ring !== undefined) trim(ring, undefined)
  }

  /**
   * The first sequence of the turn currently pinned, if any.
   * @param {string} sessionId session id.
   * @returns {number|undefined} first seq.
   */
  function turnFloor(sessionId) {
    return turnFloors.get(String(sessionId))
  }

  /**
   * Forget a session's ring, cursor and turn pin (a deleted session).
   * @param {string} sessionId session id.
   * @returns {void}
   */
  function forget(sessionId) {
    sequences.delete(sessionId)
    rings.delete(sessionId)
    pendingSince.delete(sessionId)
    turnFloors.delete(sessionId)
  }

  return { attach, publish, since, head, beginTurn, endTurn, turnFloor, forget, connections, pendingSince }
}
