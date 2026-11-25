import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.mjs'

test('lanHost defaults to off (loopback only)', () => {
  const config = resolveConfig({})
  assert.equal(config.lanHost, undefined)
  assert.equal(config.bindHost, '127.0.0.1')
})

test('lanHost auto is preserved for interface discovery', () => {
  assert.equal(resolveConfig({ lanHost: 'auto' }).lanHost, 'auto')
})

test('an explicit lanHost is kept verbatim', () => {
  assert.equal(resolveConfig({ lanHost: '192.168.1.3' }).lanHost, '192.168.1.3')
})

test('an empty lanHost is treated as unset', () => {
  assert.equal(resolveConfig({ lanHost: '' }).lanHost, undefined)
})

test('streamRetainMs is preserved when non-negative and unset otherwise', () => {
  assert.equal(resolveConfig({ streamRetainMs: 60_000 }).streamRetainMs, 60_000)
  assert.equal(resolveConfig({ streamRetainMs: 0 }).streamRetainMs, 0)
  assert.equal(resolveConfig({}).streamRetainMs, undefined)
  assert.equal(resolveConfig({ streamRetainMs: -1 }).streamRetainMs, undefined)
  assert.equal(resolveConfig({ streamRetainMs: 'soon' }).streamRetainMs, undefined)
})

test('interactionTimeoutMs defaults to ten minutes and accepts zero (park the ask)', () => {
  assert.equal(resolveConfig({}).interactionTimeoutMs, 10 * 60 * 1000)
  assert.equal(resolveConfig({ interactionTimeoutMs: 0 }).interactionTimeoutMs, 0)
  assert.equal(resolveConfig({ interactionTimeoutMs: 45_000 }).interactionTimeoutMs, 45_000)
  // A negative or non-numeric value is not a lifetime; keep the default.
  assert.equal(resolveConfig({ interactionTimeoutMs: -1 }).interactionTimeoutMs, 10 * 60 * 1000)
  assert.equal(resolveConfig({ interactionTimeoutMs: 'soon' }).interactionTimeoutMs, 10 * 60 * 1000)
})

test('eventScope defaults to broadcast and only subscribed opts in', () => {
  assert.equal(resolveConfig({}).eventScope, 'broadcast')
  assert.equal(resolveConfig({ eventScope: 'subscribed' }).eventScope, 'subscribed')
  assert.equal(resolveConfig({ eventScope: 'nonsense' }).eventScope, 'broadcast')
})
