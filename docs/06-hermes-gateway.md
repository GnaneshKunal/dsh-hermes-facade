# 06 — The Hermes-protocol listener (port 9121)

Hermex 2.0 changed its default server kind from **hermes-webui** to a **Hermes
host** (the `hermes-agent` dashboard: REST + JSON-RPC over a WebSocket). webui
servers still work, but are marked *Legacy* and only get fixes.

This document describes the second listener in this plugin that speaks the
Hermes host contract, so the same iOS app can be pointed at DeepSeek Harness as
a native Hermes server. It is additive: port 9120 keeps serving the webui
contract unchanged.

Status: **v1.16** (2026-11-08). Chat (with context/token telemetry and image/
document attachments), sessions (including the write fence the session list needs
and the list's search), live session state (`session.active_list` with
`starting|streaming|waiting`, and `sessions.changed`), approvals, clarifications,
models, commands (including the host's `/goal`, listed in `commands.catalog`),
the goal snapshot and live control updates (`session.control.read` /
`session.control.update`), export, Tasks/cron, Memory (read/write, including an
`overwrite:false` conflict), Skills (read-only), Usage/Insights (tokens, and cost
from `dsh-cost-meter` where installed), dictation over `speech/transcribe`, the
read-only in-chat Files browser and the in-chat Git menu (reads plus
stage/unstage/revert, commit, push and branch switch behind an idle-turn guard).
The 2026-11-07 audit's wire defects (turn status, stop vocabulary, title read,
list rows, multi-field PATCH, collection 404s, source matching, `limit=0`,
capability-gated reverse requests, forwarded-client rate limiting, prompt races,
Fast/yolo honesty) are fixed in the same change.
Not implemented: session import, kanban, the Legacy insights screen, bots and the bot screen. Those answer `-32601` (socket) or 404
(REST), which the client degrades on. The full per-surface state, and the plan
for closing the gaps, are [05-compatibility-matrix.md](05-compatibility-matrix.md)
§2 and [07-v2-roadmap.md](07-v2-roadmap.md); this document is the listener's own
contract reference.

---

## 1. Why two listeners

The app decides what a server *is* by probing `GET /api/status` at add time; the
kind is stored per URL and never re-probed. One origin cannot be both kinds, so
a second port is the only way to expose both contracts side by side:

```
Hermex (iOS)
  ├── :9120  webui contract   (existing facade; marked Legacy in 2.0)
  └── :9121  Hermes contract  (this listener)
```

Both are this plugin. The gateway does not talk to DSH directly: it translates
to the **webui facade over loopback** with an internal token, so every DSH
mapping (sessions, transcript, streaming, approvals, clarify, export) exists in
exactly one place.

```
Hermex --WS/JSON-RPC--> gateway (:9121) --HTTP/SSE--> facade (:9120) --> dsh
```

The internal token is `~/.dsh/hermes-facade/internal.token` (0600) and is
accepted only from loopback; the user's plaintext password is never stored.

---

## 2. Configuration

```yaml
config:
  gatewayEnabled: true      # false leaves only the webui listener
  gatewayPort: 9121         # port for the Hermes contract
  gatewayBindHost: 127.0.0.1
  gatewayLanHost: auto      # also bind Wi-Fi LAN + Tailscale IPv4 (plain HTTP)
```

`gatewayBindHost` is separate from `bindHost` on purpose, but the LAN policy is
shared: `gatewayLanHost` **inherits `lanHost`** unless set, so a profile with
`lanHost: auto` widens both listeners the same way, over plain HTTP (Hermex
permits insecure HTTP on a local network and on the `100.64.0.0/10` tailnet).
Set `gatewayLanHost: 'off'` to keep the Hermes listener loopback-only anyway, or
name a single address to bind just that one.

---

## 3. Boot and auth

