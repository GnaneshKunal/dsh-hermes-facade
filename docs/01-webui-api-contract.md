# 01 — hermes-webui server-side API contract (the surface we must impersonate)

**Provenance.** Read from `nesquena/hermes-webui`, branch `master`, commit `75cc1ba` (2026-11-06), cloned to `/tmp/hermes-webui`. Citations are `file:line`; every file resolves at
`https://github.com/nesquena/hermes-webui/blob/75cc1ba/<file>#L<line>`.
Cross-checked against `docs/02-hermex-client-wire.md` (the Swift decode side). Divergences are §8 — read that first if you are implementing.

## 0. Global rules that apply to every route

| Rule | Server behaviour | Source |
|---|---|---|
| Content type | `application/json; charset=utf-8`; SSE is `text/event-stream; charset=utf-8` | `api/helpers.py:703` |
| Cache | Every JSON response carries `Cache-Control: no-store` | `api/helpers.py:713` |
| Gzip | If `Accept-Encoding: gzip` **and** body > 1024 B → gzipped + `Content-Encoding: gzip` | `api/helpers.py:709-712` |
| Error envelope | **Always** `{"error": "<message>"}`. There is no `detail` key anywhere. | `api/helpers.py:107` |
| Unmatched route | 404 `{"error":"not found"}` (GET `server.py:395`, writes `server.py:423`) | `server.py` |
| Unhandled exception | 500 `{"error":"Internal server error"}` | `server.py:401` |
| Unauthenticated `/api/*` | 401 `{"error":"Authentication required"}` | `api/auth.py:1257-1263` |
| Trusted-auth profile mismatch | 403 `{"error":"Profile access forbidden"}` | `api/auth.py:1243-1253` |
| No-auth paths | `/health`, `/api/auth/login`, `/api/auth/status` never need a cookie | `api/auth.py:52-63` |
| Path case | `/api/` paths match case-insensitively | `server.py:391` |

## 1. `GET /health`

`api/routes.py:17842` → `_handle_health` `api/routes.py:16279`. No auth, no params.

```json
200 {"status":"ok","sessions":3,"active_streams":0,"active_runs":0,"runs":[],
     "last_run_finished_at":null,"server_started_at":1762380000.0,
     "uptime_seconds":812.4,"accept_loop":{"status":"ok"}}
```

`?deep=1` adds `checks` and returns **503** with `"status":"degraded"` when a subsystem is unhealthy (`api/routes.py:16301-16313`). Never emit that: doc 02 §1 requires the literal string `"ok"` or the app throws `Unexpected health status.` (`AuthManager.swift:202-204`). Answer 200 + `status:"ok"`; the other keys are optional.

## 2. Auth

### `GET /api/auth/status` — `api/routes.py:17633`

```json
200 {"auth_enabled":true,"logged_in":false,"oidc_enabled":false,
     "password_auth_enabled":true,"passwordless_enabled":false,
     "passkeys_enabled":false,"passkeys_count":0,"passkey_feature_flag":false,
     "auth_disabled_acknowledged":false}
```

`trusted_auth_enabled`, `auth_type`, `user`, `bound_profile` appear only under trusted auth. **Never send `password_auth_enabled:false`** unless you want the client to refuse password sign-in (doc 02 §1, `AuthManager.swift:46-55`). Never 404, never 401.

### `POST /api/auth/login` — `api/routes.py:22948`

Body: `{"password": "<pw>"}`. **No username field.**

| Case | Status | Body |
|---|---|---|
| auth disabled | 200 | `{"ok":true,"message":"Auth not enabled"}` — **no Set-Cookie** |
| rate-limited (5 tries / 60 s / IP, `api/auth.py:226-227`) | 429 | `{"error":"Too many attempts. Try again in a minute."}` |
| wrong password | 401 | `{"error":"Invalid password"}` |
| success | 200 | `{"ok":true}` **+ `Set-Cookie`** |

Cookie (`_auth_cookie_header` `api/auth.py:884-894`):

```
hermes_session=<signed-token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000   (+ ; Secure when TLS)
```

