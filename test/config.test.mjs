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