| Route | Notes |
|---|---|
| `GET /api/status` | public. `version: "0.22.5"` (the app's gate is >= 0.21.3), `auth_required: true`, `auth_providers: ["basic"]`, `auth_flows: ["cookie"]`, stable `install_id` |
| `GET /api/health` | public liveness |
| `POST /auth/password-login` | body `{provider, username, password}`. Verifies against the same scrypt record as 9120, answers 200 `{ok:true,next:"/"}` plus `hermes_session_at`/`_rt`/`_provider` cookies. 401 bad password, 429 after 5 attempts / 15 min per address |
| `GET /api/auth/me` | requires the cookie; `{user_id, provider, expires_at, …}` |
| `POST /api/auth/ws-ticket` | requires the cookie; `{ticket, ttl_seconds: 30}`, single use |
| `POST /auth/logout` | 302 to `/login`, clears the cookies |

`install_id` is persisted at `~/.dsh/hermes-facade/install-id`. Hermex trusts a
host on first use and refuses a changed one, so it must survive restarts.

The cookie is `HttpOnly; SameSite=Lax`, with `Secure` when the request arrived
over TLS (a tailscale serve proxy sets `X-Forwarded-Proto`).

---

## 4. The socket

```
wss://host/api/ws
Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.<ticket>
```

The ticket rides in the subprotocol offer and the server echoes
`hermes-gateway-v1`; a plain WebSocket client that ignores the header is
refused. The first frame is:

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","seq":0,
 "payload":{"replay_epoch":"<uuid>","session_authority":false,"protocol":"hermes-gateway-v1"}}}
