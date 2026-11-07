import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalizeWave, extensionFor, WAV_MIME_TYPES } from '../src/hermes/audio.mjs'

/**
 * Build one WAVE file with the requested format and payload.
 * @param {object} options options.
 * @param {number} [options.tag] format tag (1 PCM, 0xFFFE extensible).
 * @param {number} [options.channels] channel count.
 * @param {number} [options.sampleRate] sample rate.
 * @param {number} [options.bits] bits per sample.
 * @param {Buffer} [options.data] PCM payload.
 * @param {boolean} [options.extensible] append the extensible fmt tail.
 * @returns {Buffer} WAVE bytes.
 */
function waveOf({ tag = 1, channels = 1, sampleRate = 16000, bits = 16, data, extensible = false } = {}) {
  const payload = data ?? Buffer.alloc(320)
  const fmtSize = extensible ? 40 : 16
  const fmt = Buffer.alloc(fmtSize)
  fmt.writeUInt16LE(extensible ? 0xFFFE : tag, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 8)
  fmt.writeUInt16LE(channels * (bits / 8), 12)
  fmt.writeUInt16LE(bits, 14)
  if (extensible) {
    fmt.writeUInt16LE(22, 16)
    fmt.writeUInt16LE(bits, 18)
    fmt.writeUInt32LE(4, 20)
    fmt.writeUInt16LE(1, 24)
  }
  const header = Buffer.alloc(12)
  header.write('RIFF', 0)
  header.writeUInt32LE(4 + 8 + fmtSize + 8 + payload.length, 4)
  header.write('WAVE', 8)
  const fmtChunk = Buffer.concat([Buffer.from('fmt '), Buffer.alloc(4), fmt])
  fmtChunk.writeUInt32LE(fmtSize, 4)
  const dataChunk = Buffer.concat([Buffer.from('data'), Buffer.alloc(4), payload])
  dataChunk.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, fmtChunk, dataChunk])
}

test('canonicalizeWave rewrites extensible PCM16 as the 44-byte intake layout', () => {
  const payload = Buffer.alloc(320, 7)
  const canonical = canonicalizeWave(waveOf({ extensible: true, data: payload }))
  assert.equal(canonical.length, 44 + payload.length)
  assert.equal(canonical.toString('ascii', 0, 4), 'RIFF')
  assert.equal(canonical.readUInt32LE(4), canonical.length - 8)
  assert.equal(canonical.toString('ascii', 8, 12), 'WAVE')
  assert.equal(canonical.toString('ascii', 12, 16), 'fmt ')
  assert.equal(canonical.readUInt32LE(16), 16)
  assert.equal(canonical.readUInt16LE(20), 1)
  assert.equal(canonical.readUInt16LE(22), 1)
  assert.equal(canonical.readUInt32LE(24), 16000)
  assert.equal(canonical.readUInt32LE(28), 32000)
  assert.equal(canonical.readUInt16LE(32), 2)
  assert.equal(canonical.readUInt16LE(34), 16)
  assert.equal(canonical.toString('ascii', 36, 40), 'data')
  assert.equal(canonical.readUInt32LE(40), payload.length)
  assert.deepEqual(canonical.subarray(44), payload)
})

test('canonicalizeWave keeps a canonical file unchanged', () => {
  const file = waveOf({ data: Buffer.alloc(64, 3) })
  assert.deepEqual(canonicalizeWave(file), file)
})

test('canonicalizeWave refuses audio the intake would not accept', () => {
  assert.throws(() => canonicalizeWave(waveOf({ channels: 2 })), /16 kHz mono PCM16/)
  assert.throws(() => canonicalizeWave(waveOf({ sampleRate: 44100 })), /16 kHz mono PCM16/)
  assert.throws(() => canonicalizeWave(waveOf({ bits: 8 })), /16 kHz mono PCM16/)
  assert.throws(() => canonicalizeWave(Buffer.from('not a wave file at all')), /WAVE/)
})

test('extensionFor keeps the temporary input honest per media type', () => {
  assert.equal(extensionFor('audio/m4a'), '.m4a')
  assert.equal(extensionFor('audio/mp4'), '.m4a')
  assert.equal(extensionFor('audio/aac'), '.aac')
  assert.equal(extensionFor('audio/mpeg'), '.mp3')
  assert.equal(extensionFor(undefined), '.audio')
})

test('WAV media types pass the speech intake without conversion', () => {
  for (const mime of ['audio/wav', 'audio/x-wav', 'audio/wave']) assert.ok(WAV_MIME_TYPES.has(mime))
  assert.equal(WAV_MIME_TYPES.has('audio/m4a'), false)
})
