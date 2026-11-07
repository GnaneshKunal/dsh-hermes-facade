import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename, exportFormat, renderExport } from '../src/exporter.mjs';

/**
 * A small session row in the shape detailOf() produces.
 * @returns {object} session.
 */
function session() {
  return {
    session_id: 'abc-123',
    title: 'A <script> title',
    workspace: '/tmp/work',
    created_at: 1700000000,
    updated_at: 1700000060,
    pinned: true,
    archived: false,
    model: 'deepseek-v4-pro',
    model_provider: 'deepseek-official',
    input_tokens: 12,
    output_tokens: 34,
    message_count: 2,
  };
}

/**
 * Two display messages, one carrying a tool call.
 * @returns {Array<object>} messages.
 */
function messages() {
  return [
    { role: 'user', content: 'hello <world>', timestamp: 1700000001 },
    {
      role: 'assistant',
      content: 'answer & more',
      reasoning: 'why',
      timestamp: 1700000002,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp"}' } }],
    },
  ];
}

test('exportFormat defaults to json and accepts the client spellings', () => {
  assert.equal(exportFormat(undefined)?.name, 'json');
  assert.equal(exportFormat(null)?.name, 'json');
  assert.equal(exportFormat('')?.name, 'json');
  assert.equal(exportFormat('JSON')?.name, 'json');
  assert.equal(exportFormat('html')?.contentType, 'text/html; charset=utf-8');
  assert.equal(exportFormat('markdown')?.extension, 'md');
  assert.equal(exportFormat('md')?.name, 'markdown');
  assert.equal(exportFormat('pdf'), undefined, 'an unknown format must be a 400, not json');
});

test('exportFilename follows the upstream hermes-<sid>.<ext> spelling', () => {
  assert.equal(exportFilename('abc-123', 'json'), 'hermes-abc-123.json');
  assert.equal(exportFilename('../../etc/passwd', 'html'), 'hermes-etc-passwd.html');
  assert.equal(exportFilename('   ', 'md'), 'hermes-session.md');
  assert.equal(exportFilename('a b/c', 'html'), 'hermes-a-b-c.html');
});

test('a JSON export is a machine-readable dump with the Move-to-Hermes keys', () => {
  const format = exportFormat('json');
  const file = renderExport({
    format,
    session: session(),
    messages: messages(),
    toolCalls: [{ name: 'read', tid: 't1', assistant_msg_idx: 1 }],
  });
  assert.equal(file.contentType, 'application/json; charset=utf-8');
  const payload = JSON.parse(file.body);
  assert.equal(payload.session_id, 'abc-123');
  assert.equal(payload.title, 'A <script> title');
  assert.equal(payload.archived, false);
  assert.equal(payload.pinned, true);
  assert.equal(payload.created_at, 1700000000);
  assert.equal(payload.model, 'deepseek-v4-pro');
  assert.equal(payload.input_tokens, 12);
  assert.equal(payload.message_count, 2);
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].role, 'user');
  assert.equal(payload.messages[1].content, 'answer & more');
  assert.equal(payload.tool_calls[0].tid, 't1');
});

test('an HTML export is self-contained and escapes transcript content', () => {
  const file = renderExport({ format: exportFormat('html'), session: session(), messages: messages() });
  assert.equal(file.contentType, 'text/html; charset=utf-8');
  assert.match(file.body, /^<!doctype html>/);
  assert.match(file.body, /<title>A &lt;script&gt; title<\/title>/);
  assert.match(file.body, /hello &lt;world&gt;/);
  assert.match(file.body, /answer &amp; more/);
  assert.ok(!file.body.includes('<script>'), 'a transcript cannot inject markup');
  assert.match(file.body, /class="message user"/);
  assert.match(file.body, /class="message assistant"/);
  assert.match(file.body, /Tool calls/);
  assert.match(file.body, /Reasoning/);
});

test('a markdown export has role sections and the tool call', () => {
  const file = renderExport({ format: exportFormat('markdown'), session: session(), messages: messages() });
  assert.equal(file.contentType, 'text/markdown; charset=utf-8');
  assert.match(file.body, /^# A <script> title/m);
  assert.match(file.body, /^- \*\*Session:\*\* abc-123$/m);
  assert.match(file.body, /^## Me$/m);
  assert.match(file.body, /^## Assistant$/m);
  assert.match(file.body, /^- \x60read\x60:/m);
});
