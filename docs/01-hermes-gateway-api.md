# 01 — The Hermes host contract the facade must speak

**Scope.** What a *stock* Hermex 2.0 (iOS, MIT) sends to a Hermes host, and what it accepts back, so an HTTP facade in front of DSH can impersonate one.

**Sources.** Upstream source read at `NousResearch/hermes-agent` HEAD (2026-11-06, shallow clone) — cited as `path:line`. Client read at `uzairansaruzi/hermex` HEAD (shallow clone) — cited as `HermesMobile/...:line`. Docs: [web-dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard), [api-server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

---

## 0. There are two contracts, and the brief named the wrong one

Hermex talks to **two different server kinds** (`docs/agents/hermes-server.md:31`; `AGENTS.md:49`):

| Kind | What it is | Transport | Detection |
|---|---|---|---|
| **Hermes** (default, #712) | the `hermes-agent` dashboard = FastAPI + JSON-RPC gateway | HTTPS REST **+ WebSocket `/api/ws`** | `GET /api/status` returns JSON carrying `auth_required` (`docs/agents/hermes-server.md:57-59`) |
| **webui** (legacy) | separate `hermes-webui` project | HTTPS REST + **SSE** | probe `/health`; `AGENTS.md:84` |

The endpoint list in the task (`/api/auth/status`, `/api/auth/login`, `/api/chat/start`, `/api/chat/stream`, `/api/session/new`, `/api/approval/pending`, `/api/clarify/pending`, `/api/models`, `/api/commands`, `/api/default-model`, `/api/providers`, `/api/file`, `/api/file/raw`) is the **webui** contract: every one of those literals is in `HermesMobile/Networking/Endpoints.swift:150-260`, and **none** of them exists in `hermes-agent` (full-repo grep, 0 hits). Consequence: this document specifies the **Hermes** contract in full (that is what "a Hermes Agent host" means), and marks webui rows as *client-only, UNVERIFIED server-side*.

**Facade implication.** Serve `/api/status` **with** `auth_required` ⇒ Hermex selects the Hermes kind and everything in §2–§8 applies (WebSocket JSON-RPC, 261 methods). Serve `/health` only ⇒ webui kind (HTTP+SSE, ~30 routes), but it is the frozen legacy surface. The WS contract is the real work; §9 lists the minimum method subset.

---

## 1. Versioning and the minimumVersion gate

- **"Gateway contract"** = the OpenRPC document `apps/shared/src/gateway-contract.openrpc.json` (1.25 MB, **261 methods** at HEAD; `x-server-requests` has 12 entries; `x-notifications` lists the events). Hermex pins it: "At the pin (0.22.5, `bf0203a7`) the gateway contract has 258 methods" (`docs/agents/hermes-feature-index.md:49`).
- **Version is exposed only in `GET /api/status` → `version`** (semver string, e.g. `"0.22.5"`; `hermes_cli/web_routers/status.py:589`; fixture `HermesMobileTests/Fixtures/HermesAgent/status.json`).
- Hermex constants: `static let minimumVersion = "0.21.3"`, `static let testedVersion = "0.22.5"` (`HermesMobile/Networking/Hermes/HermesCompatibility.swift:8,11`). Compared as a release tuple **before any password is sent** (`HermesCompatibility.swift:17`; `HermesConnection.swift:12`). Too old ⇒ the host is refused with "…runs X. Hermex needs Hermes 0.21.3 or later" (`HermesMobile/Networking/Bots/BotProtocol.swift:102`). Anything newer is allowed (`HermesCompatibility.swift:4`).
- Also present: `install_id` (stable per Hermes root, trust-on-first-use host identity — `docs/agents/hermes-server.md:57`) and an integer `desktop_contract` (`8` in the captured fixture).

**The facade must return a semver ≥ 0.21.3.** Reporting `"0.22.5"` is the tested-compatible choice.

---

## 2. Auth

Gated mode engages whenever the bind is not loopback (`hermes_cli/web_server.py:991-998`; docs § Authentication). Public allowlist, no cookie: `/api/health`, `/api/status`, `/api/config/defaults`, `/api/config/schema`, `/api/model/info`, `/api/dashboard/themes`, `/api/dashboard/plugins`, `/api/cron/fire` (`hermes_cli/dashboard_auth/public_paths.py:15-37`).

| Route | Request | Response |
|---|---|---|
| `GET /api/auth/providers` | — | `{...}` registered provider names (`dashboard_auth/routes.py:212`) |
| `GET /auth/login` | — | 302 into the chosen provider |
| **`POST /auth/password-login`** | JSON `{"provider":"basic","username":"u","password":"p","next":""}` (`routes.py:455-460`) | 200 `{"ok":true,"next":"/"}`; **no token in the body** |
| `POST /auth/logout` | cookie only | **302 → `/login`** and all session cookies cleared (`routes.py:513-531`) |
| `GET /api/auth/me` | cookie | `{"user_id","email","display_name","org_id","provider","expires_at"}` (`routes.py:541-570`) |
| `POST /api/auth/ws-ticket` | `{}` | `{"ticket":"…","ttl_seconds":30}` — single use, one per WS (`routes.py:573-590`) |

Login failures: **404** unknown provider, **401** bad credentials, **429** rate-limited, **503** provider unreachable (`routes.py:464-505`). Any gated path without a valid session: **401 `{"detail":"Unauthorized"}`** (`hermes_cli/web_server.py:475`).

**Cookies** (`hermes_cli/dashboard_auth/cookies.py:34-47,74-118`):

| Name | Value | Max-Age |
|---|---|---|
| `hermes_session_at` | access token | seconds to `exp`, floored at 60 (`request_utils.py:106`) |
| `hermes_session_rt` | refresh token | `_RT_MAX_AGE = 30*24*60*60` |
| `hermes_session_provider` | provider id | 30 days |
| `hermes_session_pkce` | PKCE payload | 600 s |

Flags: `HttpOnly; SameSite=Lax; Path=<prefix>`; `Secure` on HTTPS; `SameSite=None` only for the cross-site variant (`cookies.py:74-86`). Logout zeroes all three (`cookies.py:140-142`).

**WS auth:** Hermex mints `/api/auth/ws-ticket`, then connects to `ws(s)://host/api/ws?ticket=<ticket>` (or `?token=`) (`HermesMobile/Networking/Hermes/HermesREST.swift:434,808`). Reconnect re-mints; the ticket is not reusable.

> webui rows (client-only, **UNVERIFIED**): `/api/auth/status`, `/api/auth/login`, `/api/auth/logout` exist as paths (`Endpoints.swift:150-160`), but the brief's claim that `/api/auth/status` returns the host version is **not confirmed** — Hermex reads version from `/api/status`, and only for Hermes hosts.

---

## 3. Boot: `GET /api/status`

Public, cookie-free, thread-pool read (`status.py:397-420,589-640`). Fixture-verified body (`Fixtures/HermesAgent/status.json`):

```json
{"version":"0.22.5","release_date":"…","config_version":51,"latest_config_version":51,
 "can_update_hermes":true,"gateway_running":true,"gateway_state":"…","gateway_platforms":{},
 "gateway_exit_reason":null,"gateway_updated_at":"…","gateway_heartbeat_stale_s":null,
 "gateway_shared_with":["…"],"active_agents":0,"gateway_busy":false,"gateway_drainable":true,
 "restart_drain_timeout":60,"active_sessions":0,
 "auth_required":true,"auth_providers":["basic"],"auth_flows":["cookie","native_pkce"],
 "nous_session_valid":true,"install_id":"…","shared_profile_warning":false,
 "components":{"dashboard":{…},"gateway":{…},"platforms":{…},"storage":{…}},"overall":"ok",
 "memory":{"pressure":"ok","gateway_rss_mb":null,"system_total_mb":null,"system_available_mb":null,
           "swap_used_mb":null,"sampled_at":null,"boot_id":"…","last_boot_unclean":false,
           "last_boot_suspected_oom":false},
 "disk":{"pressure":"…","free_mb":30519,"total_mb":471482,"used_percent":93.5},
 "profiles":["…"],"parked_profiles":[],"multiplex_standalone_reason":"…"}
```

`auth_required`, `auth_providers` and `auth_flows` come from `_auth_gate_status()` (`status.py:397-420`): `"cookie"` always in gated mode, `"native_pkce"` when an interactive provider exists. **`auth_required` is the single field that makes Hermex treat the host as a Hermes dashboard.** `/api/health` is the minimal liveness probe.
---

## 4. Sessions

### 4.1 REST — durable transcript and paging

`GET /api/sessions` (`web_routers/sessions.py:182-260`): `limit` (default 20, 0..100), `offset`, `min_messages`, `archived=exclude|only|include` (default `exclude`; anything else ⇒ 400), `order=created|recent` (else 400), `source`, `sources` (CSV), `exclude_sources`, `cwd_prefix`, `full` (omit strips `system_prompt`/`model_config`), `profile`.

```json
{"sessions":[{"id":"20261103_194156_fe3075","resolved_id":null,"title":"…","preview":"…",
  "started_at":1793752917.15,"message_count":12,"live_message_count":null,"source":"gui",
  "_lineage_root_id":null,"is_active":false,"profile":"default","is_default_profile":true,
  "archived":false,"pinned":false}],
 "total":1,"limit":20,"offset":0,"storage":{}}
```

`is_active`, `profile`, `is_default_profile` are stamped per row; `archived`/`pinned` are real booleans, not 0/1 (`sessions.py:236-247`). `storage` is `{}` or `{"<profile>":"corrupt"}`. Busy store ⇒ **503** `{"detail":"Session store is busy (disk I/O or lock). Retry; the list was not cleared."}`; a damaged store is an error status, never an empty 200.

`GET /api/sessions/{id}` returns metadata (`sessions.py:560`). `GET /api/sessions/{id}/messages` (`sessions.py:746-800`) takes `limit` (≤500; **omitted = latest 500**), `offset`, `order=oldest|latest` (default: latest when `limit` is omitted, else oldest), `include_compacted`, `inline_images` (default true):

```json
{"session_id":"20261103_194156_fe3075","profile":"default",
 "messages":[{"role":"user","text":"hi","timestamp":1793752917.2,"row_id":41}],
 "pagination":{"limit":500,"offset":0,"order":"latest","returned":1}}
```

Unknown session ⇒ **404 `{"detail":"Session not found"}`**. Mutations: `PATCH /api/sessions/{id}` (rename/archive), `DELETE`, `POST /api/sessions/{id}/export`, `GET /api/sessions/stats`, `POST /api/sessions/prune`, `POST /api/sessions/bulk-delete`, `GET /api/sessions/search` (`sessions.py:466-600,853-990`). **No `message_limit`/`message_before` params exist** — those are webui's (`Endpoints.swift`, `case session(..., messageLimit:, messageBefore:)`).

### 4.2 Gateway RPC — the live session surface the app actually drives

| Method | Params | Result |
|---|---|---|
| `session.create` | `{profile?, cols?, source?, cwd?, cwd_explicit?, messages?, parent_session_id?, title?, model?, provider?, reasoning_effort?, fast?, service_tier?, close_on_disconnect, hidden, room_plumbing, follow_profile_config, idempotency_key?}` | `{session_id, stored_session_id, message_count, messages:[TranscriptMessage], info:SessionLiveInfo}` |
| `session.resume` | `{session_id, profile?, cols?, source?, lazy, defer_history, omit_messages, eager_build, close_on_disconnect, inline_images}` | `{session_id, message_count, messages, info, stored_session_id?, resumed?, session_key?, messages_omitted?, hydrating?, running?, turn_started_at?, started_at?, status?, inflight?, queued?, pending_approval?, open_requests?, pending_connection?, todo_state?, auto_continue?}` |
| `session.list` | `{profile?, title?, limit?, include_hidden}` | `{sessions:[{id, resolved_id?, title, preview, started_at, message_count, live_message_count, source, _lineage_root_id?}]}` |
| `session.history` | `{session_id, profile?}` | `{count, messages:[TranscriptMessage]}` |
| `session.status` | `{session_id, profile?}` | `{output:"…"}` (rendered `/status` text) |
| `session.title` | `{session_id, profile?, title?}` | `{title, session_key?, pending?}` |
| `session.archive` | `{session_id?, session_key?, archived, profile?}` | `{archived, session_key}` |
| `session.delete` | `{session_id, profile?}` | `{deleted:"<id>"}` |
| `session.branch` | `{session_id, profile?, name?, count?, idempotency_key?}` | `{session_id, stored_session_id, title, parent, message_count, messages, info}` |
| `session.interrupt` | `{session_id, profile?, expected_hosted_task_id?}` | `{status, interrupted?, turn_isolation?}` |
| `session.steer` | `{session_id, profile?, text}` | `{status, text}` |

All from `apps/shared/src/gateway-contract.openrpc.json` (`methods` + `components.schemas`). `TranscriptMessage` = `{role, text?, content?, tool_call_id?, timestamp?, row_id?, display_kind?, display_metadata?, name?, context?, args?, labels?, reasoning?}`.

---

## 5. Chat — the transport is WebSocket JSON-RPC, not SSE

```
ws(s)://host/api/ws?ticket=<30s ticket>
-> {"jsonrpc":"2.0","id":1,"method":"prompt.submit","params":{...}}
<- {"jsonrpc":"2.0","method":"event","params":{"type":"...","seq":4,"session_id":"...","payload":{...}}}
```

The first event after connect is `gateway.ready` (`HermesMobile/Networking/Hermes/HermesGateway.swift:342`); every `method:"event"` frame is fanned out to screens in `seq` order (`HermesGateway.swift:429`).

`prompt.submit` (`PromptSubmitParams` → `PromptSubmitResult`): `{session_id, profile?, text, display_kind?, interrupted?, queued?, surface?, voice_context?, voice_turn?, title_preview?, truncate_before_user_ordinal?, truncate_before_row_id?, truncate_before_message_id?, confirm_truncate?, confirm_empty_truncate?, confirm_deep_truncate?, rebind_survivor_row_ids?}` → `{status, voice_stopped?, user_row_id?, survivor_user_row_ids?, survivor_row_id_map?, turn_isolation?, admission_id?, forwarded?}`. A busy session queues, steers or redirects rather than refusing.

Event types (literals in `tui_gateway/*.py` ∪ `x-notifications`): `session.info`, `session.title`, `session.usage`, `session.compress`, `message.start`, `message.user`, `message.delta`, `message.interim`, `message.complete`, `thinking.delta`, `reasoning.delta`, `tool.start`/`tool.started`, `tool.progress`, `tool.complete`/`tool.completed`, `turn.start`, `turn.end`, `turn.error`, `subagent.start|text|thinking|tool|complete`, `approval.cancelled`, `usage.bars`, `gateway.ready`.

Cancel/steer are `session.interrupt` and `session.steer` (§4.2). There are **no** `/api/chat/{start,stream,cancel,steer,stream/status}` routes on a Hermes host.

The only SSE surface in the product is the separate OpenAI-compatible API server (`gateway/platforms/api_server.py`, port 8642, requires `API_SERVER_KEY` ≥16 chars): `POST /v1/runs` → run id, then `GET /v1/runs/{run_id}/events`. Its framing is exact and reusable (`api_server.py:195-201`; `api_server_runs.py:1251-1330`): each frame is `id: <seq>`, `event: <name>`, `data: <json>`, blank line; comment frames `: open`, `: keepalive`, `: stream closed`; headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Payload envelope is `{"event", "run_id", "timestamp", …fields, "seq"}` (`_run_event`, `api_server_runs.py:224-226`). Names: `run.queued`, `message.delta`, `message.interim`, `reasoning.available`, `tool.started`, `tool.completed`, `approval.request`, `approval.responded`, `run.steered`, `run.stopping`, `run.interrupted`, `replay.truncated`. Resume with `Last-Event-ID` or `?last_seq=`.

---

## 6. Human-in-the-loop: server→client JSON-RPC requests, not REST

`x-server-requests` defines `approval` and `clarify` — the server sends a JSON-RPC **request** down the same WS and blocks on the client's result:

```json
<- {"jsonrpc":"2.0","id":"req-9","method":"approval","params":{
     "session_id":"…","request_id":"…","command":"rm -rf build","description":"…",
     "choices":["allow","allow_session","allow_always","deny"],"allow_permanent":true,
     "allow_session":true,"smart_denied":false,"tool_name":"terminal","gateway_session_id":null}}
-> {"jsonrpc":"2.0","id":"req-9","result":{"choice":"allow","all":false}}
```

`ApprovalRequestParams` = `{session_id, request_id, command?, description?, choices?, allow_permanent?, allow_session?, smart_denied?, tool_name?, gateway_session_id?}`; `ApprovalResult` = `{choice, all?}`. Reconnect path: `approval.pending` `{session_id, profile?}` → `{approvals:[PendingApproval]}`, with `PendingApproval` = `{request_id?, command?, description?, pattern_key?, pattern_keys?, allow_permanent?, allow_session?, smart_denied?, choices:[string], tool_name?}`; `approval.respond` `{session_id, profile?, choice?, all?, request_id?}` → `{resolved:int}`.

Clarify: request `{session_id, questions:[ClarifyQuestion], answers?}` → `{answers?, outcome:"submitted"|"timed_out"|"cancelled"}`. Reconnect: `clarify.lock` `{request_id, question_id, answer, profile?}` → `{status, remaining?}`; `request.answer` `{id, result:{}, profile?}` replays an answer for a frame the client never received → `{status}`.

> webui's `/api/approval/{pending,respond,stream}` and `/api/clarify/{pending,respond,stream}` are client paths only (`Endpoints.swift`); payloads and SSE names **UNVERIFIED** — they need `hermes-webui/api/routes.py`.

---

## 7. Models and slash commands

| Need | Hermes RPC | Result |
|---|---|---|
| provider/model inventory | `model.options` `{profile?, session_id?, explicit_only, include_unconfigured, refresh}` | `{providers:[ModelOptionProvider], model?, provider?}` |
| slash metadata | `commands.catalog` `{session_id?, profile?}` | `{pairs?, sub?, canon?, commands?, categories?, skills?, skill_count?, warning?, plugin_discovery_error?, plugin_commands?}` |
| run one | `command.dispatch`, `command.resolve`, `complete.slash` | per contract |
| REST equivalents | `GET /api/model/info` (public), `GET /api/model/options`, `POST /api/model/set`, `GET /api/model/auxiliary` | `hermes_cli/web_routers/models.py` |

`/api/commands`, `/api/models`, `/api/default-model`, `/api/providers` are **webui** paths (`Endpoints.swift`) — server-side shapes **UNVERIFIED**.

---

## 8. Files and media

| Route | Params | Response |
|---|---|---|
| `GET /api/media` | `path` | `{"data_url":"data:image/png;base64,…"}`; 415 non-image, 403 outside media roots, 404 missing, 413 too large (`files.py:427-450`) |
| `GET /api/fs/read-data-url` | `path, session_id?, profile?` | `{"dataUrl":"data:<mime>;base64,…"}` (**camelCase**) + `ETag`, `Cache-Control: private, no-cache`; **304** on `If-None-Match`, 413 past the 16 MB cap (`files.py:1197-1235`) |
| `GET /api/files/download` | `path` (may carry `?token=`; the only query-token path — `web_server.py:316`) | file bytes |
| `GET /api/files/read` | `path` | file contents |
| `GET /api/fs/list` | `path?, profile?` | `{entries:[{name, path, isDirectory}]}` |
| `POST /api/chat/image-upload`, `POST /api/chat/file-upload` | multipart | upload record |

Note the two spellings: `/api/media` → `data_url`, `/api/fs/read-data-url` → `dataUrl`. Do not normalise.

---

## 9. Minimum viable facade surface

1. `GET /api/status` → `version:"0.22.5"`, `auth_required:true`, `auth_providers:["basic"]`, `install_id`, `components`, `overall:"ok"`.
2. `POST /auth/password-login` → `{"ok":true,"next":"/"}` plus `hermes_session_at`/`_rt`/`_provider` cookies; otherwise 401 `{"detail":"Unauthorized"}`.
3. `GET /api/auth/me`; `POST /api/auth/ws-ticket` → `{ticket, ttl_seconds:30}`.
4. `GET /api/ws?ticket=` speaking JSON-RPC: `session.create`, `session.resume`, `session.list`, `session.history`, `prompt.submit`, `session.interrupt`, `session.steer`, `approval.pending`, `approval.respond`, `commands.catalog`, `model.options`, `ping`.
5. Emit `gateway.ready`, then `session.info`, `message.start`, `message.delta`, `thinking.delta`, `tool.started`, `tool.completed`, `message.complete`, `turn.end` — each with a monotonic `seq`.
6. `GET /api/sessions`, `/api/sessions/{id}`, `/api/sessions/{id}/messages` with §4.1 paging; `/api/media`; `/api/fs/read-data-url`.

---

**Open / UNVERIFIED.** (a) webui-side bodies for `/api/chat/start` (including whether it returns a `stream_id`), `/api/chat/stream` event names, `/api/approval|clarify/*`, `/api/models|commands|default-model|providers`, `/api/file`, `/api/file/raw` — need `hermes-webui` server source; only the path strings are verified (`Endpoints.swift:150-260`). (b) Whether Hermex probes `gateway.capabilities` before first use — listed `untriaged` at `docs/agents/hermes-feature-index.md:83`. (c) `session.branch` vs `session.branch_whole` selection in the app.
