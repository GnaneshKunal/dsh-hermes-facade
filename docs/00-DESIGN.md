# dsh-hermes-facade — Design

*A DSH host plugin that impersonates a **hermes-webui** server so the stock iOS app **Hermex 2.0**
drives a local DeepSeek Harness agent.*

Status: design frozen 2026-11-06 · target DSH `0.2.2-rc.1` · Hermex `2.0.0` (App Store, MIT) ·
hermes-webui protocol (classic stack)

---

## 1. What we are building and why

Hermex is a free/MIT native SwiftUI iPhone+iPad cockpit for a self-hosted agent. It speaks **two**
wire stacks:

| Stack | Used by | Transport | We target it? |
|---|---|---|---|
| **webui** (classic hermes-webui HTTP API) | chat, session list, composer, approvals — the whole main app | REST + SSE | **YES** |
| direct Hermes host (gateway) | Bot screens, Move-to-Hermes, push only | JSON-RPC over WebSocket | no (v1) |

Decision: **impersonate a webui host.** Rationale:

1. The main app — which is exactly the "grokbot" surface the user wants — is the webui stack.
2. The webui sign-in path **never checks a version** (`AuthManager.swift:200-207`); the 0.21.3
   version gate only runs on the Hermes-host path (`HermesConnection.swift:210-217`). So there is
   no version to fake.
3. We must **not** serve `/api/status` with `auth_required:true` — that re-classifies us as a
   Hermes host and the app then demands a gateway WebSocket we do not have. Omit it.

Cost: if a future Hermex release migrates the main app to the gateway stack, this facade breaks.
Accepted and tracked in §7.

## 2. Architecture

```
 iPhone (Hermex 2.0, App Store)
   │  https://<host>.<tailnet>.ts.net:9443        (tailnet only — never Funnel)
   ▼
 tailscale serve --bg --https=9443 → 127.0.0.1:9120
   ▼
 dsh-hermes-facade   (a DSH host plugin, in-process with dsh web)
   ├── node:http listener on 127.0.0.1:9120  ← own port, NOT :3080
   │     /health, /api/*  (REST + SSE)
   ├── auth: password file → scrypt verify → HMAC-signed cookie
   └── host adapter (in-process, no HTTP):
         ctx.connection.createPeer({principal:{kind:'owner'}, interactions:'answer'})
         ctx.typertGateway.invoke({namespace:'session', method:'prompt'|'list'|…, peer})
         ctx.typertGateway.stream({namespace:'session', method:'follow', …})
         cordis waterfalls: 'approval/request', 'user-questions/request'
```

Why our own port: DSH's `/api` is its own fenced RPC namespace (dynamic `claimsEndpoint`, 401 on
everything unclaimed), and the :3080 origin is **already publicly exposed via Tailscale Funnel**.
Mounting there would publish the facade. Port 9120 bound to loopback is unreachable except through
our chosen serve rule.

## 3. Endpoint map (Hermex → facade → DSH)

| Hermex call | Facade returns | DSH source |
|---|---|---|
| `GET /health` | `{"status":"ok"}` | static |
| `GET /api/auth/status` | `{"auth_enabled":true,"logged_in":<cookie>,"password_auth_enabled":true}` | cookie |
| `POST /api/auth/login` `{password}` | `{"ok":true}` + `Set-Cookie` | password file |
| `POST /api/auth/logout` | `{"ok":true}` | clears cookie |
| `GET /api/sessions` | `{"sessions":[…],"server_time":<epoch s>}` | `session/list` `{_request:{}}` + projections |
| `GET /api/session?session_id=&messages=1&msg_limit=50` | `{"session":{…,"messages":[…]}}` | `session/follow` first `snapshot` |
| `POST /api/chat/start` | `{"stream_id","session_id","pending_started_at"}` | create stream + `session/prompt` |
| `GET /api/chat/stream?stream_id=` | SSE (see §4) | `session/follow` live frames |
| `GET /api/chat/cancel?stream_id=` | `{"ok":true}` | `session/cancel` |
| `GET /api/chat/stream/status` | `{"active","stream_id","replay_available","journal":{…}}` | stream registry |
| `GET /api/approval/pending` | `{"pending":null}` or `{"pending":{…},"pending_count":n}` | `approval/request` waterfall |
| `GET /api/approval/stream` | SSE `initial`/`approval` + keepalive | waterfall queue |
| `POST /api/approval/respond` | `{"ok":true}` | resolve waterfall |
| `/api/clarify/{pending,stream,respond}` | mirror | `user-questions/request` |
| `GET /api/models` | `{"models":[{"id","label"}],"default_model"}` | `session/modelCatalog` |
| `GET /api/commands` | `{"commands":[…]}` | command catalog |
| `GET /api/workspaces` | `{"workspaces":[{"path","name"}]}` | workspace list |
| `GET /api/profiles` | `{"profiles":[{"name"}],"active":"default","single_profile_mode":true}` | agent presets |
| `GET /api/reasoning` | `{"effective_effort","supported_efforts","supports_reasoning_effort"}` | `projections.modelSelection.{next,lastUsed}` + `session/modelCatalog` efforts |
| `POST /api/reasoning` | same body; `ok:false` + `error` when the model does not offer the level | `session/selectModel` (provider+model replayed; stale spellings translated) |
| `POST /api/default-model` | `{"ok":true,...,"persisted":false}` | acknowledgement: the default lives in dsh config |
| `GET /api/list?session_id=&path=` | `{"path","name","parent","entries":[…],"dirs":[…],"files":[…]}` | local directory listing |
| `GET /api/file?session_id=&path=` | `{"content","path","name","language","size","lines"}` | local text file (binary → 404, use `/api/file/raw`) |

