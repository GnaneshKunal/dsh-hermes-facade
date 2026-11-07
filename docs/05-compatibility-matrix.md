# 05 — Hermex compatibility matrix: Legacy (V1) and Hermes host (V2)

Last verified: **2026-11-07** · client: **Hermex 2.0.1** (build 1; sources at `7547796`, chat stack re-verified at
`ec066d9`) · facade: **main** (0.3.x, including the session write fence; see CHANGELOG) · DSH `0.2.2-rc.1` ·
transports: **hermes-webui** HTTP + SSE on **:9120** (the app calls it *Legacy*) and **Hermes host** REST +
JSON-RPC over a WebSocket on **:9121**.

This is the honest accounting of what the stock Hermex app can do against this facade, on **both** transports:
the endpoint or method behind each surface, what the phone shows when something is missing, and what it would
take to close the gap. The app is an App Store binary, so every fix here is server-side (response shaping plus a
DSH primitive). "Bridgeable?" says whether this plugin can close it, whether a DSH RPC that does not exist yet is
required, or whether it belongs to another transport entirely.

**Evidence.** The client's own Swift sources (call sites, decoders, error handling), the facade's route and method
tables, and runtime probes: `114` app-facing webui calls and `19` gateway methods plus every gateway REST route on
a standalone mock host. The legacy probe files are not committed; rerun with
`node scripts/standalone.mjs --port 9199 --gateway-port 9198` and the paths in [02-hermex-client-wire.md](02-hermex-client-wire.md).
The `:9121` section was additionally cross-checked against the upstream host contract
([01-hermes-gateway-api.md](01-hermes-gateway-api.md) and the fuller extraction of `/tmp/hermes-agent` at
`90d6b98`) and against the phone's own `access.log` in `~/.dsh/hermes-facade/`. No device retest was run for this
revision.

## 0. The app picks a transport once

Hermex decides what a server *is* from its **Add server** probe and stores the kind per URL forever; it never
re-probes, and there is no fallback from one stack to the other.

| Probe response | Kind | Transport used for everything | In the app |
|---|---|---|---|
| `GET /api/status` carries `auth_required` | **Hermes** (V2) | REST + `GET /api/ws` JSON-RPC; no webui route is called | a native server; no Legacy badge, no Move-to-Hermes invite |
| `GET /api/status` is 404 / has no `auth_required` | **hermes-webui** (V1) | REST + SSE `/api/chat/stream` | marked **Legacy**; keeps working, gets fixes only |

`:9120` deliberately does **not** answer `/api/status`, so it can only be the Legacy entry; `:9121` answers it
with `auth_required:true` and a stable `install_id`, so it can only be the Hermes entry. Add both as separate
servers. The two listeners share one password file, one state directory and one set of DSH sessions.

### Legend

| State | Meaning |
|---|---|
| **WORKS** | Behaves as the app expects. |
| **PARTIAL** | The route or method exists but the phone loses something (details, state, an option, a page). |
| **STUB** | Well-formed empty payload or `200 {ok:false}` refusal; the screen opens but the feature does nothing. |
| **404** / **-32601** | No route / no method, so the app shows its "endpoint not found" copy, or records the method as unavailable and hides the control. |
| **—** | Not applicable: the app never calls it on this transport, or it needs a different backend. |

A 404 is not an empty state: Hermex maps it to "The server endpoint was not found…". On the Hermes transport an
unknown **method** is `-32601`, which the client records per connection and uses to hide the matching control — this
is the graceful way to say "this host cannot do that". Ship a screen only when **all** of its routes exist; a
partial set half-renders.

---

## 1. Legacy surface (V1) — hermes-webui on `:9120`

