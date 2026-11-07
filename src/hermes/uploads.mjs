/**
 * Upload staging helpers shared by the Hermes listener and its RPC methods.
 *
 * The phone sends a data URL; the facade writes one generated leaf under its
 * uploads root and later reads it back for the image part or the app's preview.
 *
 * @module dsh-hermes-facade/src/hermes/uploads
 */

import { basename, extname } from 'node:path'

/**
 * A filename safe for one uploaded file's leaf name.
 * @param {string} value client name.
 * @param {string} fallback fallback stem.
 * @returns {string} leaf name.
 */
export function sanitizeUploadName(value, fallback) {
  const base = basename(String(value ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').trim()
  return (cleaned.length > 0 ? cleaned : fallback).slice(0, 120)
}

/**
 * Decode a data URL, or null when it is malformed or too large.
 * @param {string} value data URL.
 * @param {number} maxBytes limit.
 * @returns {{mime: string, bytes: Buffer}|null} decoded bytes.
 */
export function decodeUpload(value, maxBytes) {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(value ?? ''))
  if (match === null) return null
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.length > maxBytes) return null
  return { mime: match[1].toLowerCase(), bytes }
}

/**
 * The media type of a staged image leaf, or null.
 * @param {string} path file path.
 * @returns {string|null} media type.
 */
export function imageMediaType(path) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[extname(path).toLowerCase()] ?? null
}
