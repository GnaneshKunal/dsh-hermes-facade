# Changelog

Notable changes to dsh-hermes-facade. Version headings correspond to releases; unreleased
changes accumulate at the top. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **Session export.** `GET /api/session/export` now answers (it was a 404; only
  `POST` was stubbed). `format=json` (the default when the param is absent) returns the
  machine-readable dump the app's Move-to-Hermes import reads (`session_id`, `messages`,
  `archived`, timestamps, model and token totals); `format=html` returns a self-contained
  transcript for sharing; `format=markdown` (also `md`) is accepted for human-readable
  copies. The transcript is the same `timelineOf()` mapping `GET /api/session` serves, and
  the response carries the file's `Content-Type` plus
  `Content-Disposition: attachment; filename="hermes-<session_id>.<ext>"`, which is where the
  app reads the share-sheet filename from. An unsupported format is a 400, an unknown session
  a 404.
- **Pinned and archived sessions are visible.** The session list used to report
  `pinned:false, archived:false` for every row and never listed an archived chat, even though
  the pin/archive writes already landed in DSH. `host.workspaces()` now captures the
  registry-global `pinnedSessionIds`/`archivedSessionIds` from the workspace baseline, and each
  list/detail row carries the real flags. The default response still hides archived rows and
  reports the full `archived_count`, so the app's Archived entry appears; `include_archived=1`
  (or `true`/`yes`) appends them, and `archived_limit` caps how many archived rows are sent.
  Pin and archive writes now drop the cached workspace baseline too, so the next list read
  shows the change instead of waiting out the cache.
- **Live model overlay.** `GET /api/models/live` returns the cached catalog in the shape the
  picker's overlay expects — `{provider, models:[{id,label}], count}` — using the same group
  and provider-id spelling as `/api/models`. It echoes the active provider (or the requested
  `provider`) so the app can replace the matching group instead of blanking the picker.
- **Providers list.** `GET /api/providers` now derives its entries from the model catalog's
  provider groups rather than answering an empty stub: `id`, `display_name`, `has_key`, the
  provider's models and `models_total`, plus `active_provider`. A provider the catalog could
  not list appears with the host's message in `auth_error`.
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
- `/health` also advertises two new build markers, `approval-retract` and `clarify-markers`, so a
  hot-reloaded build can be told apart from one that still loses approval details on reconnect.

### Fixed

- **Subagent sessions are hidden for now.** DSH child-agent sessions (`origin: "subagent"`) are
  runner-owned and only addressable through their durable parent; listing them made Hermex show
  them as ordinary chats, and a plain open returned a 500 ("subagent Sessions require their
  durable parent address"). `GET /api/sessions` now filters them out and a direct open answers 400
  with a readable detail. Hermex's own Settings → Sessions → Subagent Sessions toggle can show
  them only when rows are tagged `session_source: "subagent"` and reads use the parent address;
  that is future work (see docs/05).
- **A failed or cancelled turn no longer looks successful.** The terminal SSE event was always
  `done`, so a provider error, a blocked turn, an output-token cut-off and a cancel all told the
  phone the run completed. `turn/end.reason` is classified now: `completed` keeps `done`,
  `aborted` (user Stop, parent, dispose) sends `cancel`, and every other kind (`error`,
  `blocked`, `max-tokens`, `interrupted`, or a kind a host plugin adds) sends `error` carrying
  the reason's message. `error`/`cancel` are closing frames for the app, so they are not
  followed by `stream_end`, `/api/chat/stream/status` reports the matching `terminal_state`,
  and a replayed journal ends the same way. A `turn/end` with no reason (an older host, or an
  event synthesized without one) still completes, so a host that reports nothing keeps the old
  behaviour. `scripts/standalone.mjs --turn-outcome failed|cancelled` — and the mock host's
  `setTurnOutcome` — emit these turns for a hand probe or an integration test.
- **Finished stream journals are pruned.** `streams.mjs` had a `prune()` no one called, so
  every finished turn's replay journal stayed in memory for the process lifetime. `finish()`
  now stamps `finishedAt` and prunes: finished streams older than the replay window (30 min by
  default, `streamRetainMs` to tune it) go, and at most 64 finished streams are kept for
  reconnect, oldest first. Live streams are never pruned.
- **Approval cards explain themselves after a reconnect.** `GET /api/approval/pending` and the
  `initial`/live SSE payloads used to carry only `approval_id`, so a phone that re-attached (or
  polled) showed a bare card with no command/description. The pending record now keeps both — the
  tool name as `command`, the asker's localized `displayReason.en` (else its `reason`) as
  `description` — and every payload is built from it. The pending approval is also retracted when
  it stops being answerable: answering it, a GUI-side answer, a cancelled turn and the 10-minute
  timeout all send `{"pending":null,"pending_count":0}` on `/api/approval/stream` and on the live
  chat stream, and responding to an id that is already resolved (or timed out) answers
  `409 {"stale":true}`, which the app renders as "that approval request already expired" and
  dismisses the card. An empty/unknown `choice` is refused with `200 {ok:false}` instead of
  silently becoming a grant.
- **Approve for a session, or always.** "Allow session" and "Always allow" were collapsed into a
  single `allowed-once` and forgotten, so the card came straight back. DeepSeek Harness's approval
  contract grants exactly one outcome (`allowed-once`; the other vocabulary is `rejected`,
  `cancelled`, `unavailable`), so the wider scopes are now held by the facade: the current ask is
  still granted with `allowed-once`, and the tool is remembered for the rest of that session
  ("session") or for the process ("always"), answering later asks for the same tool without a new
  card. The grant is keyed by tool name — the only subject the host exposes — so it is coarser than
  webui's command-pattern allowlist; `pattern_key`/`pattern_keys` are still not sent, so the app's
  "Allow session covers every …" sentence stays hidden. "Deny" still rejects once and remembers
  nothing.
- **A clarification re-attaches as a clarification.** `GET /api/clarify/pending` and the `initial`
  SSE payload sent only `{clarify_id}`; the app classifies a pending payload by
  `question`/`choices_offered`, so a re-attached prompt rendered as an approval card whose respond
  could never succeed. The pending record now keeps the question, the offered choice labels,
  `session_id` and `requested_at`, and the clarify stream clears the card
  (`{"pending":null,"pending_count":0}`) when the prompt resolves or times out. The answer batch now
  names the question id the host echoed, as `AskUserQuestionAnswerItem` requires, so the model sees
  which question was answered rather than an anonymous `{selected:[…]}`.
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

