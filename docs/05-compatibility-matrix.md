# 05 — Hermex 2.0 compatibility matrix

Last verified: **2026-11-07** · client: Hermex **2.0.1** source (`ec066d9`) · facade: **main** (history
paging, tool results, model switching, honest turn outcomes, pin/archive visibility, export, live
model overlay, approval/clarify reconnect; see CHANGELOG) ·
DSH `0.2.2-rc.1` · protocol: hermes-webui HTTP + SSE.

This is the honest accounting of what the stock Hermex iOS app can do against this facade, what it
shows when something is missing, and what it would take to close each gap. The app is an App Store
binary: every fix here is server-side (response shaping plus a DSH primitive). "Bridgeable?" says
whether this plugin can close it, whether a DSH RPC that does not exist yet is required, or whether
it belongs to the other (gateway) transport entirely.

Evidence: the client's own Swift sources (call sites and error handling), the facade route table,
and a runtime probe of **114 app-facing calls** against the standalone harness. The probe files are
not committed; rerun with `node scripts/standalone.mjs --port 9199` and the paths in
`docs/02-hermex-client-wire.md`.

## Legend

| State | Meaning |
|---|---|
| **WORKS** | Behaves as the app expects. |
| **PARTIAL** | The route exists but the phone loses something (details, state, an option, a page). |
| **STUB** | Well-formed empty payload or `200 {ok:false}` refusal; the screen opens but the feature does nothing. |
| **404** | No route (or wrong method), so the app shows "The server endpoint was not found". |
| **—** | Not applicable: the app never calls it on a webui account, or it needs a different transport. |

A 404 is not an empty state: Hermex maps it to "The server endpoint was not found. Check that the URL
points to your configured server." Only the 408/502/503/504 statuses fall back to cached rows.

## Webui surfaces (main app)