Read-only host calls behind a UI route (`/api/models`, `/api/workspaces`, `/api/projects`,
`/api/reasoning`) are bounded to 8 s and fall back to a well-formed default, because a request that
never answers reads to the user as "the server is gone". The model catalog is cached for 15 s and
warmed at mount. Every request is logged to `access.log` (when `logRequests` is on) and every
unimplemented endpoint to `unknown-endpoints.log` (always) — see the README's Diagnostics section.

Wire rules that are not negotiable (from the Swift decoder):

* **snake_case** on REST; SSE payloads are decoded **without** case conversion, so SSE keys are
  snake_case too.
* Timestamps are **Unix epoch seconds as JSON numbers**, never ISO strings.
* `stream_id` must exist on `/api/chat/start` or the optimistic bubble is rolled back silently.
* `cancel` is a **GET**.
* Approval endpoints must answer `{"pending":null}` rather than 404 — a 404 leaves the run hanging
  with no card, the worst failure mode in the contract.
* `done` must be valid JSON; a malformed `done` sends the client into reconnect instead of
  completion.

## 4. SSE event map (DSH → Hermex)

Terminal ordering: content → `done` → `stream_end`. Keepalive `:` comment every 5 s (>18 s of
silence is treated as a dead transport). `id:` carries the resume sequence, replayed via
`?replay=1&after_seq=<n>`.

| Hermex `event:` | `data:` | DSH source frame |
|---|---|---|
| `token` | `{"text"}` | `assistant-stream` `chunk` (text delta) |
| `reasoning` | `{"text"}` | assistant stream reasoning delta (if present) |
| `interim_assistant` | `{"text","already_streamed"}` | assistant text that precedes tool calls |
| `tool` | `{"event_type","name","preview","args","tid"}` | `event: tool/call` (`arguments` is a raw JSON string) |
| `tool_complete` | same + `{"duration","is_error"}` | `event: tool/result` |
| `title` | `{"session_id","title"}` | `projections.title` change |
| `metering` | `{"tps","tps_available","session_id"}` | turn usage (optional) |
| `approval` | `{"pending":{…}}` | `approval/request` waterfall |
| `clarify` | `{"pending":{…}}` | `user-questions/request` waterfall |
| `done` | `{"usage":{…},"session":{…}}` | `turn/end` + final `assistant/message` |
| `error` | `{"message"}` | turn error |
| `stream_end` | — | end of follow stream |

## 5. SUPPORT MATRIX — what works, what doesn't

Hermex was built for Hermes. DSH is a different harness: many Hermes surfaces have no DSH
equivalent. This is the honest accounting.

> **Superseded.** This section is the 2026-11-06 design snapshot. The runtime probe later found
> several rows overstated (pin/archive, the model picker, approvals, clarifications) and history
> paging has since landed. The current verified matrix is
> [05-compatibility-matrix.md](05-compatibility-matrix.md).

Legend: **FULL** = behaves as the app expects · **PARTIAL** = works with a mapping, some UI dead ·
**NONE** = not implemented; app shows an empty screen / banner · **LATER** = deferred

