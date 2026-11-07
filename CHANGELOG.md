# Changelog

Notable changes to dsh-hermes-facade. Version headings correspond to releases; unreleased
changes accumulate at the top. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **Live Working / Needs-you on the Hermes listener.** `session.active_list`
  answers `{sessions:[{session_key,status}]}`: a running turn is `streaming`
  (Working), an open approval/clarify is `waiting` (Input / Needs you), and
  idle sessions are omitted. `sessions.changed` is broadcast on turn and
  request boundaries so the list refreshes without a poll; it carries no
  session id and is not replayed, because a reattaching screen re-reads the
  list. A promoted draft is listed under both its draft id and its stored DSH
  session id so the row and the open chat resolve the same state.
- **Memory saves on the Hermes listener.** `POST /api/files/upload` now writes
  the managed `.../memories/MEMORY.md` path through to
  `$DSH_HOME/AGENTS.md`: base64 `text/plain`, empty content clears, 2 MiB cap,
  valid UTF-8, and an atomic 0600 temp + rename. USER.md and every other path
  keep their 404; the requested path is never opened, so no arbitrary write is
  exposed. The screen's read-back resolves the new text.
- **Host dictation on the Hermes listener.** `POST /api/audio/transcribe`
  now uses DSH's real `speech/transcribe` instead of 404ing. Hermex records
  `audio/m4a`, so compressed audio is converted to canonical 16 kHz mono PCM16
  WAV with `/usr/bin/afconvert` on macOS or `ffmpeg` when installed, then sent
  to the Remote; WAV passes through. A host with no converter answers 400 with
  a detail (never a fabricated transcript); provider refusals are 400, an
  unknown profile 404, an unexpected failure 500. Bounds are 25 MiB recording
  / 36 MiB body; the stock speech Remote's 4 MiB/120 s default still applies.
- **Git polish.** Push now derives its target from
  `branch.<name>.remote`/`merge`, so a remote name containing `/`
  (`team/origin`) is no longer misread from `@{u}`; the explicit
  `branch:upstream` refspec still ignores `push.default=matching`. Status and
  review reads pass `--untracked-files=all`, so an untracked directory lists
  its files (still capped at 500 and hidden-filtered) and the one-file stage
  guard can stage one.
- **The in-chat Files browser on the Hermes listener (read-only).** Hermex
  offers a workspace browser for a chat whose `session.info` names a local
  terminal backend, so `session.info` (drafts, resume snapshots and live
  events) now reports `terminal_backend:"local"` along with the existing
  `cwd`. The listener serves the three read routes the phone calls:
  `GET /api/fs/list` (folder entries with `isDirectory`),
  `GET /api/fs/read-text` (text with a 512 KiB preview and a `truncated`
  flag, or `binary:true` with the size) and `GET /api/fs/download` (the bytes
  and content type; a relative MEDIA path resolves against `session_id`'s
  folder, and `attachment:` refs answer 400). They translate the facade's Legacy
  file reads, so the two transports keep one mapping. Sizes match the host: a
  preview reads only the first 512 KiB through the facade's new `max_bytes`, and
  a source over 64 MiB answers `413 File too large` before it is buffered; a
  directory answers `400 Path points to a directory` on both routes.
