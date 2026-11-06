/**
 * Server-Sent Events writer with the framing the Hermex decoder expects.
 *
 * The client treats more than 18 s of silence as a dead transport and comment
 * lines as heartbeats, so one is emitted every 5 s. Event ids carry the replay
 * sequence: on reconnect the app sends the integer after the LAST colon back
 * as after_seq.
 *
 * @module dsh-hermes-facade/src/sse
 */

/** Heartbeat cadence in milliseconds. */
export const HEARTBEAT_MS = 5000

/**
 * Open one SSE response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {{onClose?: () => void}} [options] close hook.
 * @returns {object} channel.
 */
export function openSse(res, options = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  let closed = false
  const heartbeat = setInterval(() => {
    if (closed) return
    try { res.write(': keepalive\n\n') } catch { close() }
  }, HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  /**
   * Mark the channel closed and stop the heartbeat.
   * @returns {void}
   */
  function close() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    try { res.end() } catch { /* already gone */ }
    if (options.onClose) options.onClose()
  }

  res.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    if (options.onClose) options.onClose()
  })

  return {
    /**
     * Write one SSE event.
     * @param {string} event event name.
     * @param {unknown} data JSON-serialisable payload.
     * @param {number} [id] resume sequence.
     * @returns {boolean} whether the write happened.
     */
    send(event, data, id) {
      if (closed) return false
      let frame = ''
      if (Number.isSafeInteger(id)) frame += 'id: ' + id + '\n'
      frame += 'event: ' + event + '\n'
      frame += 'data: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n'
      try {
        res.write(frame)
        return true
      } catch {
        close()
        return false
      }
    },
    close,
    get closed() { return closed },
  }
}