| Surface | Endpoint(s) | State | What the phone shows | Bridgeable? |
|---|---|---|---|---|
| Add server / sign in | `/health`, `/api/auth/{status,login,logout}` | **WORKS** | normal sign-in, signed cookie | — |
| Session list, grouping by project | `GET /api/sessions` | **WORKS** | rows grouped into project lanes; DSH subagent sessions are hidden for now (runner-owned, parent-addressed only) | enabling Hermex's Subagent Sessions toggle needs row tagging + parent-address reads |
| Pinned / archived state | same | **WORKS** | every row carries the real `pinned`/`archived` flags, read from the workspace baseline; the default response hides archived rows and reports `archived_count`, and `include_archived=1` (+ optional `archived_limit`) fills the app's Archived screen | — |
| Session search | `GET /api/sessions/search` | **404** | "endpoint not found"; only the local title filter still works | yes: `session/search` |
| Open chat / history | `GET /api/session` | **WORKS** (bounded) | newest **200** messages, then 50-message scroll-back pages, within the newest **800**; tool results, error verdicts and durations ride along as persisted tool calls | unbounded history still needs a `session/page` walk |
| Rename | `POST /api/session/rename` | **WORKS** | title updates | — |
| Branch / fork | `POST /api/session/branch` | **WORKS** | child session; needs a completed turn | — |
| Pin / archive (action) | `POST /api/session/pin`, `POST /api/session/archive` | **WORKS** | accepted and visible on the next list read (the workspace cache is dropped) | — |
| Delete | `POST /api/session/delete` | **STUB** | "Not supported by DeepSeek Harness"; the row stays | needs DSH: no session-delete RPC |
| Duplicate | `POST /api/session/duplicate` | **STUB** | same refusal | needs DSH: no session import/copy RPC |
| Export / share | `GET /api/session/export` | **WORKS** (bounded) | JSON (default), HTML or markdown transcript with the share-sheet filename from `Content-Disposition`; the JSON form is the one Move to Hermes imports. Bounded by the host's transcript snapshot | — |
| Compress / clear / undo / retry / truncate / move / update | `POST /api/session/*` | **STUB** | "Not supported"; edit, regenerate, undo, clear and project-move are unavailable | mostly needs DSH; `update` (model/workspace) is bridgeable |
| Model picker / switch | `POST /api/session/update`, `model` on `chat/start` and `session/new` | **WORKS** | applied through `session/selectModel`; catalog id and provider are resolved, reasoning effort carried over | — |
| Chat workspace switch | `POST /api/session/update` with `workspace` | **PARTIAL** | the session is filed under the chosen project (grouping), but DSH cannot change a started session's cwd | needs a DSH cwd-change primitive |
| YOLO / approval bypass | `GET/POST /api/session/yolo` | **PARTIAL** | GET is a 404; POST always reports `yolo_enabled:false`, so "skip all" never sticks | yes |
| Projects (lanes) | `GET /api/projects` | **PARTIAL** | real read-only list | yes for CRUD: `workspace/*` |
| Project create / rename / delete | `POST /api/projects/*` | **STUB** | refusal message in the sheet | yes |
| Workspaces list | `GET /api/workspaces` | **WORKS** | list of DSH workspaces | — |
| Workspace add / remove / rename / reorder, suggestions | `POST /api/workspaces/*`, `GET /api/workspaces/suggest` | **STUB / 404** | inline warning; no path suggestions | yes |
| File browser (list/read/raw/media) | `GET /api/{list,file,file/raw,media}` | **WORKS** (read-only) | directory listing, text preview, images | writes not offered by this app build |
| Attachments (camera, picker, paste, share sheet) | `POST /api/upload` | **STUB** | upload refused; Send stays blocked while it tries | yes: store the file, return `{filename,path,size,mime,is_image}` |
| Composer catalogs | `/api/{profiles,models,reasoning,workspaces,commands}` | **PARTIAL** | models and reasoning work; profiles is one static profile; commands is empty | partly: commands catalog |
| Models live overlay | `GET /api/models/live` | **WORKS** | the picker's overlay replaces the active provider's group with the cached catalog's models; provider ids match `/api/models` | — (DSH has no cheaper "live" list than the catalog) |
| Reasoning effort | `GET/POST /api/reasoning` | **WORKS** | levels come from the model catalog | — |
| Personalities | `GET /api/personalities`, `POST /api/personality/set` | **STUB** | empty list; setting refused | maybe: map to agent presets |
| Providers | `GET /api/providers` | **WORKS** (derived) | each routable provider with its models and active badge, read-only as the screen expects; credential provenance is approximated from the catalog because DSH exposes no key inventory here | — |
| Provider quota | `GET /api/provider/quota` | **404** | quota cards silently absent | needs a quota source; DSH has none |
| Settings (server page) | `GET/POST /api/settings`, `/api/updates/*`, `/api/default-model` | **PARTIAL / STUB** | version "Unknown", update check 404, settings save refused, default model acknowledged but not persisted | partly: settings/default-model via DSH config |
| Chat start / stream / stop / status / reconnect | `POST /api/chat/start`, `GET /api/chat/{stream,stream/status,cancel}` | **WORKS** | tokens, thinking, live tool cards, stop, replay after reconnect; a failed or cancelled turn ends the run with `error`/`cancel`, not as a success | — |
| Message fields on chat start | `model`, `model_provider`, `profile`, `attachments` | **PARTIAL** | model is applied; `profile` and `attachments` are still ignored without an error | attachments via upload + image blocks; profile needs a DSH mapping |
| Steer / queue while running | `POST /api/chat/steer` | **WORKS** | mid-run message queued | — |
| `/btw` side question | `POST /api/btw` | **STUB** | "Not supported" in the side panel | yes-ish: a side session; DSH has no btw primitive |
| `/background` task | `POST /api/background`, `GET /api/background/status` | **STUB / 404** | start refused; status 404 | needs a DSH background-agent primitive |
| `/goal` | `POST /api/goal` | **STUB** | refusal in the send banner | yes: `goals/*` |
| Approvals | `/api/approval/{pending,stream,respond}` | **WORKS** | once/deny/session/always all apply; a reconnect or polling keeps command/description; a resolved or timed-out prompt is retracted; an expired respond answers `409 {"stale":true}`. session/always are standing grants keyed by **tool name** (no `pattern_key`), so they cover more than webui's command-pattern allowlist and the "Allow session covers every …" sentence stays hidden | — |
| Clarifications | `/api/clarify/{pending,stream,respond}` | **WORKS** | live and re-attached cards both carry `question`/`choices_offered`, so they render and answer as clarifications; a resolved or timed-out prompt is retracted | — |
| Insights / usage | `GET /api/insights` | **STUB** | "No Data" | partly: session/context usage |
| Tasks / cron | `GET /api/crons`, `POST /api/crons/*` | **STUB / 404** | empty list; create/run/pause/resume refused; history/output/status 404 | yes: `schedule/*` (mapping work) |
| Skills | `GET /api/skills`, `GET /api/skills/content`, `POST /api/skills/toggle` | **STUB / 404** | empty list; content 404; toggle refused | yes for list/content: `skills.list` + skill files |
| Memory | `GET /api/memory`, `POST /api/memory/write` | **STUB** | blank editors (payload keys do not even match the client); save refused | no DSH memory store; would be a new feature |
| Kanban | `/api/kanban/*` | **STUB** | boards empty; other routes `ok:false`; `events/stream` answers JSON, not SSE | a whole backend, not a bridge |
| Git panel | `/api/git-info`, `/api/git/*` | **STUB** | panel unavailable (every route `ok:false`) | yes: run `git` in the session cwd |
| Voice dictation | `POST /api/transcribe` | **STUB** | server refuses; app falls back to on-device dictation | optional; on-device path is fine |
| Listen / TTS | `GET /api/tts` | **STUB** | server speech refused; app uses on-device voice | optional |
| Live Activity / run status | `GET /api/chat/stream/status` | **WORKS** while connected | status polling reconciles the Live Activity | — |