Name overridable via `HERMES_WEBUI_COOKIE_NAME` (`api/auth.py:71-88`). TTL default 30 days, clamped to `[60, 31536000]` (`api/auth.py:29,32-48`). No `Domain` — host-only. The Swift client never reads a body token: **this cookie is the entire auth mechanism**, replayed by URLSession on `/api/*` *and* on the SSE streams (doc 02 §1).

### `POST /api/auth/logout` — `api/routes.py:23082`

200 `{"ok":true}` + `Set-Cookie: hermes_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` (`api/auth.py:897-905`); server session invalidated. Without a valid cookie the route 401s **before** the handler (`api/auth.py:1230-1239`) — answer 200 unconditionally if you want logout idempotent.

## 3. `GET /api/sessions` — `api/routes.py:18147`

| Param | Type | Default | Notes |
|---|---|---|---|
| `include_archived` | flag | off | `1/true/yes` |
| `archived_limit` | int 1–2000 | none | only meaningful with the above; echoed back |
| `archived_offset` | int 0–200000 | 0 | paging |
| `exclude_hidden`, `sidebar_source`, `all_profiles` | — | — | safe to ignore |

```json
200 {"sessions":[{...}], "sidebar_reference_sessions":[],
     "cli_count":0, "archived_count":2, "archived_webui_count":2, "archived_cli_count":0,
     "include_archived":false, "all_profiles":false, "active_profile":"default",
     "other_profile_count":0, "server_time":1762380812.55, "server_tz":"+0530"}
```

`server_time` is **epoch seconds as a JSON number** (`api/routes.py:3738`). The row is a whitelist, not the full sidecar (`api/route_session_list_cache.py:47-123`): `session_id`, `title`, `display_title`, `_state_db_title`, `workspace`, `model`, `model_provider`, `message_count`, `visible_message_count`, `user_message_count`, `created_at`/`updated_at`/`last_message_at`, `pinned`, `archived`, `project_id`, `profile`, `input_tokens`/`output_tokens`/`estimated_cost`, `cache_read_tokens`/`cache_write_tokens`/`cache_hit_percent`, `personality`, `context_length`, `window_usage_percent`, `source_tag`/`raw_source`/`session_source`/`source_label`, `is_cli_session`, `is_streaming`, `active_stream_id`, `has_pending_user_message`, `pending_started_at`, `worktree_path`, `parent_session_id`/`parent_title`, `relationship_type`, `sidebar_is_cli_session`, `sidebar_profile_group`. The handler then appends `attention` per row (`api/routes.py:14166`), derived from the approval/clarify queues.

Never 404: an empty install returns `{"sessions":[]}` and 200. 401 only when unauthenticated.

## 4. `GET /api/session` — `api/routes.py:18081` → `_handle_session_get` `api/routes.py:16713`

| Param | Required | Default | Meaning |
|---|---|---|---|
| `session_id` | **yes** | — | missing → 400 `{"error":"session_id is required"}` (`:16735-16738`) |
| `messages` | no | `1` | `0` = metadata only, skips transcript + model resolve |
| `msg_limit` | no | none | clamped `1..500` (`_MAX_MSG_LIMIT` `api/routes.py:11714`); `all` = full transcript escape hatch |
| `msg_before` | no | none | 0-based index cursor; pairs with `msg_limit` for scroll-back |
| `resolve_model`, `expand_renderable` | no | — | `expand_renderable` is a legacy no-op |

```json
200 {"session":{"session_id":"abc","title":"...","messages":[...],"tool_calls":[...],
     "_messages_truncated":true,"_messages_offset":120,"_msg_limit_max":500,
     "visible_message_count":170}}
```

`_messages_offset` is the **backwards-paging cursor**; the client feeds it back as `msg_before` and stops at `0` (`api/routes.py:17231-17233`). Message rows: `role`, `content`, `timestamp`, `message_id`, `name`, `tool_call_id`, `tool_calls`, `content_parts`, `reasoning`, `attachments`, `display_kind`, `display_metadata`. Hidden tool-result rows (`is_hidden_transcript_row`, `api/routes.py:17224`) exist server-side and must not consume the `msg_limit` budget.

