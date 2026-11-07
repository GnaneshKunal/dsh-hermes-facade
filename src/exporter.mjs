/**
 * Session export rendering for `GET /api/session/export`.
 *
 * Hermex downloads the transcript as a file (not a JSON envelope) and reads the
 * filename from `Content-Disposition`. The app itself only asks for `json` and
 * `html`; markdown is offered because it is the only format that survives a
 * copy/paste and costs nothing to render. The transcript is the same
 * `timelineOf()` mapping that `GET /api/session` serves, so a reopened chat and
 * its export show the same messages.
 *
 * @module dsh-hermes-facade/src/exporter
 */

/** Content type and extension per accepted format spelling. */
const FORMATS = new Map([
  ['json', { name: 'json', contentType: 'application/json; charset=utf-8', extension: 'json' }],
  ['html', { name: 'html', contentType: 'text/html; charset=utf-8', extension: 'html' }],
  ['markdown', { name: 'markdown', contentType: 'text/markdown; charset=utf-8', extension: 'md' }],
  ['md', { name: 'markdown', contentType: 'text/markdown; charset=utf-8', extension: 'md' }],
])

/**
 * Resolve the client's `format` query param.
 *
 * Absent (or empty) means JSON, matching the client's comment that the server
 * defaults to JSON when the param is absent. An unknown spelling resolves to
 * `undefined` so the route can answer 400 instead of silently sending a format
 * the caller did not ask for.
 *
 * @param {string|null|undefined} raw query value.
 * @returns {{name: string, contentType: string, extension: string}|undefined} format.
 */
export function exportFormat(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  if (name === '') return FORMATS.get('json')
  return FORMATS.get(name)
}

/**
 * Build the `Content-Disposition` filename for an export.
 *
 * The client sanitises whatever comes back, but a hostile session id must not
 * be able to escape the filename either; the upstream spelling is
 * `hermes-<sid>.<ext>`.
 *
 * @param {string} sessionId session id.
 * @param {string} extension file extension.
 * @returns {string} filename.
 */
export function exportFilename(sessionId, extension) {
  const stem = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return 'hermes-' + (stem.length > 0 ? stem : 'session') + '.' + extension
}

/**
 * Escape text for HTML element content and attribute values.
 * @param {unknown} value raw value.
 * @returns {string} escaped text.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render an epoch-seconds timestamp as ISO-8601, or an empty string.
 * @param {unknown} value epoch seconds.
 * @returns {string} display time.
 */
function displayTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/**
 * JSON session dump. The shape keeps the keys the app's Move-to-Hermes import
 * reads (`session_id`, `messages`, `archived`, `created_at`, `model`,
 * token totals), so an exported chat can be imported back into a Hermes host.
 * @param {object} session Hermex session row.
 * @param {Array<object>} messages display messages.
 * @param {Array<object>} toolCalls persisted tool calls.
 * @returns {string} JSON text.
 */
