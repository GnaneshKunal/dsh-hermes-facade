/**
 * Minimal RFC 6455 WebSocket server.
 *
 * The Hermex iOS client opens `/api/ws` with
 * `Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.<ticket>`,
 * so the ticket rides in the subprotocol offer and the server must echo the
 * protocol name back. Nothing else on this side needs an extension, so this
 * module implements exactly: the opening handshake, masked client frames,
 * fragmentation, ping/pong and the close handshake. No dependencies.
 *
 * @module dsh-hermes-facade/src/hermes/ws
 */

import { createHash } from 'node:crypto'

/** Protocol name the client offers and expects echoed. */
export const GATEWAY_PROTOCOL = 'hermes-gateway-v1'

/** Prefix of the ticket subprotocol. */
export const TICKET_PREFIX = 'hermes-gateway-ticket.'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Largest message accepted from a client. JSON-RPC frames are far smaller. */
const MAX_MESSAGE = 8 * 1024 * 1024

/**
 * Split a `Sec-WebSocket-Protocol` header into its offered tokens.
 * @param {string|undefined} header header value.
 * @returns {string[]} offered protocols.
 */
export function splitProtocols(header) {
  if (typeof header !== 'string' || header.length === 0) return []
  return header.split(',').map(value => value.trim()).filter(value => value.length > 0)
}

/**
 * The ticket the client presented as a subprotocol, if any.
 * @param {string[]} protocols offered protocols.
 * @returns {string|undefined} ticket.
 */
export function ticketFromProtocols(protocols) {
  for (const value of protocols) {
    if (!value.startsWith(TICKET_PREFIX)) continue
    const ticket = value.slice(TICKET_PREFIX.length)
    if (ticket.length > 0) return ticket
  }
  return undefined
}

/**
 * Pick the protocol to echo: the gateway protocol if it was offered.
 * @param {string[]} protocols offered protocols.
 * @returns {string|undefined} selected protocol.
 */
export function selectProtocol(protocols) {
  return protocols.includes(GATEWAY_PROTOCOL) ? GATEWAY_PROTOCOL : undefined
}

/**
 * One accepted WebSocket connection.
 */
export class WebSocketConnection {
  /**
   * @param {object} options options.
   * @param {import('node:net').Socket} options.socket upgraded socket.
   * @param {Buffer} [options.head] bytes already read past the upgrade.
   * @param {string} [options.protocol] selected subprotocol.
   * @param {string} [options.ticket] ticket presented at the upgrade.
   */
  constructor({ socket, head, protocol, ticket }) {
    this.socket = socket
    this.protocol = protocol
    this.ticket = ticket
    this.buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
    this.fragmentBytes = 0
    this.closed = false
    this.closeSent = false
    this.handlers = new Map()

    socket.setNoDelay?.(true)
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', () => this.#finish())
    socket.on('close', () => this.#finish())
    socket.on('end', () => this.#finish())
    this.#drain()
  }

  /**
   * Subscribe to a connection event.
   * @param {'message'|'close'} event event name.
   * @param {(value: any) => void} handler callback.
   * @returns {void}
   */
  on(event, handler) {
    let list = this.handlers.get(event)
    if (list === undefined) { list = []; this.handlers.set(event, list) }
    list.push(handler)
  }

  /**
   * Send a JSON-serialisable value as a text frame.
   * @param {unknown} value payload.
   * @returns {boolean} whether it was written.
   */
  sendJson(value) {
    return this.sendText(JSON.stringify(value))
  }

  /**
   * Send a text frame.
   * @param {string} text payload.
   * @returns {boolean} whether it was written.
   */
  sendText(text) {
    return this.#writeFrame(OP_TEXT, Buffer.from(String(text), 'utf8'))
  }

  /**
   * Send a ping frame.
   * @param {string} [payload] payload.
   * @returns {void}
   */
  ping(payload = '') {
    this.#writeFrame(OP_PING, Buffer.from(payload, 'utf8'))
  }

  /**
   * Close the connection.
   * @param {number} [code] close code.
   * @param {string} [reason] close reason.
   * @returns {void}
   */
  close(code = 1000, reason = '') {
    if (this.closeSent) return
    this.closeSent = true
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2, 'utf8')
    this.#writeFrame(OP_CLOSE, body)
    setTimeout(() => this.#finish(), 250).unref?.()
  }

  /**
   * Report a protocol violation and close.
   * @param {number} code close code.
   * @param {string} reason reason.
   * @returns {void}
   */
  fail(code, reason) {
    this.close(code, reason)
  }

  #emit(event, value) {
    const list = this.handlers.get(event)
    if (list === undefined) return
    for (const handler of list) {
      try { handler(value) } catch { /* a handler must not break the socket */ }
    }
  }

  #finish() {
    if (this.closed) return
    this.closed = true
    try { this.socket.destroy() } catch { /* already gone */ }
    this.#emit('close', { code: 1006, reason: '' })
  }

