/**
 * Loopback client for the webui facade.
 *
 * The Hermes-protocol listener does not re-derive anything from DSH: it calls
 * the facade's own REST + SSE surface on 127.0.0.1 with the internal token,
 * and translates. That keeps one implementation of every DSH mapping.
 *
 * @module dsh-hermes-facade/src/hermes/backend
 */

/** Default deadline for one facade call. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Append query parameters, skipping absent values.
 * @param {URL} url target.
 * @param {object} [query] params.
 * @returns {URL} same url.
 */
function withQuery(url, query) {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

/**
 * Parse one SSE block.
 * @param {string} block raw block without the blank-line terminator.
 * @returns {{event: string, data: string, id?: string}|undefined} parsed event.
 */
export function parseSseBlock(block) {
  let event = 'message'
  let id
  const data = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (data.length === 0 && event === 'message') return undefined
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) }
}

/**
 * Create the facade client.
 * @param {object} options options.
 * @param {string} options.baseUrl facade origin.
 * @param {string} options.token internal token.
 * @param {typeof fetch} [options.fetchImpl] injectable fetch.
 * @returns {object} backend.
 */
export function createBackend({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const origin = String(baseUrl).replace(/\/+$/, '')

  /**
   * One JSON request.
   * @param {string} method HTTP method.
   * @param {string} path path beginning with /.
   * @param {object} [options] request options.
   * @returns {Promise<{status: number, headers: Headers, text: string, json: any}>} reply.
   */
  async function call(method, path, options = {}) {
    const url = withQuery(new URL(origin + path), options.query)
    const headers = { 'x-facade-internal': token }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (typeof options.accept === 'string') headers.accept = options.accept
    const response = await fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const text = await response.text()
    let json
    try { json = text.length > 0 ? JSON.parse(text) : undefined } catch { json = undefined }
    return { status: response.status, headers: response.headers, text, json }
  }

  /**
   * Follow one SSE stream until it ends.
   * @param {string} path path beginning with /.
   * @param {object} [options] stream options.
   * @returns {AsyncGenerator<{event: string, data: string}>} frames.
   */
  async function* stream(path, options = {}) {
    const url = withQuery(new URL(origin + path), options.query)
    const response = await fetchImpl(url, {
      headers: { 'x-facade-internal': token, accept: 'text/event-stream' },
      signal: options.signal,
    })
    if (!response.ok || response.body === null) {
      throw new Error('facade stream refused: HTTP ' + response.status)
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const frame = parseSseBlock(block)
        if (frame !== undefined) yield frame
      }
    }
    buffer += decoder.decode()
    const tail = parseSseBlock(buffer)
    if (tail !== undefined) yield tail
  }

  return { call, stream, origin, token }
}