- **The in-chat Git menu on the Hermes listener (read-only).**
  `GET /api/fs/git-root` resolves the repository holding a chat's folder, and
  the listener serves the panel's reads: `/api/git/status` (branch,
  ahead/behind, staged/unstaged/untracked/conflicted counts and rows),
  `/api/git/review/list` (uncommitted/branch/lastTurn), `/api/git/review/diff`,
  `/api/git/file-diff`, `/api/git/review/rev-parse` and `/api/git/branches`.
  `git` runs through `execFile` (no shell) with a timeout, a bounded buffer and
  optional locks off, and with `GIT_DIR`-style variables removed; the read-only
  Git scope admits the repository root above a chat folder (the client names
  that root on every read) and nothing else. A credential file is filtered from
  the rows and its diff answers 403. `base`/`ref` are validated as revisions so a
  query cannot inject a git option, a `file` is realpath-checked inside the root,
  a symlink is refused, and a deny-root (the state dir, `$DSH_HOME`, `~/.ssh`, …)
  or `.ssh`/`.aws`/`.gnupg`/`.dsh` component is hidden and refused. The all-add
  fallback runs only for a genuinely untracked file, so an unchanged tracked file
  is never served whole; a deleted (uncommitted) row still diffs. This change
  kept the panel read-only; the Git-writes entry below supersedes that sentence.
  `ship-info` still answers no pull request. Tests use a temporary repository and
  cover the ref-injection, symlink-escape and deny-tree attacks plus a deleted file.
- **Session search on both listeners.** `GET /api/sessions/search` now backs the
  session list's search field on `:9120` and `:9121`. One facade reply carries
  the Hermes host's `results` (session row, `match_type`, `lineage_root`) and the
  webui's `sessions` rows (with `match_preview`), so both clients read the same
  search. A host content row carries no excerpt: DSH's search exposes no role,
  and Hermex keeps a snippet only when it knows who wrote it. Matching runs id first, then DSH's literal
  message-content search (`session/search` — it never resumes an agent), then a
  title supplement; an empty query answers an empty result, the limit is capped
  at 100 (DSH returns at most 20 content hits, filled by the id/title lanes), and
  a source filter DSH cannot satisfy (`sources=cron` — DSH stores no session
  provenance) honestly matches nothing. Tests cover both shapes, all
  three lanes, the empty query, the limit, the source filters and `/stats`
  staying 404.
- **Chat telemetry on the Hermes listener (context + tokens, no cost).** A turn
  now fills the context ring. `host.sessionUsage` reads DSH's `tokenUsage` and
  `contextPressure` projections through `session/projections`; the facade
  publishes a live `usage` frame with the assistant message and the
  authoritative `usage` on its `done` event, and the gateway maps both to the
  host vocabulary: `session.usage` mid-turn and `usage` on `message.complete`,
  each `{input, output, context_used, context_max}`. The Legacy SSE
  `done.usage` is the context-window snapshot (`input_tokens`,
  `output_tokens`, `context_length`, `last_prompt_tokens`), so both transports
  fill the same ring. **No cost**: DSH reports tokens, not prices, and the app's
  Hermes chat snapshot ignores cost even when present — Usage/Insights stays
  token-only. `partial`/`persisted_turn` remain absent (the saved row ids are
  not in the turn event). The facade's `/api/session` detail and JSON export
  carry the same snapshot, so the Legacy ring survives the app's post-turn
  transcript refresh.
- **Tasks/cron on the Hermes listener (local delivery only).** The Tasks screen
  now reads and writes DSH schedules: `GET /api/cron/jobs` maps a schedule entry
  to a job (name, prompt, schedule text, next/last run, state),
  `GET /api/cron/jobs/{id}/runs` maps a delivery to a run whose `id` is the
  session it ran in, and create/edit/pause/resume/trigger/delete translate to
  `schedule/create|edit|run`. The editor's schedule text is parsed into a DSH
  timing DSH's validators accept (five-field numeric cron, `every` ≥60 s,
  `daily`/`weekdays`/`weekly` at HH:MM stored as HH:mm:ss with ISO weekdays, an
  ISO time with an offset, or DTSTART+RRULE); invalid text or a host
  `schedule/input-invalid` answers 400. Delivery
  is local only: a non-local `deliver`, model, provider or skills are refused
  with a reason instead of being silently ignored, and a trigger the service
  reports as already pending answers `409`. Run history is the schedule's
  delivery records, so a run opens as its session; there are no host output files
  or per-run cost. `sources=cron` on the agenda stays empty because DSH stores
  no session provenance. Tests cover the mapping and the full lifecycle through
  the gateway and the facade.