```

`session_authority` must stay false: a value of true tells the app it is talking
to a gateway listener that owns sessions under a protocol it does not speak, and
it refuses the host. The app then sends `client.capabilities {server_requests:true}`;
accepting it is what makes approval and clarify arrive as reverse requests —
refusing it withdraws approvals silently.

### Methods

| Method | Behaviour |
|---|---|
| `gateway.ping` | `{ok:true}`; the app heartbeats with it |
| `client.capabilities` | `{ok:true, server_requests:true}` |
| `profiles.list` / `profiles.describe` | one Profile, `default` |
| `session.list` | every facade session in the REST row shape (`id`, `resolved_id`, title, flags, timestamps, model/cwd when known) |
| `session.most_recent` | no-op acknowledgement |
| `session.create` | creates a DSH session (optional `cwd`, `model`, `provider`) |
| `session.resume` | live state only (`messages_omitted`); the transcript is read over REST |
| `session.title` | rename through the facade; omitting `title` reads the current one |
| `session.branch` | fork through the facade; refused with the host's reason when the session has no completed turn |
| `session.interrupt` | stops the running turn; answers `{status: interrupted|not_interrupted, interrupted}` |
| `session.steer` | queues a mid-run message |
| `session.delete` | refused: DSH has no session-delete primitive |
| `session.active_list` | `{sessions:[{session_key, status}]}` for the live dots: an accepted prompt is `starting` until the turn goes live, a running turn is `streaming`, an open approval/clarify is `waiting`, idle sessions are omitted. A promoted draft is listed under both its draft id and its stored DSH session id |
| `command.dispatch` | executes one host command through `commands/execute`: `{name, argument, session_id}` → `{type:'exec', output}` for a normal command. `/goal` is translated to DSH's grammar (`status`/`show` → status, `done`/`stop` → clear, `pause`/`resume`/`clear` unchanged, any other text an objective; DSH-only `wait`/`gate`/`draft`/`unwait` are refused). A host command error answers `-32000` with the host's wording; there is no `{type:'send'}` kickoff because DSH's own goal driver continues the goal |
| `session.control.read` | `{control:{goal:{title,status,turns_used,max_turns}}}` or `{control:{}}`; status maps `active|paused|blocked|complete` → `active|paused|blocked|done`. No loop or heartbeat keys are emitted (no DSH primitive), so the phone hides those rows |
| `session.events.since` | `{latest_seq, epoch, truncated, events}`, contiguous per session |
| `prompt.submit` | starts a turn and returns `{status: streaming|queued}`; a second submit while one runs is queued, not refused. Each image-upload path inside the facade uploads root (realpath-checked) becomes a native image part; the app's two-line vision reference stays in the user text so Hermex rebuilds the chip after reload |
| `images` on `/api/chat/start` | only the loopback Hermes listener may name a `path` (or send any image): a cookie request carrying at least one valid image entry answers 400, so the Legacy listener remains attachment-free and no host file can be named from a browser session. An empty array, or one whose entries all fail the mediaType/data/path filter, is ignored and the text still starts |
| `file.attach` | stages one document under the facade uploads root and answers `{attached:true, path, ref_text}`; names are sanitized, the body is capped at 25 MiB, and `ref_text` quotes the path when it contains whitespace. An invalid data URL answers `-32602` |
| `approval.respond` | `{session_id, request_id, choice: once|session|always|deny}` -> `{resolved}` |
| `request.answer` / `clarify.lock` | answers a clarification |
| `model.options` | providers/models from the DSH catalog |
| `commands.catalog` | slash commands as `pairs` + `canon`; the host-only `/goal` row includes its argument hint because `command.dispatch` is the one host command the listener executes |
| `config.set` | `model` and `reasoning` are applied through the facade; `fast`, `yolo`, `personality` and `approvals.mode` answer a key-level error so the control reverts and the rest of the method stays available |
| anything else | `-32601`, which the client records and uses to hide the control |

### Events

Every event is `{"jsonrpc":"2.0","method":"event","params":{type, seq, session_id, payload}}`
with **per-session**, contiguous `seq` starting at 1. Screens admit their own
session only; sequence gaps make the client rebuild from a snapshot, so the ring
(`src/hermes/events.mjs`) keeps 5000 events per session in the quiet state. An
**active turn pins its first event** (bounded at 20,000 events), so a cursor
inside the turn replays contiguously even when the turn is far wider than the
quiet ring; after settle the ring trims back to 5000. A cursor before the turn
start, a cold open (cursor 0), or a runtime/epoch change still answers
`truncated` and the Hermex client rebuilds from the persisted transcript, which
does not yet contain the in-flight rows. A turn over 20,000 events falls back to
honest truncation. The one exception is
`sessions.changed`: it is process-wide (no `session_id`, `seq:0`) and live-only,
because a screen that missed it re-reads `session.active_list` on reattach.

| Type | Payload |
|---|---|
| `session.info` | `{session_id, running, turn_started_at}`; `running:false` settles the turn |
| `message.start` | `{role:"assistant"}` |
| `message.delta` | `{text}` |
| `message.interim` | `{text, already_streamed}` |
| `reasoning.delta` | `{text}` |
| `tool.start` | `{name, args, tool_id}` |
| `tool.complete` | `{name, tool_id, result, is_error?}` |
| `session.title` | `{session_id, title}` |
| `sessions.changed` | `{}`; broadcast on turn start/end and request open/settle, no replay |
| `session.control.update` | `{control:{goal:{title,status,turns_used,max_turns}}}` or `{control:{}}` after a successful `/goal` command; the same snapshot `session.control.read` returns, no loop/heartbeat keys |
| `session.usage` | `{usage: {input, output, context_used, context_max}}`; the live context ring, sent with the assistant message and again inside `message.complete`. No `estimated_cost`: chat telemetry has no pricing; the Usage screen reads cost from `dsh-cost-meter` instead |
| `message.complete` | `{status: complete|error|interrupted, text, usage?}`; `usage` is `{input, output, context_used, context_max}` |
| `request.cancel` | `{id, method, reason}`; withdraws an unanswered card |

Reverse requests: `approval` (`request_id, command, description, choices`) and
`clarify` in the single-question legacy shape (`request_id, question, choices,
multi_select`) — the client decodes that as well as the contract's
`questions:[{qid,…}]` batch. The client answers with `approval.respond`,
`request.answer` or `clarify.lock`; a turn that ends withdraws whatever is still
open. A socket is only sent a reverse request after it advertises
`client.capabilities {server_requests:true}`; the stock client does that
immediately after `gateway.ready`. A socket that never advertised receives no
card, but can still see it in `open_requests` and answer by RPC. A raw JSON-RPC
response to a request frame settles the request and publishes `request.cancel`
with reason `resolved`, like the `approval.respond`/`request.answer` path.

---

## 5. REST surface

| Route | Behaviour |
|---|---|
| `GET /api/sessions` | `profile, order=recent|created, archived=exclude|only|include, limit, offset`; `scheduled=1` answers empty (no cron rows are exposed) |
| `GET /api/sessions/search` | `q`, `limit<=100`, `profile`, `source`/`sources`, `exclude_sources`, `content=false`; `{results:[row with match_type]}`. Host content rows carry no excerpt: DSH's search API exposes no author, and Hermex drops a snippet without a role; the webui `sessions` rows keep `match_preview`, so the Legacy listener shows excerpts. DSH returns at most 20 content hits, so the id/title lanes fill the rest of the 1–100 clamp. An empty query is `{results:[]}`; a source DSH cannot satisfy (`cron`) honestly matches nothing |
| `GET /api/sessions/{id}` | one row, 404 when unknown |
| `GET /api/sessions/{id}/messages` | `order=latest|oldest, limit<=500, offset`; rows in the transcript shape (`role, content, timestamp, row_id, tool_calls…`). The newest page widens backwards to the closest row with text when the requested window is tool/reasoning-only, at least `limit` rows and possibly as wide as the history window, so Hermex's anchor-based projection cannot render a long tool turn as an empty chat; older pages still start after the returned rows. The facade's top-level tool results are re-materialized as `role:"tool"` rows after their assistant row (with `tool_call_id`, `tool_name`, result snippet and `is_error`), because Hermex's canonical projection builds tool cards only from those rows. While a turn is active, tool rows still only in the event ring are appended too, so a **cold open** (cursor 0, no replay) can render the current step before it settles. The live key is resolved through the same draft → stored alias `session.active_list` uses, and only events at or after the pinned turn floor qualify |
| `PATCH /api/sessions/{id}` | `title`, `pinned`, `archived` through the facade's rename/pin/archive routes. A `request_id` + `expected_revision` pair is validated: a stale pair answers `409 revision_conflict`, half a pair `409 mutation_identity_required`, neither is applied bare for an older client. `unread` is refused (DSH has no flag) |
| `DELETE /api/sessions/{id}` | 400 with the reason (no DSH primitive) |
| `GET /api/sessions/{id}/mutation-snapshot` | `{session_id, exists, runtime_revision}`, the revision the phone reads before every rename/pin/archive. Without it the client rethrows the catch-all 404 and every list action fails. Unknown sessions answer `exists:false` |
| `GET /api/sessions/{id}/export` | forwards the facade's JSON transcript download |
| `POST /api/sessions/import` | 400: DSH cannot inject a transcript, so Move to Hermes cannot land here yet |
| `GET /api/cron/jobs` | a bare array of jobs (`id`, `name`, `prompt`, `schedule`, `schedule_display`, `enabled`, `state`, `next_run_at`, `last_run_at`), one per DSH schedule |
| `POST /api/cron/jobs`, `PUT /api/cron/jobs/{id}`, `POST …/{pause,resume,trigger}`, `DELETE /api/cron/jobs/{id}` | create/edit/lifecycle against the schedule service. Local delivery only: a non-local `deliver`, or non-empty `model`/`provider`/`skills`, answers 400 with the reason; a trigger whose schedule reports a pending execution answers 409. Schedule text must satisfy DSH: five numeric cron fields, `every` ≥60 s, `daily`/`weekdays`/`weekly` at HH:MM (stored as HH:mm:ss, ISO weekdays), an ISO time with an offset, or DTSTART+RRULE; invalid text or a host `schedule/input-invalid` answers 400 |
| `GET /api/cron/jobs/{id}/runs`, `GET /api/cron/delivery-targets` | run rows from the schedule's delivery history (`id` is the target session, `started_at`/`ended_at`, `is_active`), and `{targets:[local]}` |
| `GET /api/config` | `{platform_hints:{}, profile, memory:{memory_enabled:true, user_profile_enabled:false, limits}}`; only the memory block is meaningful, and the app's platform note is advisory and not stored |
| `GET /api/profiles/{name}/soul`, `PUT …` | `{content:"",exists:false}` for `default`; a PUT answers 400 (this host has no SOUL.md) |
| `GET /api/files/read?path=…`, `POST /api/files/upload` | Memory's managed file routes. Only a path ending `/memories/MEMORY.md` is served, as `$DSH_HOME/AGENTS.md` in a `data_url` (a missing file is 404); `/memories/USER.md` and every other path are 404, so this is not a second file browser. Upload saves that same path through the same suffix check: base64 `text/plain`, empty content clears, 2 MiB cap, atomic 0600 temp + rename, `{ok:true}`. `profiles.list[].path` is the absolute `$DSH_HOME` path; only the suffix is ever opened |
| `POST /api/audio/transcribe?profile=` | JSON `{data_url, mime_type}`. WAV (`audio/wav|x-wav|wave`) is forwarded; `audio/m4a|mp4|aac` (and any other audio type) is converted to canonical 16 kHz mono PCM16 WAV with `/usr/bin/afconvert` on darwin or `ffmpeg` when present, then sent to DSH `speech/transcribe`. Answers `{ok:true, transcript, provider?}`; an empty transcript is a real silence. Malformed/too-large audio, a missing converter, conversion failure, provider refusal or an unmounted speech Remote answer 400 with a detail (no transcript); an unknown profile is 404; an unexpected failure is 500 `Transcription failed`. Bounds: 25 MiB recording / 36 MiB body |
| `GET /api/analytics/usage`, `GET /api/analytics/models` | `{totals:{total_input,total_output,total_cache_read,total_sessions, total_estimated_cost?}, daily:[{day,input_tokens,output_tokens,cache_read_tokens,sessions,estimated_cost?}], period_days}` and `{models:[{model,provider,input_tokens,output_tokens,cache_read_tokens,sessions,estimated_cost?}], period_days}`. Tokens come from cached session projections; DSH has no per-day ledger (a session's cumulative tokens land on its last prompt day, falling back to the row's `updatedAt`), and archived/subagent sessions are included (a model-less session counts in totals/daily but adds no model row). When `dsh-cost-meter` is installed, `costMeter.getBillingStatistics` supplies total/daily/model cost over its retained ledger in USD (the plugin's display currency does not change it; the query uses the host-local day the ledger writes; empty-date zero entries are dropped and cost-only rows carry zero tokens); without it the cost fields are absent. `insights.get` returns `{messages:0}` because DSH exposes no message count |
| `GET /api/profiles/active`, `GET /api/profiles` | the single Profile |
| `GET /api/skills` | a bare array of DSH's catalogue for the newest session (`name`, `description`, `enabled: true`); no sessions means `[]` |
| `GET /api/skills/content`, `PUT /api/skills/toggle` | `{name, content, path}` for a catalog skill (404 only when the name is not in the catalogue). A filesystem skill reads its SKILL.md; a package/bundle skill has no catalog `path`, so its `assets/*.md` is located in the profile/global packages, and a pathless skill with no asset falls back to its catalogue description rather than 404ing. The toggle answers 400 (DSH has no skill-disable primitive) |
| `GET /api/models`, `GET /api/commands` | the catalogs |
| `GET /api/fs/list?path=` | one chat folder: `{entries:[{name, path, isDirectory}]}`. An unreadable folder is a well-formed 200 `{entries:[],error:...}`. The host's hidden caches (`.git`, `node_modules`, `dist`, …) and credential stores (`.env`, `.git-credentials`, `mcp-tokens/`, …) are not listed |
| `GET /api/fs/read-text?path=` | `{binary, byteSize, language, path, text, truncated}`; only the first 512 KiB is read (the facade's `max_bytes`), a source over 64 MiB answers `413 File too large`, and a binary file answers `binary:true` |
| `GET /api/fs/download?path=[&session_id=]` | the file's bytes and content type. A relative `path` resolves against `session_id`'s folder and is then fenced; `attachment:` refs answer 400; a directory answers 400 `Path points to a directory`; a source over 64 MiB answers 413 |
| `GET /api/media?path=[&session_id=]` | the same fenced bytes and content type for Hermex's transcript media: a Markdown image whose destination is an absolute raster path is resolved by the app through this route. Aliases `/api/file/raw` for Quick Look. No Tailscale/DSH-web URL is involved |
| `GET /api/fs/git-root?path=` | `{root}`: the repository holding the chat's folder, or `null` outside one |
| `GET /api/git/status?path=`, `/api/git/branches?path=`, `/api/git/review/list?path=&scope=[&base=]`, `/api/git/review/diff?path=&file=&scope=[&base=][&staged=]`, `/api/git/file-diff?path=&file=`, `/api/git/review/rev-parse?path=[&ref=]`, `/api/git/review/commit-context?path=` | read-only git for that root: status (branch/ahead/behind/flags/rows and a `totals` block), changed files per scope, per-file patches, branch rows, sha, and the staged diff + recent subjects the commit-message helper reads. A credential file is filtered from the rows and its patch answers `403`. A non-repository answers the host's empty shapes |
| `POST /api/git/review/{stage,unstage,revert,commit,push}`, `POST /api/git/branch/switch` | stage/unstage/revert take `{path, file}` (the app prefixes a file with `:(literal)`; unstage also accepts no file for the whole index) and answer `{ok, git:<status>}`. Commit takes `{path, message, push?}` and answers `{ok, commit:<7-char sha>, status}`; nothing staged or a conflict is `409`. Push answers `{ok, message:null, status}` and sets `origin` as the upstream when none is configured. Branch switch takes `{path, branch}` and answers `{ok, status, branches}`. **Every write** answers `409` while a turn started on this listener is running (the guard cannot see GUI/scheduler turns); a bad ref/path/symlink/credential path is `400`/`403`; `review/ship-info` → `{pr:null}`, `gh-auth` → `{available:false}`, `worktrees` → `{worktrees:[]}` |
| `POST /api/chat/image-upload` | stages one base64 image (PNG/JPEG/WebP/GIF, ≤20 MiB) under the facade uploads root and answers `{ok:true, path, name, bytes, mime_type}`; the leaf extension follows the declared MIME, not the client filename. The route has its own 32 MiB request cap; the image itself reaches the model by path, so the 2 MiB `/api/chat/start` body is not involved. A malformed data URL answers 400 and an over-cap body 413 |
| `GET /api/files/*` | **not implemented** (404) |

The three `/api/fs/*` routes share one fence: the client's path (absolute, or
relative to `session_id`'s folder) must realpath inside a chat folder (DSH
workspaces, known session folders, and a draft's chosen folder). The facade's
uploads root (default `~/.hermes-uploads`) is added as a chat root so an
uploaded image or document can be previewed; its filenames are generated and
sanitized, and it holds only uploads. The facade
state directory, `$DSH_HOME`, `~/.ssh`, `~/.aws` and `~/.gnupg` are never
served, even if a chat folder were opened inside one; a symlink resolves first,
so it cannot point out. Credential material the host's own Files guard refuses
(`.env`, `.env.*`, `.envrc`, `.git-credentials`, `auth.json`, `credentials`,
`config.yaml`, the four secret-cache stores, and any `mcp-tokens`/`pairing`
component, or `.ssh`/`.aws`/`.gnupg`/`.dsh`) is refused wherever it sits, and the
same names plus the host's build/VCS caches are hidden from a listing. A denied path answers
`403 {"detail":"Path is outside the session workspace"}`; credential material
answers `403 {"detail":"Access to sensitive files is not allowed"}`.

The Git routes share the same instinct at a different boundary: the
client names the repository root, which normally sits *above* the chat folder, so
the Git scope admits that top-level only when it really is the git root of an
allowed folder. A `file` is realpath-checked inside that root, a symlink is
refused, `base`/`ref` must be revisions (a query cannot inject a git option), a
deny-root or `.ssh`/`.aws`/`.gnupg`/`.dsh` component is hidden and its patch
answers `403`, and the all-add fallback runs only for an untracked file.

---

## 6. What the phone shows

- **Works:** chat with tokens, thinking, live tool cards, stop, approvals
  (once/session/always/deny), the context ring (context used/max and input/output
  tokens; no cost, because DSH has no pricing), clarifications, session list,
  open, rename, pin,
  archive (the write-fence route above is what lets those three work), live
  Working/Needs-you state (including the `starting` edge), the goal menu
  (create/edit/pause/resume/clear through the host's `/goal`, and a goal
  snapshot; loop/heartbeat are absent), branch, export, model picker, slash
  commands, the session list's search, the in-chat
  Files browser (`session.info.terminal_backend:"local"` plus the fenced
  `/api/fs/*` routes), the in-chat Git menu (status, changes, diffs, branches
  and the writes above)
  and the Tasks screen (list/create/edit/pause/resume/trigger/delete and run
  history; local delivery only), Memory (the global `$DSH_HOME/AGENTS.md` as
  MEMORY.md, read and atomically saved; an `overwrite:false` save against an
  existing file is 409), Skills (the DSH catalogue and each
  skill's SKILL.md; the toggle is refused), dictation over `speech/transcribe`
  (m4a converted to canonical WAV) and Usage/Insights (tokens and sessions, plus
  cost from `dsh-cost-meter` where installed; the Messages total is approximate 0).
- **Partial:** the session rows carry no `preview`; Fast and yolo are refused, so their controls
  revert instead of showing a false state. Git writes are wired, but push needs
  a configured push remote (or `origin`) and non-interactive credentials, commit
  hooks have a 60 s timeout, and the idle guard refuses while a turn started on
  this listener runs (it cannot see GUI/scheduler turns), not only a turn in that
  repository. The goal menu has no loop/heartbeat rows (no DSH primitive) and
  DSH-only verbs are refused; `session.control` stays unavailable. Dictation needs a WAV
  converter (`afconvert` on macOS, `ffmpeg` elsewhere) and the stock speech
  Remote's 4 MiB/120 s default can refuse a recording the route's own 25 MiB
  bound allows; spoken replies still have no primitive.
- **Empty/absent:** Kanban, Bots, Bot (the full upstream-blocked catalogue is [docs/08-upstream-gaps.md](08-upstream-gaps.md))
  screen. Those screens exist on a Hermes host; here they have no backend, and
  unimplemented methods make their controls hide rather than error (the sidebar
  toggles for Tasks are local, so that screen shows its
  own error; Kanban's config 404 gives the clean "unavailable").
- **No "Move to Hermes" invite:** the app offers that only for servers it
  classified as webui. A Hermes-kind server never shows it. The webui entry on
  9120 still does; its X dismisses the invite permanently.

---

## 7. Exposure

Tailnet only, one rule per listener:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:9120   # webui (existing)
tailscale serve --bg --https=9444 http://127.0.0.1:9121   # Hermes
tailscale serve status
```

Or, with `gatewayLanHost: auto`, skip the proxy entirely and use the raw address
the phone already uses for :9120:

```
http://<lan-ip>:9121          same Wi-Fi
http://100.x.y.z:9121         tailnet, plain HTTP
```

Then in Hermex: **Add server** -> `https://<machine>.<tailnet>.ts.net:9444` (or
the plain-HTTP address above) -> the same password. It is filed as a Hermes server; the 9120 entry stays as the
Legacy webui one. Add the two as separate servers; do not point one URL at both.

Removing the rule: `tailscale serve --https=9444 off` (never `serve reset`).

---

## 8. Verifying a build

```bash
curl -s http://127.0.0.1:9121/api/status
# {"version":"0.22.5","auth_required":true,"auth_providers":["basic"],"install_id":"…"}

cd ~/self/dsh-hermes-facade && npm run check && npm test
node scripts/standalone.mjs --port 9199 --gateway-port 9198
# hermes-facade (standalone, MOCK agent) on http://127.0.0.1:9199
# hermes-gateway (standalone, MOCK agent) on http://127.0.0.1:9198
```

`test/hermes-gateway.test.mjs` drives the whole contract with a real WebSocket
client: status, login, ticket, `gateway.ready`, capabilities, session list,
REST paging, the session write fence (snapshot, stale revision, half identity,
bare write), a streamed turn and an approval answered as a reverse request.
The full surface state and the plan for the missing screens are
[05-compatibility-matrix.md](05-compatibility-matrix.md) §2 and
[07-v2-roadmap.md](07-v2-roadmap.md).

---

## 9. Known gaps and risks

1. **No session import.** Move to Hermes cannot use this host as a destination
   until DSH can accept a transcript. The webui side also refuses
   `/api/profile/switch`, so a move cannot even read its source yet.
2. **No kanban/bots.** Each is a separate backend (and DSH has no kanban store
   at all). Skills is read-only: the catalogue and SKILL.md come from DSH, the
   disable toggle is refused, and the list is the newest session's composition. Memory is read/write and global: it shows and saves `$DSH_HOME/AGENTS.md`
   as MEMORY.md, has no USER.md or soul, and does not show the
   per-workspace AGENTS.md chain. Files is read-only; Git supports the writes in
   its row above; Tasks writes go
   to DSH schedules, but delivery is local only, model/provider/skills are
   refused, and a run is a session/delivery record rather than a host output file.
3. **One Profile.** Everything is filed under `default`; DSH has agent presets,
   not Profiles.
4. **Version claim.** We report 0.22.5 to clear the gate, but only implement the
   subset above. Unimplemented methods are answered honestly with -32601.
5. **Protocol drift.** The client pins 0.22.5; the contract at HEAD already has
   more methods. Re-read `/tmp/hermex` (the client source) before chasing a new
   build; do not implement from the 261-method OpenRPC document.
6. **No persisted-turn receipt; chat telemetry has no cost.** `message.complete`
   now carries `usage` and a live `session.usage` fills the ring, but
   `partial`/`persisted_turn` are absent (DSH does not expose the saved row ids),
   and chat payloads carry no cost. Usage/Insights reads cost separately from
   `dsh-cost-meter` where it is installed, so the ring/turn stay token-only.
7. **The Legacy file browser is still unfenced.** The `:9121` Files routes use the
   shared realpath fence (chat folders only, state and secret directories denied),
   but `:9120`'s `/api/{list,file,file/raw,media}` accept any absolute path, as
   they always have. Any new file surface must use the fence; tightening `:9120`
   is separate.
8. **Attachments are staged, not native files.** Images become native image
   parts but keep the app's `[The user attached an image: …]` two-line reference
   in the user text (Hermex strips it into the chip; the model also gets the
   bytes), while a document is a text `@file:<path>` reference and a shared
   uploads root; DSH's native file part needs a `fileUploads/upload` receipt,
   which the host adapter does not broker yet. Local delivery only; the app's
   attachment chips read the same absolute path through `/api/fs/download`.
   The uploads root is append-only for this version (no pruning job), so treat
   it as local user data.
9. **Two ports, two servers on the phone.** Kind is fixed per URL, so the same
   host:port cannot be both. Keep the webui entry as the fallback until the
   Hermes one covers what you use.