| Surface | Endpoint(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Add server / sign in | `/health`, `/api/auth/{status,login,logout}` | **WORKS** | normal sign-in, signed cookie | — |
| Session list, grouping by project | `GET /api/sessions` | **WORKS** | rows grouped into project lanes; DSH subagent sessions are hidden (runner-owned, parent-addressed only) | enabling Hermex's Subagent Sessions toggle needs row tagging + parent-address reads |
| Pinned / archived state | same | **WORKS** | every row carries the real `pinned`/`archived` flags; archived rows hidden by default and listed via `include_archived=1` (+ `archived_limit`) | — |
| Session search | `GET /api/sessions/search` | **WORKS** | id, message-content and title matches, each with the session row; content matches carry a `match_preview` excerpt; an empty query is an empty result | — |
| Open chat / history | `GET /api/session` | **WORKS** (bounded) | newest **200** messages, then 50-message scroll-back pages, within the newest **800**; tool results, error verdicts and durations ride along as persisted tool calls | unbounded history still needs a `session/page` walk |
| Rename | `POST /api/session/rename` | **WORKS** | title updates | — |
| Branch / fork | `POST /api/session/branch` | **WORKS** | child session; needs a completed turn | — |
| Pin / archive (action) | `POST /api/session/{pin,archive}` | **WORKS** | accepted and visible on the next list read | — |
| Delete | `POST /api/session/delete` | **STUB** | "Not supported by DeepSeek Harness"; the row stays | needs DSH: no session-delete RPC |
| Duplicate | `POST /api/session/duplicate` | **STUB** | same refusal | needs DSH: no session import/copy RPC |
| Export / share | `GET /api/session/export` | **WORKS** (bounded) | JSON (default), HTML or markdown transcript with the share-sheet filename; the JSON form is what Move to Hermes imports | — |
| Compress / clear / undo / retry / truncate / move / update | `POST /api/session/*` | **STUB** | "Not supported"; edit, regenerate, undo, clear and project-move are unavailable | mostly needs DSH; `update` (model/workspace) is bridgeable |
| Model picker / switch | `POST /api/session/update`, `model` on `chat/start` and `session/new` | **WORKS** | applied through `session/selectModel`; catalog id and provider resolved, reasoning effort carried over | — |
| Chat workspace switch | `POST /api/session/update` with `workspace` | **PARTIAL** | filed under the chosen project, but DSH cannot change a started session's cwd | needs a DSH cwd-change primitive |
| YOLO / approval bypass | `GET/POST /api/session/yolo` | **PARTIAL** | GET is 404; POST always reports `yolo_enabled:false`, so "skip all" never sticks | yes |
| Projects (lanes) | `GET /api/projects` | **PARTIAL** | real read-only list | yes for CRUD: `workspace/*` |
| Project create / rename / delete | `POST /api/projects/*` | **STUB** | refusal message in the sheet | yes |
| Workspaces list | `GET /api/workspaces` | **WORKS** | list of DSH workspaces | — |
| Workspace add / remove / rename / reorder, suggestions | `POST /api/workspaces/*`, `GET /api/workspaces/suggest` | **STUB / 404** | inline warning; no path suggestions | yes |
| File browser (list/read/raw/media) | `GET /api/{list,file,file/raw,media}` | **WORKS** (read-only) | directory listing, text preview, images | writes not offered by this app build |
| Attachments (camera, picker, paste, share sheet) | `POST /api/upload` | **STUB** | upload refused; Send stays blocked while it tries | yes: store the file, return `{filename,path,size,mime,is_image}` |
| Composer catalogs | `/api/{profiles,models,reasoning,workspaces,commands}` | **PARTIAL** | models and reasoning work; profiles is one static profile; commands is empty | partly: commands catalog |
| Models live overlay | `GET /api/models/live` | **WORKS** | the picker's overlay replaces the active provider's group with the catalog's models | — (DSH has no cheaper "live" list) |
| Reasoning effort | `GET/POST /api/reasoning` | **WORKS** | levels come from the model catalog | — |
| Personalities | `GET /api/personalities`, `POST /api/personality/set` | **STUB** | empty list; setting refused | maybe: map to agent presets |
| Providers | `GET /api/providers` | **WORKS** (derived) | each routable provider with its models and active badge | — |
| Provider quota | `GET /api/provider/quota` | **404** | quota cards silently absent | needs a quota source; DSH has none |
| Settings (server page) | `GET/POST /api/settings`, `/api/updates/*`, `/api/default-model` | **PARTIAL / STUB** | version "Unknown", update check 404, settings save refused, default model acknowledged but not persisted | partly |
| Chat start / stream / stop / status / reconnect | `POST /api/chat/start`, `GET /api/chat/{stream,stream/status,cancel}` | **WORKS** | tokens, thinking, live tool cards, stop, replay after reconnect; a failed or cancelled turn ends with `error`/`cancel`, not as a success | — |
| Message fields on chat start | `model`, `model_provider`, `profile`, `attachments` | **PARTIAL** | model is applied; `profile` and `attachments` are still ignored without an error | attachments via upload + image blocks; profile needs a DSH mapping |
| Steer / queue while running | `POST /api/chat/steer` | **WORKS** | mid-run message queued | — |
| `/btw` side question | `POST /api/btw` | **STUB** | "Not supported" in the side panel | yes-ish: a side session; DSH has no btw primitive |
| `/background` task | `POST /api/background`, `GET /api/background/status` | **STUB / 404** | start refused; status 404 | needs a DSH background-agent primitive |
| `/goal` | `POST /api/goal` | **STUB** | refusal in the send banner | yes: `goals/*` |
| Approvals | `/api/approval/{pending,stream,respond}` | **WORKS** | once/deny/session/always apply; a reconnect keeps command/description; expired prompts answer `409 {"stale":true}`. session/always are standing grants keyed by **tool name** (no `pattern_key`), so they cover more than webui's command-pattern allowlist and the "Allow session covers every …" sentence stays hidden | — |
| Clarifications | `/api/clarify/{pending,stream,respond}` | **WORKS** | live and re-attached cards carry `question`/`choices_offered`; a resolved or timed-out prompt is retracted | — |
| Insights / usage | `GET /api/insights` | **STUB** | "No Data" | partly: session/context usage |
| Tasks / cron | `GET /api/crons`, `POST /api/crons/*` | **STUB / 404** | empty list; create/run/pause/resume refused; history/output/status 404 | yes: `schedule/*` |
| Skills | `GET /api/skills`, `/api/skills/content`, `POST`/`PUT /api/skills/toggle` | **WORKS** (read-only list/content) | the list and SKILL.md come from DSH's catalogue. The webui row carries no `disabled`, so its toggle is hidden; a POST or PUT toggle would answer 400 with the reason | `skills/list` (per-session; the newest session, archived included) |
| Memory | `GET /api/memory`, `POST /api/memory/write` | **STUB** | blank editors; save refused | no DSH memory store; would be a new feature |
| Kanban | `/api/kanban/*` | **STUB** | boards empty; `events/stream` answers JSON, not SSE | a whole backend, not a bridge |
| Git panel | `/api/git-info`, `/api/git/*` | **STUB** | panel unavailable | yes: run `git` in the session cwd |
| Voice dictation | `POST /api/transcribe` | **STUB** | server refuses; app falls back to on-device dictation | optional |
| Listen / TTS | `GET /api/tts` | **STUB** | server speech refused; app uses on-device voice | optional |
| Live Activity / run status | `GET /api/chat/stream/status` | **WORKS** while connected | status polling reconciles the Live Activity | — |

### Subagent sessions (both transports)

DSH child-agent sessions carry `origin: "subagent"` and are only addressable through their durable parent. Hermex
has **Settings → Sessions → Subagent Sessions** (default off) and classifies children only from an explicit source
marker, never from `parent_session_id`. The facade **hides** them: `GET /api/sessions` filters those rows and a
direct open answers `400` with a readable detail. They are runner-owned and view-only, so they add no value in the
list. Enabling the toggle later needs row tagging (`session_source: "subagent"`, `read_only:true`) and reads
through the durable parent address.

---

## 2. Hermes-host surface (V2) — REST + WebSocket on `:9121`

### 2.1 Boot, auth and the socket

| Surface | Endpoint(s) / method(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Add server / version gate | `GET /api/status` | **WORKS** | `version: "0.22.5"` (gate ≥ `0.21.3`, tested `0.23.0`), `auth_required:true`, stable `install_id`; classified as Hermes | — |
| Health | `GET /api/health` | **WORKS** | liveness before the update wait | — |
| Sign in | `POST /auth/password-login`, `GET /api/auth/me` | **WORKS** | same password as `:9120`; `hermes_session_at/_rt/_provider` cookies; 401/429 as the host | — |
| Socket ticket | `POST /api/auth/ws-ticket` | **WORKS** | 30 s, single use, presented in `Sec-WebSocket-Protocol` | — |
| Socket handshake | `GET /api/ws` | **WORKS** | `gateway.ready` with a non-empty `replay_epoch`, `session_authority:false` (a `true` here is refused as a bare gateway listener) | — |
| Capability advertisement | `client.capabilities` | **WORKS** | answered; approval/clarify go only to a socket that advertised `server_requests`, and one that did not can still read `open_requests` and answer by RPC | — |
| Heartbeat | `gateway.ping` | **WORKS** | 15 s keepalive; `{ok:true}` | — |
| Unknown method | `-32601` | **WORKS** | client records it and hides the matching control | — |
| Sign out | `POST /auth/logout` | **—** | never sent on a Hermes host (sign-out drops the Keychain record) | — |

### 2.2 Chat core

| Surface | Endpoint(s) / method(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Open / attach a chat | `session.resume`, `session.events.since` then `GET /api/sessions/{id}/messages` | **WORKS** | live state without the transcript; the settled rows come over REST | — |
| Send | `prompt.submit` | **WORKS** | accepted as `streaming`/`queued`; a busy session queues instead of refusing | — |
| Stream | `message.start/delta/interim`, `reasoning.delta`, `tool.start/tool.complete` | **WORKS** | tokens, thinking, live tool cards with args/result; per-session contiguous `seq` | the tool result is the facade's preview text (no parsed object or `duration_s`) |
| Turn end | `message.complete`, `session.usage`, `session.info {running:false}` | **WORKS** (no cost) | the turn settles with the canonical `status:"complete"` and carries `usage` (`context_used`, `context_max`, `input`, `output`); a live `session.usage` frame fills the context ring mid-turn, and the `/api/session` detail carries the same snapshot so it survives the post-turn refresh. No `persisted_turn` receipt, and no cost: DSH reports tokens, not prices | turn receipt needs saved row ids; cost needs a pricing source |
| Stop | `session.interrupt` | **WORKS** | stops the turn and answers the contract's `interrupted`/`not_interrupted` | — |
| Steer / queue | `session.steer`, `prompt.submit` while running | **WORKS** | queued/rejected; never `redirected` | — |
| Edit / regenerate / retry | `prompt.submit` with `truncate_before_row_id` | **PARTIAL** | we ignore the truncation, so the edited prompt is appended instead of rewinding | needs a DSH transcript-truncation primitive |
| Undo / compress | `session.undo`, `session.compress` | **404/-32601** | the slash commands answer "not supported" | needs DSH primitives |
| Reconnect / replay | `session.events.since` | **WORKS** | contiguous per-session `seq`; `epoch`, `truncated`, `open_requests` replay the cards | — |
| Approvals | server→client `approval` + `approval.respond` | **WORKS** | once/session/always/deny; a reconnect replays open cards; a turn end withdraws them | — |
| Clarifications | server→client `clarify` then `request.answer`/`clarify.lock` | **WORKS** | single-question cards (the legacy shape the client decodes); a batch would be answered one question deep | — |
| Title updates | `session.title` | **WORKS** | live rename; omitting the title reads the current one | — |
| Attachments | `file.attach`, `POST /api/chat/image-upload` | **404/-32601** | attach affordances are hidden or fail; a send with an attachment never reaches the model | yes: `fileUploads/upload` returns a receipt, so a staging path is needed |
| Side tasks (`/btw`, `/background`) | `prompt.btw`, `prompt.background` | **-32601** | side panels hidden | needs DSH primitives |
| Goal / loop / heartbeat | `session.control.read`, `session.control` | **-32601** | the goal menu is hidden | partly: DSH has a `goal` projection, no loop/heartbeat |
| Delegated work | `subagent.list/tail/interrupt` | **-32601** | the follow-a-subagent fold is hidden | partly: DSH has subagent sessions |

### 2.3 Composer, models and commands

| Surface | Endpoint(s) / method(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Model picker | `model.options` | **WORKS** | providers/models from the DSH catalog, with the active tick from the session | — |
| Reasoning effort | `config.set` `reasoning` | **WORKS** | applied through the facade; the reply carries the effective level | — |
| Model switch | `config.set` `model` | **WORKS** | applied through `session/selectModel`; drafts remember it | — |
| Fast mode | `config.set` `fast` | **-32000** | refused with a key-level error, so the chip reverts instead of showing a false state | needs a DSH fast-mode primitive |
| YOLO / approvals mode | `config.set` `yolo`, `approvals.mode` | **-32000** | both are refused with a key-level error, so the switches revert instead of showing a state the host never stored | yes (approval policy) |
| Personality | `config.set` `personality` | **-32000** | the picker errors; DSH has agent presets, not personalities | maybe: map to presets |
| Commands | `commands.catalog` | **WORKS** | slash commands as pairs + canon | no categories/skills half |
| Slash execution / completion | `complete.slash`, `command.dispatch`, `slash.exec`, `complete.path` | **-32601** | autocomplete and `@path` completion are missing; typed commands still send as text | partly: `commands/list`, directory listing |
| Profiles | `profiles.list`, `profiles.describe` | **PARTIAL** | one Profile, `default`; its row carries the absolute `$DSH_HOME` path so Memory's folder lookup (and any client-side absolute check) resolves, but Bots still has no backend | yes: `path` for Memory |

### 2.4 Sessions — REST and actions

| Surface | Endpoint(s) / method(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| List / paging | `GET /api/sessions` | **WORKS** | `order`, `archived`, `limit`, `offset` honoured; rows carry id/title/pinned/archived/timestamps/counts | rows lack `preview`, so the list shows no snippet |
| One row / transcript | `GET /api/sessions/{id}`, `/messages` | **WORKS** | 500-row pages, latest/oldest, `include_compacted` accepted | bounded by the host's 800-message window |
| Rename / pin / archive | `PATCH /api/sessions/{id}` behind `GET …/mutation-snapshot` | **WORKS** (since the write fence) | list actions apply; a stale revision answers `409 revision_conflict` and the phone says the chat changed | — |
| Write fence | `GET /api/sessions/{id}/mutation-snapshot` | **WORKS** | `{exists, runtime_revision}`; without this route every list action used to fail | — |
| Mark unread | `PATCH … {unread}` | **400** | refused with a detail; DSH has no unread flag | — |
| Branch / fork | `session.branch` | **WORKS** | a copy; needs a completed turn | — |
| Move to folder | `session.workspace.move` | **PARTIAL** | works for a chat with no messages; refused afterwards with an explanation | needs a DSH cwd-change primitive |
| Delete | `session.delete`, `DELETE /api/sessions/{id}` | **STUB** | "not supported by DeepSeek Harness" | needs DSH |
| Duplicate / import | `POST /api/sessions/import` | **STUB** | 400: DSH cannot inject a transcript, so Move to Hermes cannot land here yet | needs DSH |
| Export | `GET /api/sessions/{id}/export` | **WORKS** | JSON transcript download (the form Move to Hermes imports) | bounded by the host snapshot |
| Search | `GET /api/sessions/search`, `session/search` | **WORKS** (REST) | the list search field returns id/content/title matches; host content rows carry no excerpt (DSH exposes no author), the Legacy rows keep `match_preview`; the RPC stays `-32601` (2.0.1 uses the REST route) | — |
| Live Working / Needs-you | `session.active_list`, `sessions.changed` | **-32601** | the live dots are absent | yes: S over the runner's state |
| Projects (lanes) | `projects.tree` | **WORKS** | DSH workspaces drawn as folder lanes | project delete/edit missing |
| Session store health | `GET /api/sessions/stats`, `/prune` | **—** | never called by 2.0.1 | — |

### 2.5 The other screens a Hermes host unlocks

The sidebar toggle for Kanban is a local preference (on by default), not
capability probes, so an absent backend shows the screen's own error. Kanban is the exception: its
`/api/plugins/kanban/config` 404 gives the clean "unavailable" state.

| Surface | Endpoint(s) / method(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Files (in-chat workspace) | `GET /api/fs/list`, `/api/fs/read-text`, `/api/fs/download` + `session.info.terminal_backend:"local"` | **WORKS** (read-only) | the Files link opens a browser for the chat's folder: listing (host caches and credential stores hidden), text previews (first 512 KiB), binary/image downloads. A path outside the chat's folders answers `403`; credential material answers `403` wherever it sits; sources over 64 MiB answer `413`; the facade state and secret directories are never served. Git still has no `fs/git-root`, so its menu stays hidden | — (the shared fence is in place; Git reuses it, while Memory deliberately reads only its AGENTS.md allowlist because the fence denies `$DSH_HOME`) |
| Git (in-chat, read-only) | `GET /api/fs/git-root`, `/api/git/status`, `/api/git/review/{list,diff}`, `/api/git/file-diff`, `/api/git/review/rev-parse`, `/api/git/branches` | **WORKS** (read) | the Git menu opens in a repository: branch/ahead/behind, changed files and counts, staged/unstaged/untracked flags, per-file patches, branch list. Writes and branch switch answer `400` with a reason, and no pull request is reported. A credential file is filtered from the rows and its diff answers `403`; reads are limited to the repository holding the chat's folder | writes next: stage/commit/push behind the idle guard |
| Tasks / cron | `GET /api/cron/jobs`, `/runs`, `POST /api/cron/jobs`, `PUT /api/cron/jobs/{id}`, `POST …/{pause,resume,trigger}`, `DELETE`, `/api/cron/delivery-targets` | **WORKS** (local delivery) | the Tasks list shows schedules with next/last run and state; create/edit/pause/resume/trigger/delete round-trip; a run's output opens as its session. Delivery is local only, model/provider/skills are refused, run history is the schedule's delivery records (no cost), and `sources=cron` on the agenda is still empty because DSH has no session provenance | — |
| Skills | `GET /api/skills`, `/api/skills/content`, `PUT /api/skills/toggle` + `/api/fs/*` for linked files | **WORKS** (read-only) | the Skills screen lists the host's skills with descriptions, opening one shows its SKILL.md, and an empty catalogue is a real empty state. DSH's catalogue is per session composition, so the newest session (archived included) is used; no sessions means an empty list. The toggle answers 400 (DSH has no skill-disable primitive). Linked files show only when the skill sits inside a chat's fenced roots; a skill in `$DSH_HOME` opens without them | — |
| Memory | `GET /api/config` `.memory`, `/api/profiles/{name}/soul`, `GET /api/files/read`, `POST /api/files/upload`, `profiles.list[].path` | **WORKS** (read-only) | the Memory screen shows the global `$DSH_HOME/AGENTS.md` as MEMORY.md (a missing file is an honest empty state), no USER.md (the config turns that section off), and an empty soul. `profiles.list` carries the real `$DSH_HOME` path (absolute, as Hermex treats it as a host path); `/api/files/read` serves only a `.../memories/MEMORY.md` suffix and 404s every other path, so it is not a second file browser. Saves answer 400 (read-only). Project AGENTS.md files are not shown: the screen is global, not per-workspace. Two nuances: DSH's user-global chain is `$DSH_HOME/AGENTS.md` then `$DSH_AGENTS_HOME/AGENTS.md` (default `~/.agents/AGENTS.md`), and this screen shows the first only; the config's `memory_char_limit` is the editor's counter, not a DSH instruction budget, and the read is not size-capped | — |
| Usage / Insights | `GET /api/analytics/{usage,models}`, `insights.get` | **WORKS** (token-only) | the screen shows sessions, input/output/cache tokens, per-model rows and a daily chart from DSH's cached session projections. DSH has no per-day ledger, so a session's cumulative tokens land on its last prompt day (falling back to the row's `updatedAt`); archived and subagent sessions are included because their tokens are real usage. A session with no model still counts in totals/daily but has no model row. Cost stays 0 because DSH has no pricing; the Messages total is 0 because DSH exposes no message count (the screen marks it approximate) | — |
| Kanban | `/api/plugins/kanban/*` | **404** | the tab shows "unavailable" cleanly | no: a whole board + workers DSH does not model |
| Bots / Bot screen | `profiles.*`, `/api/dashboard/plugins/*`, `display.*`, `/api/display/ws`, `hermex-screen` routes | **PARTIAL / 404** | one Profile; creating/configuring a bot is refused; the live bot screen is unavailable | Bots: L (a facade store + preset); screen: no |
| Push / Live Activity | `/api/plugins/hermex-push/*` | **404** | every plugin-backed control disappears — the intended graceful path | no: a relay + APNs, not a host route |
| Dictation / spoken replies | `POST /api/audio/transcribe`, `/api/audio/speak` | **404** | on-device dictation and voice are used instead | STT: M (`speech/transcribe`); TTS: no primitive |
| Move to Hermes (destination) | `POST /api/sessions/import` | **STUB** | 400; the move cannot land here | needs DSH transcript injection |
| Settings (server page) | `GET/PUT /api/config`, `/api/env` CRUD, `/api/dashboard/{plugins/hub,plugins/catalog,agent-plugins/*}`, `plugins.manage`, `/api/hermes/update/*`, `/api/actions/hermes-update/status` | **PARTIAL / 404** | config GET works; the platform note (PUT) is refused/ignored; API-keys, plugins and update rows are empty/error | partly: `pluginManager/*` read-only; updates: no |
| Default model / themes / `model/info` | `/api/default-model`, `/api/dashboard/themes` | **—** | webui-only; the app never calls themes or `model/info` on a Hermes host | — |

---

## 3. The same feature on both transports

| Feature | V1 (:9120, Legacy) | V2 (:9121, Hermes) |
|---|---|---|
| Sign in | `/health` then `/api/auth/status` then `/api/auth/login` | `/api/status` then `/auth/password-login`; ws ticket |
| Chat | `POST /api/chat/start` + SSE | `prompt.submit` + socket events |
| Approvals / clarify | REST polling + SSE side streams | server→client JSON-RPC requests |
| Transcript | `GET /api/session` (bounded 800) | `GET /api/sessions/{id}/messages` (bounded 800, 500/page) |
| Rename / pin / archive | POST routes | PATCH behind the write fence (now works) |
| Delete / import | refused | refused |
| Export | works | works |
| Files browser | **works** (read-only) | **works** (read-only, fenced to the chat folder) |
| Session search | works | works (REST; the RPC is unused) |
| Tasks | stub (`/api/crons`) | works over `/api/cron/*` (local delivery only) |
| Memory | works read-only | the global AGENTS.md, no USER/soul editing |
| Skills | works read-only | list and SKILL.md; toggle refused |
| Usage | stub (`/api/insights`) | works token-only; cost 0, messages ≈0 |
| Git | panel unavailable | read-only: status, changes, diffs, branches; writes refused |
| Kanban | stub | 404, "unavailable" |
| Attachments | refused | RPC missing; a send with an attachment fails |
| YOLO | POST reports false | refused with a key-level error (honest) |
| `@path` completion | n/a | `complete.path` -32601 |

---

## 4. Known defects that are not deliberate stubs

### Legacy (:9120)

1. **Approval scope is coarser than the app's copy.** Grants are keyed by tool name; a `bash` grant covers every
   `bash` call, and `pattern_key` is not sent. Grants live in the process and are lost on restart.
2. **Silent profile/attachment loss** on `chat/start` and `session/new` (the model is applied).
3. **History is bounded at 800 messages**; export uses the host snapshot (wider cap 5000).
4. **Stream journals are bounded**: replayable for 30 minutes and the newest 64 are kept.
5. **A clarification answer is one question**; several-at-once would answer only the first.
6. **Clarify expiry is not a 409**; the card is cleared by the retraction or polling instead.
7. A direct open of a subagent session must answer `400`; the runner can still surface it as a 500 for a row the
   facade did not classify.

### Hermes host (:9121)

The wire defects found in the 2026-11-07 audit were fixed in the same change (CHANGELOG): the turn now reports the
canonical `status:"complete"`, `session.title` has its read form, `session.interrupt` answers the contract's
vocabulary, `session.list` carries the full row, a PATCH applies every field it names, `/stats`
answers a plain 404 instead of "Session not found" (`/search` now works), `sources` is matched as a CSV, `limit=0` is honoured, reverse
requests are gated on `client.capabilities` (and a raw JSON-RPC answer withdraws the frame), the login rate limit
keys on the forwarded client rather than the shared proxy address, an empty prompt no longer promotes a draft, two
concurrent submits share one session and run in order, `session.info` falls back to the catalog default when the
session names no model, and Fast/yolo are refused instead of echoed. What remains:

1. **Git is read-only.** The menu shows status, changes, diffs and branches, but stage/unstage/revert/commit/push
   and branch switch answer `400 {"detail":"Git writes are not supported by this DeepSeek Harness host yet"}`.
   The commit-message helper is unavailable too (it is a write-path read), and no pull request is reported.
2. **No persisted-turn receipt and no cost.** `message.complete` now carries `usage` and a live
   `session.usage` fills the ring, but `partial`/`persisted_turn` are absent (DSH does not expose the saved row ids),
   and no cost exists anywhere: DSH has token usage but no pricing, so the Usage screen stays token-only.
3. **Edit / regenerate / retry append instead of rewinding** (`truncate_before_row_id` ignored).
4. **Session list rows lack `preview`** (the rest of the row shape is now mapped); the WS `session.list` rows are
   the same shape as REST.
5. **Event rings are 1000 per session with no session/byte cap**, and `forget()` is never called.
6. **`personality` and `approvals.mode`** answer key-level errors by design (DSH has presets, not personalities,
   and no yolo policy); the controls hide/revert rather than lie.
7. **No `ping`, `gateway.capabilities`, `session.history`, `session.status`, `session.usage`, `approval.pending`,
   `approval.received` or `session.archive`** — none is in 2.0.1's `HermesCall`, so they are not blocking; they are
   listed because an older or newer client could send them.

### Security (both)

The `:9121` Files routes are fenced: a path is served only when its realpath is inside a chat folder (DSH
workspaces, known session folders, and a draft's chosen folder), and never when it is inside the facade's state
directory, `$DSH_HOME` or the usual secret directories; symlinks resolve first, so a link cannot point out. The
Legacy `:9120` browser still accepts any absolute path, as it always has (same boundary as DSH's own GUI), and the
client's own path check is explicitly not a security boundary. The read-only Git routes admit the repository root
that holds a chat folder (normally above it) and refuse a diff of a credential file.

---

## 5. Verifying a build

```bash
curl -s http://127.0.0.1:9120/health
# {"status":"ok","active_streams":0,"features":[...],"history":{"page":200,"window":800}}
curl -s http://127.0.0.1:9121/api/status
# {"version":"0.22.5","auth_required":true,"auth_providers":["basic"],"install_id":"…"}

cd ~/self/dsh-hermes-facade && npm run check && npm test
node scripts/standalone.mjs --port 9199 --gateway-port 9198   # mock host for both listeners
```

`test/hermes-gateway.test.mjs` drives the whole Hermes contract with a real WebSocket client: status, login,
ticket, `gateway.ready`, capabilities, session list, REST paging, the write fence, a streamed turn and an approval
answered as a reverse request. `~/.dsh/hermes-facade/unknown-endpoints.log` names anything the phone asked for that
the facade did not implement.

---

## 6. What to work on next

The ranked plan — one small first task, then the big ones, with effort and dependencies — is
[07-v2-roadmap.md](07-v2-roadmap.md).