- **Memory (now read/write).** The Memory screen now loads on the Hermes listener: `profiles.list`
  carries the real, absolute `$DSH_HOME` path, `GET /api/config` turns on only the memory
  section, `GET /api/profiles/default/soul` is an empty soul, and
  `GET /api/files/read` serves `.../memories/MEMORY.md` as the global
  `$DSH_HOME/AGENTS.md` (a missing file answers 404, so a fresh host is an honest
  empty state). There is no USER.md (the section is off; DSH has no user-profile
  file) and no soul; saves use `POST /api/files/upload` (see the newer Memory entry above). `/api/files/read`
  serves only that allowlisted suffix — every other path is 404 — so Memory is not
  a second file browser and does not bypass the Files fence for arbitrary paths.
  Per-workspace `AGENTS.md` files are not part of this global screen. Tests cover
  the loaded document, the empty state, the 404s and both refused writes.
- **Skills (read-only).** The Skills screen now lists DSH's catalogue:
  `GET /api/skills` maps `skills/list` to the bare array the app decodes, and
  `GET /api/skills/content` returns the named skill's SKILL.md plus its catalog
  path (an unknown name is 404). DSH's catalogue is per session composition, so
  the newest chat supplies the cwd/preset; no sessions means an empty list.
  `PUT /api/skills/toggle` answers 400 with the reason: DSH has no
  skill-disable primitive. Linked files are the app's `/api/fs/*` reads from
  the SKILL.md folder and appear only when that folder is inside a chat's fenced
  roots. The Skills route is also served on the Legacy listener. Tests cover the
  list, the content, the 404 and the refused toggle.