| Failure | Status | Body |
|---|---|---|
| unknown / legacy `None`-profile session | 404 | `{"error":"Session not found"}` |
| owned by another **known** profile | **409** | `{"error":"Session belongs to a different profile","code":"session_profile_mismatch","session_id":…,"profile":…}` (`:16788-16796`) |
| unauthenticated | 401 | `{"error":"Authentication required"}` |

## 5. Chat: start → SSE stream

### `POST /api/chat/start` — `api/routes.py:21325` → `_handle_chat_start` `api/routes.py:31228`

```json
{"session_id":"abc","message":"hi","workspace":"/p","model":"x","model_provider":"y",
 "profile":"default","explicit_model_pick":true,"attachments":[{"...":""}]}
```

`session_id` and `message` (non-empty after strip) are mandatory; `attachments` capped at 20 (`api/routes.py:31390`). Success: **200** `{"stream_id":"…","session_id":"…"}` — `_start_run` documents exactly those fields (`api/routes.py:30248-30250`), corroborated by `ARCHITECTURE.md:1876`. **`stream_id` is mandatory for the facade** — without it the client rolls the bubble back (`ChatViewModel.swift:3789-3805`).

| Failure | Status | Body |
|---|---|---|
| missing session_id | 400 | `{"error":"Missing required field(s): session_id"}` |
| empty message | 400 | `{"error":"message is required"}` |
| unknown session | 404 | `{"error":"Session not found"}` |
| read-only foreign session | 403 | `{"error":"session is read-only in its foreign store; …"}` |
| compressed/rotated | 409 | `{"error":…,"code":"session_rotated","continuation_session_id":…}` |
| drain/restart in progress | 503 | `{"error":…,"code":"server_draining"}` |

### `GET /api/chat/stream?stream_id=<id>` — `api/routes.py:18488` → `_handle_sse_stream` `api/routes.py:24390`

Headers (`api/routes.py:24455-24461`): `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `Connection: close`.

**Framing** (`_sse` `api/streaming.py:12881-12891`) — LF only, one blank line terminator, JSON never pretty:

```
event: token
data: {"text":"Hel"}

