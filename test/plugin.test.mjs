import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../index.js'

/**
 * Minimal cordis-shaped context with the two host services the plugin needs.
 * @param {object} options options.
 * @param {object} options.gateway fake typertGateway.
 * @returns {object} fake ctx.
 */
function fakeCtx({ gateway }) {
  const disposers = []
  return {
    logger: { info() {}, warn() {} },
    typertGateway: gateway,
    connection: { createPeer: () => ({ proxy: true }) },
    on: () => () => {},
    effect: callback => {
      const disposer = callback()
      disposers.push(disposer)
      return () => {}
    },
    /** Run every registered disposer. */
    disposeAll() { for (const disposer of disposers) if (typeof disposer === 'function') disposer() },
  }
}

test('the plugin entry mounts and serves /health', async t => {
  assert.deepEqual(inject, ['typertGateway', 'connection'])
  assert.equal(name, 'hermes-facade')

  const dir = mkdtempSync(join(tmpdir(), 'hermes-facade-plugin-'))
  const port = 9411
  const gateway = {
    async invoke(namespace, method) {
      if (namespace === 'session' && method === 'list') return { items: [] }
      return {}
    },
    stream() {
      return (async function* empty() {})()
    },
  }
  const ctx = fakeCtx({ gateway })
  t.after(() => ctx.disposeAll())

  await apply(ctx, { port, dir, bindHost: '127.0.0.1' })

  const health = await fetch('http://127.0.0.1:' + port + '/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).status, 'ok')

  const status = await fetch('http://127.0.0.1:' + port + '/api/auth/status')
  assert.equal((await status.json()).auth_enabled, true)
})

test('a broken host does not throw out of apply()', async () => {
  const ctx = { logger: { info() {}, warn() {} }, on: () => () => {}, effect: () => () => {} }
  await apply(ctx, { port: 9412, dir: mkdtempSync(join(tmpdir(), 'hermes-facade-broken-')) })
  assert.ok(true, 'apply swallowed the missing host services')
})