- **Usage/Insights (tokens + cost).** The Usage screen reads
  `/api/analytics/usage` and `/api/analytics/models` from DSH's cached session
  projections: sessions, input/output/cache-read tokens, per-model rows and a
  UTC daily chart, for the requested 1-365 day window. A session's cumulative
  tokens land on its last prompt day (falling back to the row's updatedAt),
  archived and subagent sessions are included, and its last-used model names
  its row (a session with no model counts in totals/daily but adds no model
  row). When `dsh-cost-meter` is installed, `costMeter.getBillingStatistics`
  supplies total, daily and per-model cost over the retained ledger (USD; the
  plugin's display currency does not change it); without it the report stays
  token-only. `insights.get` answers `{messages:0}` because DSH exposes no
  message count; the screen marks that total approximate. A window with no
  sessions is a real empty state. Tests cover the host aggregation, the
  subagent/window attribution, the cost merge (including cost-only rows) and
  the routes/RPC.
- **Git writes on the Hermes listener.** The in-chat Git menu can now stage,
  unstage and revert one file (unstage also all), commit the staged index,
  push the current branch (upstream, or `origin` as its new upstream), and
  switch branches. The app's `:(literal)` file prefix is normalized before the
  shared path fence validates it; a symlink or credential path is still refused.
  Every write answers `409` while a turn on this listener is running, a conflict is `409`,
  an empty index is `409` for commit, and a bad ref/path or git failure is `400`.
  `commit-context` now returns the staged diff and recent subjects for the app's
  message helper, and status carries the `totals` block the client reads.
  Push needs non-interactive credentials and an origin; hooks run under a 60 s
  timeout. Tests cover a real temp repo: stage/unstage (including the literal
  prefix), revert (tracked/new), commit, push with a bare remote, branch switch,
  commit context, and the route's idle guard.
- **Package-provided skills open instead of 404ing.** DSH's `skills/list`
  omits `path` for skills a plugin or bundle contributes (`dsh-badge`,
  `dsh-interconnect`, `visualize` on this host), so selecting one asked for
  content with no file to read and the facade answered 404. The host now
  indexes the package `assets/*.md` from every profile and the global DSH
  install, so those three skills show their real body; a pathless skill with
  no asset falls back to its catalogue description instead of an error.
  Unknown names still 404. Tests cover the asset lookup and the description
  fallback.
- **Long tool-heavy turns no longer look like an empty chat.** Hermex's first
  history read takes one newest page and, with no rows held, treats that page as
  the start. A page of assistant rows carrying only reasoning/tool calls has no
  text anchor, so its projection rendered nothing and the chat cleared after the
  cached transcript (a 774-message session with 482 tool calls was hitting this).
  The gateway's `GET /api/sessions/{id}/messages` now widens the **newest** page
  backwards to the closest row with text when the requested window is
  tool/reasoning-only; the widened page is at least `limit` rows and may be as
  wide as the history window when the anchor is farther back, so older-history
  pagination still starts after the returned rows. Older pages are unchanged.
  Tests cover the widened window and the untouched offset page.
- **Chat attachments (images and documents).** The Hermes listener now stages
  what the phone attaches. `POST /api/chat/image-upload` validates a base64
  PNG/JPEG/WebP/GIF (≤20 MiB) under its own 32 MiB route cap, derives the leaf
  extension from the declared MIME (a JPEG named `photo.png` is stored `.jpg`),
  writes it under the facade uploads root (default `~/.hermes-uploads`) and
  returns the absolute path the app appends in its vision-reference block.
  `prompt.submit` realpath-checks that path inside the uploads root, keeps the
  app's two-line reference in the user text (Hermex rebuilds the attachment chip
  after a reload), and sends the staged file's bytes as a native
  `session/prompt` image part; only the path travels to `/api/chat/start`, so a
  multi-megabyte image no longer hits the 2 MiB start body. A queued prompt
  keeps its images. `file.attach` stages one document (≤25 MiB; the socket
  frame cap was raised to 48 MiB) and answers `{attached, path, ref_text}`, with
  the path quoted when it contains whitespace. Both previews read the same path
  through `/api/fs/download`, whose fence admits the uploads root. Filenames are
  sanitized and generated; the state dir and `$DSH_HOME` stay fenced off.
  Documents remain path-based (DSH's native file part needs a
  `fileUploads/upload` receipt the adapter does not broker), and the uploads
  root is append-only. Tests cover both upload routes, the MIME/extension fix,
  3 MiB of image bytes, a 6 MiB document, the native image part, the preserved
  history row, multiple/no-image prompts, the symlink refusal, the facade's
  internal-only path gate and the preview read.
- **A shared path fence for file surfaces** (`src/hermes/fence.mjs`). Hermex
  sends absolute host paths and its own check is explicitly not a security
  boundary, so a path is served only when its realpath is inside a chat folder
  (a DSH workspace, a known session folder, or the folder a draft picked).
  The facade state directory, `$DSH_HOME`, `~/.ssh`, `~/.aws` and
  `~/.gnupg` are never served, even from inside an allowed root; a symlink is
  resolved first, so it cannot point out. It also mirrors the host's own Files
  guard: `.env`/`.env.*`/`.envrc`, `.git-credentials`, `auth.json`,
  `credentials`, `config.yaml` and the other credential basenames are refused
  wherever they sit, any `mcp-tokens`/`pairing`/`.ssh`/`.aws`/`.gnupg`/`.dsh`
  component is refused, and the same names plus the host's build/VCS caches are
  hidden from listings. A denied
  path answers `403 {"detail":"Path is outside the session workspace"}`; a
  credential answers `403 {"detail":"Access to sensitive files is not allowed"}`.
  The host's secret-cache basenames (`bws_cache.json`, `bws_cache.enc.json`,
  `op_cache.json`, `photon-sidecar.json`) are included in that guard. Git
  reuses this fence; Memory will too. The Legacy `:9120` file routes are
  unchanged.

### Fixed

