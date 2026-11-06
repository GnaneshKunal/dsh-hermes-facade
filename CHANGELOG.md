# Changelog

Notable changes to dsh-hermes-facade. Version headings correspond to releases; unreleased
changes accumulate at the top. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

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