| Hermex surface | Hermes feature | DSH capability | v1 | What the user sees without it |
|---|---|---|---|---|
| Chat + streaming | ✅ | ✅ assistant-stream | **FULL** | — |
| Thinking / reasoning block | ✅ | ✅ reasoning deltas | **FULL** | — |
| Tool cards (call + result) | ✅ | ✅ `tool/call`, `tool/result` | **FULL** | — |
| Inline approvals (once/session/always/deny) | 4 choices | DSH: allow-once / reject | **PARTIAL** | `session`/`always` collapse to allow-once |
| Clarifications / agent questions | ✅ | ✅ `user-questions/request` | **FULL** | — |
| Stop / cancel | GET | ✅ `session/cancel` | **FULL** | — |
| Session list, open, history paging | ✅ | ✅ `session/list`, `session/follow` | **FULL** | — |
| Session rename | ✅ | ✅ projections | **FULL** | — |
| Session pin / archive | ✅ | ✅ workspace pin/archive remotes | **FULL** | - |
| Session branch (fork) | ✅ | ✅ session/fork | **FULL** | needs a completed turn, else the host refusal is shown |
| Session duplicate / delete / export / compress / clear / undo / retry | ✅ | ✗ | **NONE** | 200 {ok:false, error} - a message, not a 404 banner |
| Live title update | ✅ | ✅ projection | **FULL** | — |
| Model picker | ✅ | ✅ `modelCatalog` | **FULL** | — |
| Reasoning-effort picker | ✅ | ✅ `session/selectModel` + catalog levels | **FULL** | — |
| Slash commands | ✅ | ⚠ catalog exists | **PARTIAL** | autocomplete thinner |
| Workspaces | ✅ | ✅ | **PARTIAL** | create/list yes, per-workspace settings no |
| Profiles | ✅ | agent presets | **PARTIAL** | mapped |
| File browser / attachments | ✅ | ✅ list + read + raw bytes | **PARTIAL** | read; no upload/edit, no git ops |
| Projects | ✅ | ✅ DSH workspaces (one project per workspace) | **PARTIAL** | real list, but no create/rename/delete from the phone |
| Tasks / cron (run, pause, history, output) | ✅ | scheduled tasks + goals | **NONE** v1 | empty screen |
| Skills browser | ✅ | skill catalog | **PARTIAL** | read-only |
| Memory | ✅ | ✗ | **NONE** | empty screen |
| Insights / usage dashboards | ✅ | session stats/cost only | **NONE** | empty screen |
| Kanban boards | ✅ | ✗ | **NONE** | empty screen |
| Git panel (stage/commit/push/diff, 24 endpoints) | ✅ | ✗ (worktrees only) | **NONE** | empty screen |
| Bots (Telegram/Discord/iMessage paired chats) | ✅ | ✗ | **NONE** | empty screen |
| Personalities | ✅ | ✗ | **NONE** | — |
| Push / Live Activity | relay | needs APNs relay | **LATER** | no background approvals |
| Voice transcription | ✅ | speech-input plugin | **LATER** | — |
| Move to Hermes | ✅ | ✗ | **NONE** | — |

All NONE rows are safe by construction: unsupported screens answer well-formed empty payloads
(projects, crons, insights, memory, skills, kanban) and unsupported actions answer 200 {ok:false, error},
so the app renders an empty state or a message rather than its "server endpoint was not found" banner.
The **only** endpoints that must never 404 are the approval/clarify family — a 404 there hangs the
turn silently. We always answer `{"pending":null}`.

## 6. Auth & security

* Password stored **hashed** (scrypt) in `~/.dsh/hermes-facade/password`; generated on first run,
  readable only by the user, printed once so it can be typed into the app.
* Login rate-limited (5 per 15 min per IP). Constant-time compare.
* Session cookie: `hermes_session=<payload>.<hmac>`, HttpOnly, SameSite=Lax, Secure when served
  over HTTPS (drop Secure on loopback so `curl` tests keep the cookie).
* Bound to `127.0.0.1` only. Never `0.0.0.0`.
* Exposed **tailnet-only** via `tailscale serve --https=9443`. Never Funnel.

## 7. Risks

1. **Client drift.** Hermex is actively shipped (1660★, MIT, weekly releases). A future 2.0.x could
   move the main app onto the gateway stack. Mitigation: pin the app version on the phone (disable
   auto-update), keep doc 02's line refs as the contract, and re-derive from source on upgrade.
2. **DSH drift.** Peers pinned `^0.2.2-rc.1`; `engines.dsh` fails loudly. Session format v4 is the
   real contract.
3. **Owner peer.** Facade acts as `principal:{kind:'owner'}` — remote-access rules do not apply, so
   the cookie is the entire boundary. Do not widen the bind address.
4. **Pre-existing exposure (not ours):** Tailscale Funnel currently publishes the DSH Web UI on
   :443 to the public internet. Flagged in 04-packaging-exposure.md.

## 8. Tiers

* **T1** — /health, auth, sessions, session, chat start/stream/cancel/status, approval, clarify.
  This is a complete "grokbot".
* **T2** — models, commands, workspaces, profiles, reasoning, files, live title.
* **T3** — crons, skills, insights, memory, kanban, git, bots (mostly NONE→stub later).

## 9. Evidence

* `docs/01-webui-api-contract.md` — hermes-webui server contract (cross-check)
* `docs/02-hermex-client-wire.md` — the authoritative client spec, read from Swift
* `docs/03-dsh-host-integration.md` — DSH host API surface (typert gateway, waterfalls, routes)
* `docs/04-packaging-exposure.md` — plugin packaging, port strategy, Tailscale, test plan