function renderJson(session, messages, toolCalls) {
  const payload = {
    profile: 'default',
    session_id: String(session.session_id ?? ''),
    title: String(session.title ?? ''),
    workspace: String(session.workspace ?? ''),
    created_at: session.created_at ?? null,
    updated_at: session.updated_at ?? null,
    pinned: session.pinned === true,
    archived: session.archived === true,
    ...(typeof session.model === 'string' ? { model: session.model } : {}),
    ...(typeof session.model_provider === 'string' ? { model_provider: session.model_provider } : {}),
    ...(Number.isSafeInteger(session.input_tokens) ? { input_tokens: session.input_tokens } : {}),
    ...(Number.isSafeInteger(session.output_tokens) ? { output_tokens: session.output_tokens } : {}),
    ...(Number.isSafeInteger(session.context_length) ? { context_length: session.context_length } : {}),
    ...(Number.isSafeInteger(session.last_prompt_tokens) ? { last_prompt_tokens: session.last_prompt_tokens } : {}),
    message_count: messages.length,
    messages,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * One message as an HTML article.
 * @param {object} message display message.
 * @returns {string} HTML.
 */
function renderHtmlMessage(message) {
  const role = message?.role === 'user' ? 'user' : 'assistant'
  const label = role === 'user' ? 'Me' : 'Assistant'
  const time = displayTime(message?.timestamp)
  const content = escapeHtml(message?.content ?? '')
  const parts = [
    '<article class="message ' + role + '">',
    '  <header><span class="role">' + label + '</span>' + (time ? '<time>' + escapeHtml(time) + '</time>' : '') + '</header>',
    '  <div class="content">' + content + '</div>',
  ]
  if (typeof message?.reasoning === 'string' && message.reasoning.length > 0) {
    parts.push('  <details class="reasoning"><summary>Reasoning</summary><pre>' + escapeHtml(message.reasoning) + '</pre></details>')
  }
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (calls.length > 0) {
    const items = calls.map(call => {
      const name = escapeHtml(call?.function?.name ?? call?.name ?? 'tool')
      const raw = call?.function?.arguments ?? call?.arguments
      const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
      return '    <li><code>' + name + '</code><pre>' + escapeHtml(args) + '</pre></li>'
    })
    parts.push('  <div class="tools"><span>Tool calls</span><ul>')
    parts.push(...items)
    parts.push('  </ul></div>')
  }
  parts.push('</article>')
  return parts.join('\n')
}

/**
 * Self-contained HTML transcript.
 * @param {object} session Hermex session row.
 * @param {Array<object>} messages display messages.
 * @returns {string} HTML text.
 */
function renderHtml(session, messages) {
  const title = String(session.title ?? '').length > 0 ? String(session.title) : String(session.session_id ?? 'Session')
  const meta = [
    ['Session', session.session_id],
    ['Workspace', session.workspace],
    ['Model', [session.model, session.model_provider].filter(value => typeof value === 'string' && value.length > 0).join(' · ')],
    ['Started', displayTime(session.created_at)],
    ['Updated', displayTime(session.updated_at)],
    ['Messages', String(messages.length)],
  ].filter(([, value]) => typeof value === 'string' && value.length > 0)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>',
    ':root { color-scheme: light dark; }',
    'body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0 auto; max-width: 52rem; padding: 1.5rem; }',
    'h1 { font-size: 1.5rem; margin: 0 0 1rem; }',
    'dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0 0 2rem; font-size: 0.875rem; opacity: 0.8; }',
    'dl.meta dt { font-weight: 600; }',
    'dl.meta dd { margin: 0; overflow-wrap: anywhere; }',
    '.message { border-top: 1px solid rgba(127,127,127,0.35); padding: 1rem 0; }',
    '.message header { display: flex; gap: 0.75rem; align-items: baseline; font-size: 0.8125rem; opacity: 0.75; margin-bottom: 0.5rem; }',
    '.message .role { font-weight: 700; }',
    '.content { white-space: pre-wrap; overflow-wrap: anywhere; }',
    '.tools { margin-top: 0.75rem; font-size: 0.8125rem; opacity: 0.85; }',
    '.tools ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }',
    '.tools pre, .reasoning pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8125rem; }',
    'details { margin-top: 0.75rem; font-size: 0.875rem; }',
    '</style>',
    '</head>',
    '<body>',
    '<h1>' + escapeHtml(title) + '</h1>',
    '<dl class="meta">' + meta.map(([label, value]) => '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd>').join('') + '</dl>',
    messages.map(renderHtmlMessage).join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * Human-readable markdown transcript.
 * @param {object} session Hermex session row.
 * @param {Array<object>} messages display messages.
 * @returns {string} markdown text.
 */
function renderMarkdown(session, messages) {
  const title = String(session.title ?? '').length > 0 ? String(session.title) : String(session.session_id ?? 'Session')
  const lines = ['# ' + title, '']
  const facts = [
    ['Session', session.session_id],
    ['Workspace', session.workspace],
    ['Model', [session.model, session.model_provider].filter(value => typeof value === 'string' && value.length > 0).join(' · ')],
    ['Started', displayTime(session.created_at)],
    ['Updated', displayTime(session.updated_at)],
    ['Messages', String(messages.length)],
  ].filter(([, value]) => typeof value === 'string' && value.length > 0)
  for (const [label, value] of facts) lines.push('- **' + label + ':** ' + value)
  lines.push('', '---', '')
  for (const message of messages) {
    lines.push('## ' + (message?.role === 'user' ? 'Me' : 'Assistant'), '')
    const content = String(message?.content ?? '')
    if (content.length > 0) lines.push(content, '')
    if (typeof message?.reasoning === 'string' && message.reasoning.length > 0) {
      lines.push('> **Reasoning**', '>', ...message.reasoning.split('\n').map(line => '> ' + line), '')
    }
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (calls.length > 0) {
      for (const call of calls) {
        const name = call?.function?.name ?? call?.name ?? 'tool'
        const raw = call?.function?.arguments ?? call?.arguments
        const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
        // Inline code cannot carry a backtick; swap it for an apostrophe so the
        // row cannot break out of its own Markdown span.
        const safeArgs = String(args).replaceAll('`', "'")
        lines.push('- `' + String(name) + '`: `' + safeArgs + '`')
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * Render one session export.
 * @param {object} input input.
 * @param {{name: string, contentType: string, extension: string}} input.format resolved format.
 * @param {object} input.session Hermex session row.
 * @param {Array<object>} [input.messages] display messages.
 * @param {Array<object>} [input.toolCalls] persisted tool calls.
 * @returns {{contentType: string, extension: string, body: string}} export file.
 */
export function renderExport({ format, session, messages = [], toolCalls = [] }) {
  const body = format.name === 'json'
    ? renderJson(session, messages, toolCalls)
    : format.name === 'html'
      ? renderHtml(session, messages)
      : renderMarkdown(session, messages)
  return { contentType: format.contentType, extension: format.extension, body }
}