## Subagent sessions

DSH child-agent sessions carry `origin: "subagent"` and are only addressable through their durable
parent — `{kind:"subagent", parentSessionId, childSessionId, mode:"one-shot"|"continuable"|"unknown"}`.
A plain `{kind:"session", sessionId}` read is rejected with "subagent Sessions require their durable
parent address" (surfaced as a 500 before this fix).

Hermex has **Settings → Sessions → Subagent Sessions** (default off). It classifies delegated
children only from an explicit source marker (`session_source`/`source_tag`/`raw_source` =
"subagent"), hides them by default, and marks them view-only when shown. It does not infer them from
`parent_session_id`.

For now the facade **hides** subagent sessions: `GET /api/sessions` filters `origin: "subagent"`
rows, and a direct `GET /api/session` for one answers `400` with a readable detail. They are
runner-owned, view-only, and the app's toggle is off by default, so they add no value in the list
and previously produced broken chats.

Future work to enable the toggle: tag those rows `session_source: "subagent"` + `read_only: true`,
and read them through the durable parent address (`{kind:"subagent", parentSessionId,
childSessionId, mode:"unknown"}`) so the toggle opens a view-only transcript.

## Hermes-host (gateway) surfaces — not servable here

These are the forked transport (JSON-RPC over `/api/ws`), not hermes-webui. The facade deliberately
does not answer `/api/status`, because that would make Hermex switch to this stack and then demand a
gateway we do not implement.

| Surface | Why it cannot work |
|---|---|
| Bots (inbox, rooms, bot chat, artifacts, bot screens) | gateway RPC + display socket |
| Push / APNs pairing, Live Activity relays | Hermes-host pairing and plugin routes |
| Move to Hermes (destination side) | requires a Hermes host, by definition |
| Hermes-host admin: env/config/profiles/plugins, gateway restart | dashboard routes and RPCs |
| Provider quota via the hermex-push plugin | plugin on the Hermes host |
| Kanban / Memory / Skills on a Hermes host | different clients over the gateway |

## Known defects that are not deliberate stubs

1. **Approval scope is coarser than the app's copy.** The grant behind "Allow session"/"Always
   allow" is keyed by tool name, because the host approval request exposes no command pattern; a
   `bash` grant covers every `bash` call. `pattern_key`/`pattern_keys` are not sent, so the app
   shows no scope line. Grants live in the facade process and are lost on restart.
2. **Silent profile/attachment loss** on `chat/start` and `session/new` (the model is applied now).
3. **History is bounded at 800 messages** by the recent-window read; paging works inside it.
   Session export uses the same host snapshot (with a wider cap of 5000 messages), so a very long
   chat exports what the host can still return.
4. **Stream journals are kept for a bounded time.** A finished stream stays replayable for 30
   minutes (config `streamRetainMs`) and the newest 64 finished journals are kept; older ones are
   pruned as the next turn finishes, never held for the process lifetime.