```

With a journal cursor an extra line precedes it: `id: <stream_id>:<seq>` (`_sse_with_id` `api/routes.py:23790-23803`). **Keepalive** is an SSE comment `: keepalive\n\n` (`api/streaming.py:12871-12879`) every **5 s** (`_SSE_HEARTBEAT_INTERVAL_SECONDS` `api/routes.py:1824`). Resume: `after_seq` / `after_event_id` query params or the `Last-Event-ID` header; `replay=1` forces journal replay. An invalid/foreign/ahead cursor is honoured as *replay from start*, never silently skipped (`api/routes.py:24394-24405`).

**Event names — authoritative list of 24** (`docs/rfcs/session-sse-contract-v1.md:252-277`). Doc 02's table is a correct subset; the full set is:

`token` · `reasoning` · `tool` · `tool_complete` · `interim_assistant` · `approval` · `clarify` · `compressing` · `compressed` · `title` · `title_status` · `warning` · `runtime_model` · `apperror` · `cancel` · `done` · `stream_end` · `metering` · `context_status` · `goal` · `goal_continue` · `pending_steer_leftover` · `state_saved` · `todo_state`

| Event | `data:` JSON | Source |
|---|---|---|
| `token` | `{"text":"…"}` | `api/streaming.py:15311` |
| `reasoning` | `{"text":"…"}` | `:15197,15364,15493` |
| `tool` | `{"event_type":"tool.started","name","preview","args":{}}`, optional `tid` | `:15530-15535, 15653-15659` |
| `tool_complete` | same + `"duration"`, `"is_error":bool` | `:15587-15594, 15689-15696` |
| `done` | `{"session":{…SessionDetail…},"usage":{…}}` | `:18365` |
| `stream_end` | `{"session_id":"…"}` | `:18851` |

**Terminal ordering:** content → `done` → optionally `title` → `stream_end`. `done` is deliberately **not** a relay-close event; `apperror` terminates with **no** trailing `stream_end` (comment `api/run_journal.py:99-103`). Close set: `{stream_end, cancel, apperror, error}` (`api/run_journal.py:103`).

404 semantics: `{"error": "stream not found"}`, status 404 (`api/routes.py:24421`). That exact substring is how the client distinguishes "run over" from "transport broken" (doc 02 §4.3). Do **not** reuse the generic `{"error":"not found"}` here.

### `GET /api/chat/cancel?stream_id=<id>` — `api/routes.py:18436`

**GET, not POST** — registered only in the GET dispatcher. 200 `{"ok":true,"cancelled":true,"stream_id":"…"}`; missing id → 400 `{"error":"stream_id required"}`; gateway stop failure → **502** `{"ok":false,"cancelled":false,"stream_id":…,"error":"Gateway stop failed"}`.

### `GET /api/chat/stream/status?stream_id=<id>` — `api/routes.py:18421`

Always **200**, never 404: `{"active":bool,"stream_id":…,"replay_available":bool}`, plus `"journal":{…}` when a run journal exists. An unknown stream id returns `active:false, replay_available:false`.

## 6. Approval / clarify

| Route | Success (200) | Errors |
|---|---|---|
| `GET /api/approval/pending?session_id=` | `{"pending":{…}\|null,"pending_count":N}` — `session_id` **not** validated; empty sid yields `null/0` (`api/routes.py:26750-26777`) | 401 only |
| `GET /api/approval/stream?session_id=` | SSE: `event: initial` `{"pending":…,"pending_count":N}` **first**, then `event: approval` with the pending object | missing sid → 400 `{"error":"session_id is required"}` (`:26789-26790`) |
| `POST /api/approval/respond` | `{"ok":true,…}`; `choice` ∈ `once\|session\|always\|deny` | 400 `session_id is required` / `Invalid choice: X`; 409 `{"stale":true,…}` for expired |
| `GET /api/clarify/pending?session_id=` | `{"pending":{…}\|null}` — **no `pending_count`** (`api/routes.py:26868-26874`) | 401 only |
| `GET /api/clarify/stream?session_id=` | `initial` then `clarify` | as approval |
| `POST /api/clarify/respond` | `{"ok":true,"response":"…"}` | 400 `{"error":"response is required"}`; **409** `{"ok":false,"error":"Clarification prompt expired or not found. The agent may have already proceeded.","stale":true}` (`api/routes.py:34505-34512`) |

Clarify accept key is lenient: `response`, else `answer`, else `choice` (`:34475-34480`). An approval entry carries `approval_id`, `command`, `description`, `pattern_key`, `pattern_keys`, `request_id` (see `_handle_approval_inject` `:26850-26864`). **A missing approval route hangs the run silently** — never 404 these (doc 02 §5).

## 7. Catalog endpoints (all degradable)

| Route | 200 body | Source |
|---|---|---|
| `GET /api/models` | `{"active_provider","default_model","groups":[{"provider":"…","models":[{"id","label"}]}]}` — **no top-level `models` array** | `api/config.py:10667-10671`; handler `api/routes.py:17856` |
| `GET /api/reasoning` | `{"show_reasoning","reasoning_effort","supported_efforts":[…],"supports_reasoning_effort":bool,"supports_thinking_toggle":bool}`; query `model`,`provider`,`base_url`,`session_id` | `api/config.py:6959-6974`; handler `api/routes.py:18000` |
| `GET /api/workspaces` | `{"workspaces":[…],"last":"/p","terminal_remote_backend":bool}` | `api/routes.py:18252-18271` |
| `GET /api/profiles` | `{"profiles":[…],"active":"default","single_profile_mode":bool}` | `api/routes.py:18761-18780` |
| `GET /api/commands` | `{"commands":[…]}` | `api/routes.py:18366-18368` |

All five are 401-gated but otherwise always 200; none has a meaningful 404.

## 8. Divergences: doc 02 / task brief vs the real server

| # | Claim | Reality | Consequence |
|---|---|---|---|
| 1 | Brief: **`POST /api/chat/cancel`** | Only `GET` exists, `api/routes.py:18436` | A POST-only facade 404s the Stop button; GET matches the real host **and** doc 02 §4.3 (`APIClient+Chat.swift:39-41`). Implement GET; accept POST as an alias if you like. |
| 2 | Brief: `/api/session?id=&include_messages=&message_limit=&message_before=` | Real params are `session_id`, `messages`, `msg_limit`, `msg_before` | Every brief param name silently misses; the route 400s with `session_id is required`. Doc 02 §3.2 is correct. |
| 3 | Doc 02 §6: `/api/models` returns `models:[{id,label}]` and "a flat array is enough" | No `models` key is ever emitted — only `groups[].models` | A client reading flat `models` gets `nil` from a real host. **Facade should emit both.** |
| 4 | Doc 02 §6: `/api/reasoning` returns `effective_effort` | Real key is `reasoning_effort` | If the Swift model decodes `effectiveEffort` it is always `nil` — the chip shows no current effort. Emit both spellings. |
| 5 | Doc 02 §4.2: `initial` may arrive on `/api/chat/stream` "if a prompt is already pending" | `initial` is emitted only on `/api/approval/stream` and `/api/clarify/stream` (`:26779-26830`) | Harmless to also send on the chat stream, but do not rely on it: implement the approval stream. |
| 6 | Doc 02 §4.3: `/api/chat/stream/status` answers 404 `"stream not found"` when finished | It returns **200 `{"active":false,…}`** and never 404s | The client's 404 path applies to `/api/chat/stream`; for status, `active:false` is the finish signal. Support both; do not 404 status. |
| 7 | Doc 02 §5: pending bodies may be bare or wrapped | Approval is **always wrapped** with `pending_count`; clarify is wrapped **without** `pending_count` | Fine for the client, but the asymmetry is real — do not "fix" it. |
| 8 | Assumption that any 404 is tolerated | Default unknown-route body is `{"error":"not found"}`, which does **not** contain `"stream not found"` | Any 404 on the stream path must use the explicit string, or the client treats a finished run as a broken transport. |
| 9 | Doc 02 §1: "any Set-Cookie works" | Cookie is `HttpOnly; SameSite=Lax; Path=/`, `Secure` under TLS; login rate-limited 5/60 s → 429 | Omitting `Path=/` scopes the cookie to `/api/auth` and every later call 401s. 429 is unhandled by the client — avoid emitting it. |
| 10 | Brief: `/health` just needs `{"status":"ok"}` | Real host can return **503 `"degraded"`** on deep checks | The client hard-fails on any status word other than `ok`. Never mirror the degraded path. |

## 9. Degradation matrix — what to return when we do not implement something

| Capability | Return instead of 404 |
|---|---|
| `/api/models`, `/api/reasoning`, `/api/workspaces`, `/api/profiles`, `/api/commands` | 200 with a minimal valid body: `{"models":[],"groups":[]}`, `{"commands":[]}`, `{"workspaces":[],"last":null}`, `{"profiles":[{"name":"default"}],"active":"default","single_profile_mode":true}`, `{"supported_efforts":[],"supports_reasoning_effort":false,"show_reasoning":false}` |
| `/api/approval/*`, `/api/clarify/*` (no human-in-the-loop) | 200 `{"pending":null,"pending_count":0}` / `{"pending":null}`; the SSE streams answer 200 and emit only keepalives. **Never 404** — that hangs the run with no card. |
| `/api/chat/cancel` | 200 `{"ok":true,"cancelled":false,"stream_id":"…"}` |
| `/api/chat/stream/status` | 200 `{"active":false,"stream_id":"…","replay_available":false}` |
| Unknown `/api/*` | 404 `{"error":"not found"}` — the client tolerates that per-screen (doc 02 §2). |
| Any 401 we emit | Reads as "The password was rejected" globally, even mid-chat. Use 403 for logical refusals. |
