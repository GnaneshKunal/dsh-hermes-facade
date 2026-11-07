# Changelog

Notable changes to dsh-hermes-facade. Version headings correspond to releases; unreleased
changes accumulate at the top. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **Diagnostics.** `~/.dsh/hermes-facade/access.log` records one JSON line per request
  (method, path, query, status, duration, user-agent) with `unknown`/`stub`/`effort`/`error`
  annotations, and `unknown-endpoints.log` records — always, with no flag to turn on — every call
  to an endpoint the facade does not implement, including the request body. `client_gone: true`
  marks a request the client abandoned before the answer, which is what a client-side timeout
  looks like from the server. Both rotate at 1 MiB and never throw.
- `GET /api/list` and `GET /api/file` serve the workspace file browser: a directory listing and a
  text file's content. They were 404s, which the app renders as "the endpoint was not found".
- **Compatibility matrix.** [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md)
  records every Hermex 2.0.1 surface, the endpoint behind it, the current state, what the phone
  shows, and whether the gap is bridgeable in this plugin, needs a DSH primitive, or belongs to the
  Hermes gateway transport. README's support table and docs/00's design snapshot now point at it.
- **Transcript paging.** `GET /api/session` now honours `msg_before` and returns a real
  `messages_offset`/`messages_truncated` cursor, and the first page is 200 messages instead of the
  50 the client asks for. A chat can be scrolled back through its whole (bounded) transcript instead
  of stopping at the newest window; `message_count` is the total, not the page length. Config
  `historyWindow` (default 800) and `historyPage` (default 200) tune it.
- `/health` also reports `active_streams`, the `history` page/window sizes and a `features` list.
  The client ignores unknown keys; they let an external check see which build is live and whether a
  turn is streaming.
- **Tool results in reloaded transcripts.** `GET /api/session` now emits the client's
  `tool_calls` list, built from the session's `tool/call` and `tool/result` events: name, a
  bounded result preview, error verdict, duration and the anchored assistant message index. A
  reopened chat draws completed tool cards with their output instead of bare calls. Messages stay
  user/assistant only, so hidden `role:"tool"` rows never consume a page; arguments still ride on
  each assistant message's `tool_calls`, and a compaction-replaced result is priced against the
  event it replaced so its duration stays truthful.

### Fixed

- **Subagent sessions are hidden for now.** DSH child-agent sessions (`origin: "subagent"`) are
  runner-owned and only addressable through their durable parent; listing them made Hermex show
  them as ordinary chats, and a plain open returned a 500 ("subagent Sessions require their
  durable parent address"). `GET /api/sessions` now filters them out and a direct open answers 400
  with a readable detail. Hermex's own Settings → Sessions → Subagent Sessions toggle can show
  them only when rows are tagged `session_source: "subagent"` and reads use the parent address;
  that is future work (see docs/05).
- **The model picker actually applies.** `POST /api/session/update` (the picker's call),
  `POST /api/session/new` and `POST /api/chat/start` used to drop `model`/`model_provider`; the
  chip showed a model the next turn did not use. They now resolve the client's id against the DSH
  model catalog — `@provider:`-prefixed ids are split into provider + catalog id; slash-bearing
  ids such as `deepseek/deepseek-v4.1-flash-1017` are matched as the catalog id itself — and apply
  it through `session/selectModel`, carrying the reasoning effort over when the new model offers
  it and falling back to the model's declared default (then its first level) otherwise. An
  unavailable model answers 400 with the catalog error instead of silently keeping the old one.
  `/api/models` also sends each group's `provider_id`, so the picker reports the route it chose.
- **Reasoning effort.** `projections.values.modelSelection` is `{lastUsed, next|pending}` in the
  host schema, not a flat `{provider, model, reasoningEffort}`; reading it flat made the GET always
  report `medium` and made every POST reach `session/selectModel` without a provider or model, so
  each change was rejected with a validation error the app showed as a failed request.
- **Effort levels** now come from the model catalog (`off/low/medium/high/max` for this
  deployment) instead of a hard-coded OpenAI list that advertised `xhigh`, a level the adapter
  rejects. A stale client spelling is translated (`xhigh → max`, `none → off`, `minimal → low`),
  and an impossible level answers `200 {ok:false}` listing the real ones.
- **Hot reload no longer races the port.** The plugin's disposer fired `facade.close()` without
  awaiting it, so a cordis module replacement could start the new listener before the old one
  released 9120 (EADDRINUSE). The disposer now returns the close promise, which cordis awaits.
- **Reads are bounded.** `/api/models`, `/api/workspaces`, `/api/projects` and `/api/reasoning`
  now give up after 8 s and answer a well-formed default instead of holding the connection open;
  the catalog is cached for 15 s and warmed at mount, so the first composer open is not a cold
  multi-provider query.
- `POST /api/default-model` answered twice (the handler fell through to the catch-all after
  sending its body); it now answers once and says the default lives in dsh configuration.

## [0.1.0] - 2026-11-06

First release. A DSH host plugin that impersonates a **hermes-webui** server so the stock
[Hermex](https://apps.apple.com/us/app/hermex/id6767006319) iOS app (MIT, App Store) drives a
local DeepSeek Harness agent. Six endpoints classes were derived from the client's own Swift
source rather than guessed.

### Added

- Health and auth: `GET /health`, `GET /api/auth/status`, `POST /api/auth/login|logout` with a
  scrypt-verified password, an HMAC-signed cookie and 5 attempts per 15 minutes per address.
- Sessions: `GET /api/sessions`, `GET /api/session`, `POST /api/session/new|rename|pin|archive|branch`,
  mapped onto `session/list`, `session/follow`, `session/create`, `session/rename`,
  `workspace/pinSession`, `workspace/archiveSession` and `session/fork`.
- Chat: `POST /api/chat/start`, `GET /api/chat/stream`, `GET /api/chat/cancel`,
  `GET /api/chat/stream/status`, `POST /api/chat/steer`. SSE carries `token`, `reasoning`,
  `tool`, `tool_complete`, `title`, `done` and `stream_end`, with a replay journal so a
  reconnect or an early-finishing run still delivers the whole answer.
- Human in the loop: `approval/*` and `clarify/*` bridged to the host's `approval/request` and
  `user-questions/request` cordis waterfalls. These routes always answer 200 with a pending
  body, because a 404 there silently hangs the run.
- Composer: `/api/models`, `/api/commands`, `/api/workspaces`, `/api/profiles`, `/api/reasoning`
  (GET reports the saved effort, POST applies it through `session/selectModel`).
- Media: `GET /api/media` and `/api/file/raw` serve an absolute path, a session-relative path or
  an attachment id from the content-addressed store, so agent-generated images render.
- `POST /api/chat/start` adopts the session into the workspace the client names
  (`workspace/insertSessionBefore`) — Hermex names the project one request after creating the
  session, so creation alone could never group it.
- Every other write answers `200 {ok:false, error}` instead of 404, so the app shows a message
  rather than "the server endpoint was not found".

### Notes

- The facade impersonates the **webui** stack, not the Hermes gateway stack: Hermex's main app
  speaks webui, and only the Bot screens use the JSON-RPC gateway.
- `docs/02-hermex-client-wire.md` is the implementation contract, read from the client's Swift.
- 48 tests: unit mapping, HTTP/SSE integration, host adapter and plugin-entry smoke tests.