5. **A clarification answer is one question.** The facade surfaces the first question; a batch with
   several questions would be answered with only the first. The app's card is single-question, so
   this only appears if a tool asks several at once.
6. **Clarify expiry is not a 409.** A respond to an expired clarification still answers
   `200 {ok:false}`; the phone learns the prompt is gone from the stream retraction or from polling
   (both clear the card), not from `409 {"stale":true}`.

## Verifying a build

```bash
curl -s http://127.0.0.1:9120/health
# {"status":"ok","active_streams":0,
#  "features":["history-paging","tool-results","model-switch","session-export","pin-archive","providers","approval-retract","clarify-markers"],
#  "history":{"page":200,"window":800}}

cd ~/self/dsh-hermes-facade && npm run check && npm test
node scripts/standalone.mjs --port 9199     # mock host; probe the wire contract by curl
```

`/health` carries the build marker, so after a hot reload (dsh-hmr) or a restart it is obvious
which code is live. The app ignores the extra keys.

## Hermes host (gateway) — served by the :9121 listener

Since 0.3.0 the plugin can also present itself as a **Hermes host** on a second
port, so Hermex 2.x files it as a native server instead of a Legacy webui one.
The contract is REST + JSON-RPC over `/api/ws`; details and method tables are in
[docs/06-hermes-gateway.md](06-hermes-gateway.md). Every answer still comes from
this facade over loopback, so the *DSH* mapping below is unchanged.

| Surface | Endpoint(s) | State | Notes |
|---|---|---|---|
| Add server / sign in | `/api/status`, `POST /auth/password-login`, `/api/auth/me`, `POST /api/auth/ws-ticket` | **WORKS** | cookie session + 30 s single-use socket ticket, same password file as :9120 |
| Socket handshake | `GET /api/ws` | **WORKS** | ticket in `Sec-WebSocket-Protocol`; `gateway.ready` carries `replay_epoch`, `session_authority:false` |
| Session list / open / paging | `GET /api/sessions`, `/api/sessions/{id}`, `/api/sessions/{id}/messages` | **WORKS** | `order`, `archived`, `limit`, `offset` honoured; transcript rows in the host's shape |
| Rename / pin / archive | `PATCH /api/sessions/{id}`, `session.title` | **WORKS** | through the facade's own routes |
| Branch / export | `session.branch`, `GET /api/sessions/{id}/export` | **WORKS** | branch needs a completed turn; export forwards the JSON transcript |
| Delete / import | `DELETE /api/sessions/{id}`, `POST /api/sessions/import` | **REFUSED** | 400 with the reason: DSH has no delete and no transcript injection, so Move to Hermes cannot land here yet |
| Chat / streaming / stop / steer | `prompt.submit`, `session.interrupt`, `session.steer`, socket events | **WORKS** | message.start/delta/interim, reasoning.delta, tool.start/complete, message.complete, session.info |
| Approvals | server->client `approval` + `approval.respond` | **WORKS** | once/session/always/deny; the facade's standing-grant behaviour carries over |
| Clarify | server->client `clarify` + `request.answer`/`clarify.lock` | **WORKS** | single-question cards |
| Models / commands | `model.options`, `commands.catalog` | **WORKS** | from the DSH catalogs; reasoning levels travel in the projectors' shape |
| Profiles | `profiles.list`, `GET /api/profiles/active` | **PARTIAL** | one Profile, `default`; DSH has presets, not Profiles |
| Files / media | `/api/fs/*`, `/api/files/*` | **404** | not implemented on the Hermes listener yet (the webui `/api/list`+`/api/file` do work on :9120) |
| Tasks, Kanban, Skills, Memory, Usage, Git, Bots, Bot screen | gateway RPC / plugin routes | **404 / -32601** | different backends; DSH has no memory or kanban store at all. The client hides a control after a -32601 |
| Move to Hermes | destination import | **N/A** | the invite is webui-only, so a Hermes-kind server never shows it |

The registers are independent: :9120 keeps its own state (pinned/archived files,
stream journals) and :9121 keeps its event ring and reverse-request queue. Both
read DSH sessions, so a chat started on one is visible on the other after a
reopen.
