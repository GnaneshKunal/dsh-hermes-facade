/**
 * Password verification and signed-cookie sessions.
 *
 * The iOS client never reads a token: it keeps cookies in URLSession's shared
 * storage and replays them on /api/* and on the SSE stream. So the cookie is
 * the entire authentication boundary.
 *
 * @module dsh-hermes-facade/src/auth
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readOptional } from './config.mjs'

/** Cookie name the app echoes back. */
export const COOKIE_NAME = 'hermes_session'

/** scrypt cost parameters. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

/**
 * Encode a buffer as unpadded base64url.
 * @param {Buffer|string} value input.
 * @returns {string} encoded.
 */
function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode base64url with optional padding.
 * @param {string} value encoded input.
 * @returns {Buffer} decoded bytes.
 */
function unb64url(value) {
  const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalised, 'base64')
}

/**
 * Constant-time string compare.
 * @param {string} a left.
 * @param {string} b right.
 * @returns {boolean} equal.
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Manage the facade password, cookie secret and session cookies.
 * @param {object} options options.
 * @param {string} options.dir state directory.
 * @param {number} options.ttlSeconds cookie lifetime.
 * @returns {object} auth surface.
 */
export function createAuth({ dir, ttlSeconds }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const secretPath = join(dir, 'secret')
  const passwordPath = join(dir, 'password.json')

  const existingSecret = readOptional(secretPath)
  let secret
  if (typeof existingSecret === 'string' && existingSecret.trim().length >= 32) {
    secret = existingSecret.trim()
  } else {
    secret = randomBytes(32).toString('hex')
    writeFileSync(secretPath, secret + '\n', { mode: 0o600 })
  }

  let record
  let generatedPassword

  const stored = readOptional(passwordPath)
  if (typeof stored === 'string' && stored.trim().length > 0) {
    try { record = JSON.parse(stored) } catch { record = undefined }
  }
  if (record === undefined || typeof record.hash !== 'string' || typeof record.salt !== 'string') {
    generatedPassword = randomBytes(9).toString('base64url')
    const salt = randomBytes(16).toString('hex')
    record = { salt, hash: scryptSync(generatedPassword, salt, SCRYPT.keylen, SCRYPT).toString('hex') }
    writeFileSync(passwordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  }

  /**
   * Verify a submitted password.
   * @param {unknown} candidate submitted password.
   * @returns {boolean} accepted.
   */
  function verifyPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false
    const derived = scryptSync(candidate, record.salt, SCRYPT.keylen, SCRYPT)
    return timingSafeEqual(derived, Buffer.from(record.hash, 'hex'))
  }

  /**
   * Sign a session cookie.
   * @param {number} now epoch milliseconds.
   * @returns {string} cookie value.
   */
  function issueCookie(now = Date.now()) {
    const claims = { iat: Math.floor(now / 1000), exp: Math.floor((now + ttlSeconds * 1000) / 1000) }
    const payload = b64url(JSON.stringify(claims))
    const mac = b64url(createHmac('sha256', secret).update(payload).digest())
    return payload + '.' + mac
  }

  /**
   * Validate a session cookie.
   * @param {string|undefined} value cookie value.
   * @param {number} now epoch milliseconds.
   * @returns {boolean} valid and unexpired.
   */
  function verifyCookie(value, now = Date.now()) {
    if (typeof value !== 'string') return false
    const dot = value.indexOf('.')
    if (dot <= 0) return false
    const payload = value.slice(0, dot)
    const mac = value.slice(dot + 1)
    const expected = b64url(createHmac('sha256', secret).update(payload).digest())
    if (!safeEqual(mac, expected)) return false
    try {
      const claims = JSON.parse(unb64url(payload).toString('utf8'))
      return Number.isSafeInteger(claims.exp) && claims.exp * 1000 > now
    } catch {
      return false
    }
  }

  /**
   * Read the session cookie from a request.
   * @param {import('node:http').IncomingMessage} req request.
   * @returns {string|undefined} cookie value.
   */
  function cookieFrom(req) {
    const header = req.headers.cookie
    if (typeof header !== 'string' || header.length === 0) return undefined
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
    return undefined
  }

  return {
    verifyPassword,
    issueCookie,
    verifyCookie,
    cookieFrom,
    generatedPassword,
    secretPath,
    passwordPath,
  }
}