  #onData(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.#drain()
  }

  #drain() {
    while (!this.closed) {
      const buf = this.buffer
      if (buf.length < 2) return
      const first = buf[0]
      const second = buf[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (rsv !== 0) return this.fail(1002, 'unexpected rsv bits')
      if (length === 126) {
        if (buf.length < offset + 2) return
        length = buf.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buf.length < offset + 8) return
        const high = buf.readUInt32BE(offset)
        const low = buf.readUInt32BE(offset + 4)
        length = high * 2 ** 32 + low
        offset += 8
      }
      if (length > MAX_MESSAGE) return this.fail(1009, 'message too large')
      if (!masked) return this.fail(1002, 'client frame not masked')
      if (buf.length < offset + 4) return
      const maskKey = buf.subarray(offset, offset + 4)
      offset += 4
      if (buf.length < offset + length) return
      const payload = Buffer.from(buf.subarray(offset, offset + length))
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3]
      this.buffer = buf.subarray(offset + length)
      this.#handleFrame(fin, opcode, payload)
    }
  }

  #handleFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      if (!this.closeSent) {
        this.closeSent = true
        this.#writeFrame(OP_CLOSE, payload.subarray(0, 125))
      }
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      this.closed = true
      try { this.socket.end() } catch { /* already gone */ }
      this.#emit('close', { code, reason })
      return
    }
    if (opcode === OP_PING) { this.#writeFrame(OP_PONG, payload); return }
    if (opcode === OP_PONG) return
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragments.length > 0) return this.fail(1002, 'interleaved fragments')
      if (fin) return this.#deliver(opcode, payload)
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      this.fragmentBytes = payload.length
      return
    }
    if (opcode === OP_CONT) {
      if (this.fragments.length === 0) return this.fail(1002, 'unexpected continuation')
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > MAX_MESSAGE) return this.fail(1009, 'message too large')
      if (!fin) return
      const joined = Buffer.concat(this.fragments)
      const kind = this.fragmentOpcode
      this.fragments = []
      this.fragmentBytes = 0
      this.fragmentOpcode = 0
      return this.#deliver(kind, joined)
    }
    return this.fail(1002, 'unknown opcode')
  }

  #deliver(opcode, payload) {
    if (opcode === OP_BINARY) return
    this.#emit('message', payload.toString('utf8'))
  }

  #writeFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return false
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x80 | opcode
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    try {
      this.socket.write(Buffer.concat([header, payload]))
      return true
    } catch {
      this.#finish()
      return false
    }
  }
}

/**
 * Complete the opening handshake and wrap the socket.
 *
 * @param {import('node:http').IncomingMessage} req upgrade request.
 * @param {import('node:net').Socket} socket raw socket.
 * @param {Buffer} head bytes read past the request head.
 * @param {object} [options] options.
 * @param {(ticket: string|undefined, req: object) => boolean} [options.authorize] gate; false rejects.
 * @param {number} [options.rejectStatus] status for an unauthorized upgrade.
 * @returns {WebSocketConnection|undefined} connection, or undefined after a rejection.
 */
export function acceptUpgrade(req, socket, head, options = {}) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  if (typeof key !== 'string' || key.length === 0 || version !== '13') {
    reject(socket, 400, 'Bad Request')
    return undefined
  }
  const offered = splitProtocols(req.headers['sec-websocket-protocol'])
  // The ticket is only accepted from the subprotocol offer. A query parameter
  // would put a credential into proxy logs, and the client never sends one.
  const ticket = ticketFromProtocols(offered)
  if (typeof options.authorize === 'function' && options.authorize(ticket, req) !== true) {
    reject(socket, options.rejectStatus ?? 401, 'Unauthorized')
    return undefined
  }
  const protocol = selectProtocol(offered)
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
  ]
  if (protocol !== undefined) lines.push('Sec-WebSocket-Protocol: ' + protocol)
  try { socket.write(lines.join('\r\n') + '\r\n\r\n') } catch { return undefined }
  return new WebSocketConnection({ socket, head, protocol, ticket })
}

/**
 * Refuse an upgrade request.
 * @param {import('node:net').Socket} socket socket.
 * @param {number} status status code.
 * @param {string} text reason.
 * @returns {void}
 */
function reject(socket, status, text) {
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.end()
  } catch { /* already gone */ }
}
