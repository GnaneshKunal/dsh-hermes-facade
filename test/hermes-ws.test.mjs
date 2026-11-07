import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { acceptUpgrade, GATEWAY_PROTOCOL, splitProtocols, ticketFromProtocols } from '../src/hermes/ws.mjs'

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer((req, res) => { res.writeHead(404); res.end() })
    server.on('upgrade', (req, socket, head) => {
      const conn = acceptUpgrade(req, socket, head, handler(req))
      if (conn === undefined) return
      conn.on('message', text => {
        const value = JSON.parse(text)
        if (value.echo === true) conn.sendJson({ ok: true, protocol: conn.protocol, ticket: conn.ticket, size: 'x'.repeat(value.pad ?? 0) })
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('subprotocol helpers', () => {
  const protocols = splitProtocols('hermes-gateway-v1, hermes-gateway-ticket.abc123')
  assert.deepEqual(protocols, ['hermes-gateway-v1', 'hermes-gateway-ticket.abc123'])
  assert.equal(ticketFromProtocols(protocols), 'abc123')
  assert.equal(ticketFromProtocols(['hermes-gateway-v1']), undefined)
})

test('accepts the upgrade, echoes the protocol and round-trips frames', async () => {
  const { server, port } = await listen(() => ({}))
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws', [GATEWAY_PROTOCOL, 'hermes-gateway-ticket.t-1'])
    const opened = await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(true))
      ws.addEventListener('error', reject)
    })
    assert.equal(opened, true)
    assert.equal(ws.protocol, GATEWAY_PROTOCOL)
    ws.send(JSON.stringify({ echo: true, pad: 0 }))
    const small = await new Promise((resolve, reject) => {
      ws.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true })
      ws.addEventListener('error', reject)
    })
    assert.equal(small.protocol, GATEWAY_PROTOCOL)
    assert.equal(small.ticket, 't-1')
    // 200 bytes forces the 16-bit length path on the server side.
    ws.send(JSON.stringify({ echo: true, pad: 200 }))
    const large = await new Promise((resolve, reject) => {
      ws.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true })
      ws.addEventListener('error', reject)
    })
    assert.equal(large.size.length, 200)
    ws.close()
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('rejects an unauthorized upgrade', async () => {
  const { server, port } = await listen(() => ({ authorize: () => false, rejectStatus: 401 }))
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/ws', [GATEWAY_PROTOCOL, 'hermes-gateway-ticket.nope'])
    const failed = await new Promise(resolve => {
      ws.addEventListener('error', () => resolve('error'))
      ws.addEventListener('open', () => resolve('open'))
      setTimeout(() => resolve('timeout'), 2000)
    })
    assert.equal(failed, 'error')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