- **The Hermes listener's session write fence.** Hermex reads
  `GET /api/sessions/{id}/mutation-snapshot` before every rename, pin or
  archive and rethrows anything but a 200 (or the host's "old server" 404
  wording) — so on `:9121` every list action failed even though the PATCH route
  existed. The listener now answers the snapshot with
  `{session_id, exists, runtime_revision}` (`exists:false` for an unknown id),
  seeds the revision from the session's activity timestamp, advances it on every
  write and turn, validates `request_id` + `expected_revision` on a PATCH
  (`409 revision_conflict` / `409 mutation_identity_required`), and applies a
  write with no identity bare for an older client. `unread` is refused with a
  detail instead of a 200 that changed nothing.
- **Hermes-listener wire defects from the compatibility audit.** The turn now
  reports the canonical `message.complete.status:"complete"`; `session.interrupt`
  answers `interrupted`/`not_interrupted`; `session.title` has its read form
  (omit the title); `session.list` returns the same row shape as REST;
  `session.info` falls back to the catalog's default model/provider when the
  session has no selection, so the composer's chip is never blank; a `PATCH`
  applies every field it names,
  not just the first; `/api/sessions/search` and `/stats` answer a plain 404
  instead of the row regex's "Session not found"; `sources` is matched as a CSV
  of names (`cron` no longer empties the list by substring) and `limit=0` is
  honoured; reverse requests go only to sockets that advertised
  `client.capabilities {server_requests:true}`, and a raw JSON-RPC answer now
  withdraws its card; the login rate limit keys on the forwarded client (trusted
  only from loopback) so one phone behind `tailscale serve` cannot lock out the
  rest; an empty prompt is refused before a draft is promoted and a double submit
  queues instead of racing; Fast and yolo are refused with a key-level error
  rather than echoed as applied. The listener's 32 gateway tests (175 in the
  whole suite) cover these.

### Changed

- **The compatibility matrix now covers both transports.** `docs/05` is
  restructured into the Legacy webui surface (`:9120`) and a first-class Hermes
  host surface (`:9121`), with the app's behaviour, bridgeability and the known
  defects for each. `docs/07-v2-roadmap.md` is new: parity with the Legacy
  server first, then the V2-only screens, ranked by value per effort with
  acceptance criteria.
- `docs/06` records the write fence, the clarify request shape the client
  decodes, and the remaining chat-wire gaps (usage, `terminal_backend`).

## [0.3.0] - 2026-11-07

### Added

- **Hermes-protocol listener (port 9121).** Hermex 2.0 talks to a Hermes host
  (REST + JSON-RPC over a WebSocket) by default and files webui servers as
  Legacy. The plugin can now serve both contracts side by side, so the same app
  can be pointed at either kind: :9120 keeps the webui surface unchanged, and
  :9121 answers the Hermes host contract. The new listener is a translation
  layer, not a second integration: it calls the webui facade over loopback with
  an internal token, so sessions, transcripts, streaming, approvals,
  clarifications and export keep exactly one implementation. Config:
  `gatewayEnabled` (default true), `gatewayPort` (9121), `gatewayBindHost`,
  `gatewayLanHost` (`auto` also binds the Wi-Fi LAN and Tailscale IPv4 over
  plain HTTP, like `lanHost` does for the webui listener).
  Full contract, method table, event vocabulary and gaps:
  [docs/06-hermes-gateway.md](docs/06-hermes-gateway.md).
- **A dependency-free RFC 6455 server** (`src/hermes/ws.mjs`). The Hermex client
  presents its ticket in `Sec-WebSocket-Protocol`
  (`hermes-gateway-v1, hermes-gateway-ticket.<ticket>`) and expects the protocol
  name echoed, so a generic WebSocket library is not enough. The module handles
  the opening handshake, masked client frames, fragmentation, ping/pong and the
  close handshake, and is tested against Node's own `WebSocket`.
- **Hermes boot and auth**: `GET /api/status` (version 0.22.5, stable
  `install_id`, `auth_required:true`, `auth_providers:["basic"]`),
  `POST /auth/password-login` against the same scrypt record as the webui
  listener, `hermes_session_at`/`_rt`/`_provider` cookies,
  `GET /api/auth/me`, `POST /api/auth/ws-ticket` (30 s, single use), and the
  `gateway.ready` frame with `replay_epoch` and `session_authority:false`.
