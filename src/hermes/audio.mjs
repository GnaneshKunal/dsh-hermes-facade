/**
 * Audio intake for Hermex dictation.
 *
 * The phone records AAC in an m4a container, while DeepSeek Harness's speech
 * Remote validates one canonical recording shape before it resolves a
 * provider: 16 kHz, mono, 16-bit little-endian PCM in a RIFF/WAVE container.
 * A compressed recording therefore has to be converted on the host, and that
 * conversion is explicit: nothing compressed is ever forwarded to the speech
 * controller to fail there.
 *
 * Converters run through execFile with an explicit argv (never a shell), on a
 * private temporary directory that is removed in `finally`.
 *
 * @module dsh-hermes-facade/src/hermes/audio
 */

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** macOS's built-in converter; preferred because it needs no install. */
const AFCONVERT = '/usr/bin/afconvert'

/** Media types already in the shape the speech intake validates. */
export const WAV_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave'])

/** Error code: this host has no audio converter at all. */
export const NO_CONVERTER_CODE = 'dictation/no-converter'

/** Error code: a converter ran but did not produce usable audio. */
export const CONVERSION_FAILED_CODE = 'dictation/conversion-failed'

/** Largest WAV one conversion may produce, matching the intake's own bound. */
export const MAX_CONVERTED_BYTES = 25 * 1024 * 1024

/** Deadline for one conversion; a phone recording is short work. */
const CONVERSION_TIMEOUT_MS = 60 * 1000

/** Converter diagnostics are bounded; ffmpeg logs to stderr. */
const CONVERSION_MAX_BUFFER = 8 * 1024 * 1024

/** The host has no converter it can run. */
export class NoAudioConverterError extends Error {
  /**
   * @param {string} [message] detail.
   */
  constructor(message = 'no audio converter is installed') {
    super(message)
    this.name = 'NoAudioConverterError'
    this.code = NO_CONVERTER_CODE
  }
}

/** A converter ran but produced no usable WAV. */
export class AudioConversionError extends Error {
  /**
   * @param {string} message detail.
   */
  constructor(message) {
    super(message)
    this.name = 'AudioConversionError'
    this.code = CONVERSION_FAILED_CODE
  }
}

/**
 * The input extension a declared media type implies.
 *
 * Converters probe the bytes themselves; the extension only keeps the temporary
 * file honest for a converter that trusts names.
 * @param {string} [mime] declared media type.
 * @returns {string} extension including the dot.
 */
export function extensionFor(mime) {
  switch (String(mime ?? '').toLowerCase()) {
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/mp4':
      return '.m4a'
    case 'audio/aac':
      return '.aac'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/webm':
      return '.webm'
    default: return '.audio'
  }
}

/**
 * The converter this host prefers.
 *
 * afconvert ships with macOS; elsewhere (or without it) ffmpeg off PATH is
 * used, and its absence surfaces as an ENOENT at exec time.
 *
 * @returns {{name: string, run: (input: string, output: string) => Promise<unknown>}} converter.
 */
export function converterPlan() {
  if (process.platform === 'darwin' && existsSync(AFCONVERT)) {
    return {
      name: 'afconvert',
      run: (input, output) => run(
        AFCONVERT,
        ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, output],
        { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: CONVERSION_MAX_BUFFER },
      ),
    }
  }
  return {
    name: 'ffmpeg',
    run: (input, output) => run(
      'ffmpeg',
      ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output],
      { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: CONVERSION_MAX_BUFFER },
    ),
  }
}

/**
 * Rebuild one RIFF/WAVE file in the exact 44-byte canonical layout the speech
 * intake validates.
 *
 * afconvert writes WAVE_FORMAT_EXTENSIBLE for an AAC source: a 40-byte fmt
 * chunk and a channel mask. That is a valid WAV, but DSH's intake compares the
 * header byte for byte, so it refuses it. The PCM payload is already 16 kHz
 * mono PCM16, so replacing the header restores the canonical form without
 * re-encoding. Anything that is not already 16 kHz mono PCM16 is refused
 * instead of being re-labelled by a forged header.
 *
 * @param {Buffer} wav converted WAVE bytes.
 * @returns {Buffer} canonical 16 kHz mono PCM16 WAVE.
 * @throws {AudioConversionError} when the WAVE is malformed or the wrong shape.
 */
export function canonicalizeWave(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 12
    || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioConversionError('the converter did not produce a WAVE file')
  }
  let sawFormat = false
  let audio
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > wav.length) throw new AudioConversionError('the converted WAVE is truncated')
    if (id === 'fmt ') {
      if (size < 16) throw new AudioConversionError('the converted WAVE has no usable fmt chunk')
      const tag = wav.readUInt16LE(start)
      const channels = wav.readUInt16LE(start + 2)
      const sampleRate = wav.readUInt32LE(start + 4)
      const bits = wav.readUInt16LE(start + 14)
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE) carries the real tag in its GUID.
      const pcm = tag === 1 || (tag === 0xFFFE && size >= 26 && wav.readUInt16LE(start + 24) === 1)
      if (!pcm || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw new AudioConversionError('the converter produced audio that is not 16 kHz mono PCM16')
      }
      sawFormat = true
    } else if (id === 'data') {
      audio = wav.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (!sawFormat || audio === undefined || audio.length === 0) {
    throw new AudioConversionError('the converted WAVE has no audio payload')
  }
  if (audio.length % 2 !== 0) throw new AudioConversionError('the converted WAVE has an odd payload length')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + audio.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(audio.length, 40)
  return Buffer.concat([header, audio])
}

/**
 * Convert one compressed recording to the canonical WAV the speech intake
 * validates (16 kHz mono PCM16), on a private temp directory.
 *
 * @param {Buffer|Uint8Array} bytes recorded audio.
 * @param {object} [options] options.
 * @param {string} [options.mime] declared media type (selects the input extension).
 * @returns {Promise<Buffer>} canonical WAV bytes.
 * @throws {NoAudioConverterError} when neither afconvert nor ffmpeg is installed.
 * @throws {AudioConversionError} when the converter could not produce usable audio.
 */
export async function convertToWav(bytes, { mime } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dictation-'))
  try {
    const input = join(directory, 'recording' + extensionFor(mime))
    const output = join(directory, 'recording.wav')
    // The recording is the sensitive input: private file in a private directory.
    await writeFile(input, bytes, { mode: 0o600 })
    const plan = converterPlan()
    try {
      await plan.run(input, output)
    } catch (error) {
      // A missing binary is not a conversion failure: this host simply cannot
      // convert, and the caller says so instead of blaming the recording.
      if (error?.code === 'ENOENT') {
        throw new NoAudioConverterError('no audio converter is installed (afconvert or ffmpeg is required)')
      }
      // The converter's own diagnostic stays out of the client's hands but not
      // out of the log: it is the only record of why a recording was refused.
      const diagnostic = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 400)
      throw new AudioConversionError('the recording could not be converted to WAV' + (diagnostic.length > 0 ? ': ' + diagnostic : ''))
    }
    // The converter created the output; narrow it to the same mode as the input
    // before it is read, so no other local user can read the recording.
    await chmod(output, 0o600).catch(() => {})
    const wav = await readFile(output)
    if (wav.length === 0) throw new AudioConversionError('the conversion produced no audio')
    // afconvert's WAVE_FORMAT_EXTENSIBLE output is a valid WAV, not the exact
    // canonical one the speech intake compares; normalise the header before it
    // can be refused downstream.
    const canonical = canonicalizeWave(wav)
    if (canonical.length > MAX_CONVERTED_BYTES) throw new AudioConversionError('the converted recording is too large')
    return canonical
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