- **The chat path on the socket**: `prompt.submit`, `session.create`,
  `session.resume`, `session.list`, `session.title`, `session.branch`,
  `session.interrupt`, `session.steer`, `session.events.since`,
  `model.options`, `commands.catalog`, `config.set` and `client.capabilities`.
  Unimplemented methods answer `-32601`, which the client records and uses to
  hide the control, exactly as it does on an older host.
- **Hermes events with per-session sequence numbers**: message.start / delta /
  interim / complete, reasoning.delta, tool.start / complete, session.title,
  session.info, request.cancel; a per-session ring answers
  `session.events.since` with contiguous `seq`, so a reconnect does not force a
  transcript rebuild.
- **Approvals and clarifications as server-to-client JSON-RPC requests**, the
  2.0 contract's own human-in-the-loop shape (no polling, no side streams). The
  answer is accepted either as `approval.respond` / `request.answer` /
  `clarify.lock` or as a result frame; a turn that ends withdraws whatever is
  still open.
- **The REST session surface** the Hermes chat screen reads:
  `GET /api/sessions` (order/archived/limit/offset), `GET /api/sessions/{id}`,
  `GET /api/sessions/{id}/messages` (500-row pages, latest-first),
  `PATCH /api/sessions/{id}` (title/pinned/archived),
  `GET /api/sessions/{id}/export`, plus `/api/profiles/active`, `/api/config`,
  `/api/models` and `/api/commands`.
- **An internal loopback credential.** The gateway cannot hold the user's
  plaintext password (only its scrypt hash is stored), so the two listeners share
  a 0600 token at `~/.dsh/hermes-facade/internal.token` that the facade accepts
  only from loopback. The auth boundary is unchanged for the phone.
- **Tests and a probe build.** `test/hermes-ws.test.mjs` covers the socket codec;
  `test/hermes-gateway.test.mjs` drives boot, login, ticket, `gateway.ready`,
  capabilities, session list, REST paging, a streamed turn and an approval
  answered as a reverse request. `scripts/standalone.mjs --gateway-port N` boots
  both listeners against the mock agent for hand probes.

### Changed

- The webui listener now also accepts the loopback internal token, in addition to
  its cookie. Nothing else about :9120 changed.
- `/api/profile/switch` and `/api/profile/create` still refuse (Profiles are not
  a DSH concept), which also blocks Move to Hermes from reading this server as a
  source; tracked in docs/06 §9 as the next gap.

### Fixed

- **Reverse requests survive a reconnect and a stop.** The withdrawal frame is
  the host's `{id, method, reason}` (it was `{request_id}`, which the client
  ignores, so a timed-out or withdrawn card stayed up); `session.resume` and
  `session.events.since` now carry `open_requests`, so a phone that reattaches
  gets its pending approval or clarification back instead of an empty list that
  clears the card; a request raised while no socket was connected is registered
  and replayed rather than dropped; and `session.interrupt` withdraws the
  session's open requests (reason `interrupted`) and settles the turn, instead of
  leaving the pump parked until the request's TTL.
- **The Hermes listener never inherits a widened `bindHost`.** `gatewayBindHost`
  defaults to loopback; widening is explicit via `gatewayBindHost` or
  `gatewayLanHost` (which inherits `lanHost`, so `lanHost: auto` covers both
  listeners over plain HTTP).
- **The websocket ticket is accepted only from the subprotocol offer**; the
  query-parameter fallback is gone, so a credential never lands in proxy logs
  and the docs' claim about the handshake holds.

### Known gaps

- No session import, files, git, tasks, skills, memory, kanban, usage, bots or
  bot screen on the Hermes listener; those are separate backends (and DSH has no
  memory or kanban store). Move to Hermes cannot use this host as a destination
  until DSH can accept a transcript.

## [0.2.0] - 2026-11-07

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

