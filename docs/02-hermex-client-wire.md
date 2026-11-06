# 02 — Hermex 2.0 client wire contract (as implemented in Swift)

Everything below is read from the client at `/tmp/hermex` (read-only). Line numbers are
`file:line` in that tree. Where a field is optional in Swift it is optional on the wire — the
app never *requires* a key it decodes as `Optional`.

## 0. The app speaks TWO protocols — pick one, do not mix

| Transport | Swift stack | Used by | Sign-in probe | Chat |
|---|---|---|---|---|
| **webui** (classic Hermes dashboard HTTP API) | `APIClient` + `Endpoint` enum | Chat, Session list, Settings, everything main-app | `GET /health`, `GET /api/auth/status` | `POST /api/chat/start` + SSE `GET /api/chat/stream` |
| **direct Hermes host** ("Bot" screens, #899/#1046) | `HermesConnection`+`HermesREST`+`HermesCall`+`HermesGateway` | Bot screens, Move-to-Hermes, push | `GET /api/status` (**only place a version exists**) | JSON-RPC `prompt.submit` over WebSocket |

Two facts drive every decision below:

1. `HermexCompatibility` (`HermesCompatibility.swift:6-24`) is consulted **only** by
   `HermesConnection.beginSignIn` (`HermesConnection.swift:210-217`). The webui path never asks for
   a version: `AuthManager` (`AuthManager.swift:200-207`) does health → auth-status → login and
   stops. **Impersonating a webui host makes 0.21.3/0.22.5 irrelevant.**
2. `/api/status` is the probe the "Add Hermes server" form uses to tell a Hermes dashboard from a
   webui (`HermesConnection.swift:368-386`). Answering it `auth_required:true` +
   `auth_providers:["basic"]` clears the version gate and then dies at the gateway — which we do
   not implement. **Be a webui host; omit `/api/status` entirely.**

### 0.1 JSON coding conventions (both stacks, webui side)

```swift
// Networking/APIClient.swift:46-52
decoder.keyDecodingStrategy = .convertFromSnakeCase   // session_id -> sessionId
encoder.keyEncodingStrategy = .convertToSnakeCase     // sessionId -> session_id
```

Consequence: **all request bodies and responses are snake_case**, and the `CodingKeys` you see in
the models are camelCase (the post-transform names). A few models additionally hand-decode a
snake spelling (`display_kind`, `pending_count`, `approval_id`…) because SSE payloads are decoded
with a *plain* `JSONDecoder()` that does **not** convert case (`SSEClient.swift:238-241`).

## 1. Sign-in (webui)

Order, exactly (`Auth/AuthManager.swift:200-207, 228-262`):

```
GET  /health              -> {"status":"ok"}
GET  /api/auth/status     -> {"auth_enabled":…, "logged_in":…, …}
POST /api/auth/login      -> {"ok":true}   + Set-Cookie      (only if auth_enabled && !logged_in)
```

```swift
// Models/ServerInfo.swift:3-40
struct HealthResponse { let status: String?; let sessions: Int?; let activeStreams: Int?; let uptimeSeconds: Double? }
struct AuthStatusResponse {
    let authEnabled: Bool?; let loggedIn: Bool?
    let passwordAuthEnabled: Bool?; let oidcEnabled: Bool?; let trustedAuthEnabled: Bool?
    var isAlreadySignedIn: Bool { loggedIn == true }
}
struct LoginResponse { let ok: Bool?; let message: String?; let error: String? }
```

* `health.status` must literally be `"ok"`; anything else throws
  `APIError.http(200, "Unexpected health status.")` (`AuthManager.swift:202-204`).
* `/api/auth/status` gates the password field. `unsupportedSignInMessage`
  (`AuthManager.swift:46-55`) refuses sign-in only when `auth_enabled==true && logged_in!=true`
  **and** `password_auth_enabled == false`. Leave `password_auth_enabled` **absent or true** —
  absent means "unknown, try password".
* Login request body is `{"password": "<pw>"}` only — there is **no username field**
  (`APIClient.swift:378-380`). Success is `ok == true`; a 401 becomes
  `APIError.unauthorized` → "The password was rejected." (`APIClient.swift:263-265`).
* **Cookies**: no token is ever read by the app. `APIClient.sharedSession` uses
  `httpCookieStorage = .shared, acceptPolicy = .always, shouldSetCookies = true`
  (`APIClient.swift:359-365`) and `SSEClient` copies the same into its own config
  (`SSEClient.swift:61-64`). So any `Set-Cookie` on the login 200 (or even on every response)
  is picked up by URLSession and replayed on `/api/*` **and on the SSE stream**. A session
  cookie with no `Expires` works.
* Every other `/api/*` call that answers 401 throws `.unauthorized` (`APIClient.swift:263-274`) —
  the app treats it as "password rejected", there is no silent re-auth on the webui path.
* `POST /api/auth/logout` is called best-effort on sign-out (`AuthManager.swift:701`, 5 s budget).

### 1.1 The Hermes-host variant (only if you build the gateway)

```
GET  /api/status          -> {"version":"0.22.5", "install_id":"…", "auth_required":true,
                              "auth_providers":["basic"], "auth_flows":[]}
POST /api/auth/password-login  {provider:"basic", username, password}   (cookie)
GET  /api/auth/me         -> {"provider":"basic","user_id":…}
```

* `version` feeds `HermesCompatibility.isSupported` (`:17-20`): only the leading
  `MAJOR.MINOR.PATCH` is compared, and **a missing or unparsable version counts as supported**
  ("so its absence means a proxy or a fork", `:13-15`). Reported < `0.21.3` → `BotFailure.outdated`,
  password never sent (`HermesConnection.swift:215`).
* `install_id` is checked before any password (`:216`, `BotConnection.swift:34-45`); mismatch →
  `.differentHost`; omission is tolerated (trust on first use).
* `auth_required:false` = "open dashboard": the app scrapes a token out of the HTML page
  (`:220-235`). Do not.
* Method selection: `BotProtocol.swift:484-494`.

## 2. Launch / boot

After `state = .loggedIn` (`AuthManager.swift:257-262`) nothing else is probed. The root view
(`ContentView.swift:110-130`) renders the Session list, which issues **one** request:

```
GET /api/sessions            (SessionListView.swift:1301-1307 -> SessionListViewModel.swift:441-517)
```

On failure the list falls back to the on-disk cache and shows a banner
(`SessionListViewModel.swift:489-517`); with no cache the screen is **empty**, not fatal.

| Endpoint | When | 404 consequence |
|---|---|---|
| `GET /health`, `GET /api/auth/status`, `POST /api/auth/login` | add-server only | **Blocker**: "The server endpoint was not found." |
| `GET /api/sessions` | home | empty list + banner |
| `GET /api/session` | open a chat | error banner, cached transcript if any |
| `POST /api/chat/start` | send | bubble rolled back, error shown (`ChatViewModel.swift:3775-3810`) |
| `GET /api/chat/stream` | after start | see §4 — 404 `{"detail":"stream not found"}` is *graceful* |
| `/api/approval/*`, `/api/clarify/*` | run active | **silent** — the agent hangs (see §5) |
| `/api/models`, `/api/commands`, `/api/workspaces`, `/api/reasoning`, `/api/profiles` | composer | banner, degraded picker; sending still works |
| `GET /api/chat/stream/status` | reconnect | retried 1/2/4 s, then gives up |
| everything else | per-screen | that screen only |

The composer loads, in this order (`ChatComposerConfigLoader.swift:73-99`): `/api/profiles`
(fatal-ish) → then `/api/models` + `/api/reasoning` + `/api/workspaces` (any failure sets
`configurationError` → banner, `ChatComposerView.swift:1563`) and `/api/commands` in parallel
(swallowed with `try?`, `ChatComposerConfigLoader.swift:175-177`).

## 3. Sessions

### 3.1 List — `GET /api/sessions`

Query (`Endpoints.swift:411-437`): `include_archived=1` (opt-in) and `archived_limit=N` (only with
the former). Nothing else. The Hermes-host list (`HermesREST.swift:521-536`) is a different shape
and is not used by the main app.

```swift
// Models/Session.swift:3-38
struct SessionsResponse: Decodable {
    let sessions: [SessionSummary]?
    let cliCount: Int?          // cli_count
    let archivedCount: Int?     // archived_count
    let serverTime: Double?     // server_time   (epoch SECONDS, Double)
    let serverTz: String?       // server_tz
}
```

Rows decode **independently** (`SessionSummary.decodingRowsIndependently`,
`Session.swift:412-423`): a bad row is skipped, not fatal.

```swift
// Models/Session.swift:207-272 (all Optional; ids are Strings)
struct SessionSummary {
  let sessionId, title, workspace, model, modelProvider: String?
  let messageCount: Int?
  let createdAt, updatedAt, lastMessageAt: Double?      // epoch seconds, Double
  let pinned, archived: Bool?
  let projectId, profile: String?
  let inputTokens, outputTokens: Int?; let estimatedCost: Double?
  let activeStreamId: String?; let isStreaming: Bool?     // drives "run in progress" UI
  let isCliSession: Bool?; let userMessageCount: Int?
  let hasPendingUserMessage: Bool?; let pendingStartedAt: Double?
  let worktreePath, sourceTag, rawSource, sessionSource, sourceLabel: String?
  let parentSessionId, relationshipType: String?; let readOnly, isReadOnly: Bool?
  let matchType, matchPreview: String?
  let hermes: Hermes?                                     // never decoded from webui JSON
}
```

Timestamps are **Unix seconds as JSON numbers** (`Double`), never strings, never ISO-8601.
`sessionId` is what every other call keys on; if it is missing the app fabricates an id from
title+timestamp (`Session.swift:223-232`) and the chat cannot load.

### 3.2 Detail — `GET /api/session`

```
?session_id=<id>&messages=1&msg_limit=50[&msg_before=<offset>][&expand_renderable=1]
```
(`Endpoints.swift:438-459`, `APIClient+Sessions.swift:29-46`; `messagePageLimit = 50`,
`ChatViewModel.swift:278`.)

Response: `{"session": {...}}` (`SessionResponse`, `Session.swift:58-60`).

```swift
// Models/Session.swift:744-793  (SessionDetail — everything Optional)
sessionId, title, workspace, model, modelProvider, messageCount,
createdAt, updatedAt, lastMessageAt, pinned, archived, projectId, profile,
inputTokens, outputTokens, estimatedCost, activeStreamId,
pendingUserMessage, pendingAttachments: [JSONValue]?, pendingStartedAt,
worktreePath, contextLength, thresholdTokens, lastPromptTokens,
isCliSession, sourceTag, rawSource, sessionSource, sourceLabel,
parentSessionId, relationshipType, readOnly, isReadOnly,
messages: [ChatMessage]?, toolCalls: [PersistedToolCall]?,
messagesTruncated, messagesOffset,                    // _messages_truncated / _messages_offset
compressionAnchorVisibleIdx, compressionAnchorMessageKey, compressionAnchorSummary
```

`messagesOffset` ( `_messages_offset` ) is the **backwards paging cursor**: the app passes it back
as `msg_before` (`ChatViewModel.swift:2378-2392`), and stops when `messagesOffset == 0`.

### 3.3 Message shape

```swift
// Models/ChatMessage.swift:3-120
struct ChatMessage {
  let role, content: String?          // role: "user" | "assistant" | "system" | "tool"
  let timestamp: Double?              // accepts _ts or timestamp
  let messageId, name: String?
  let toolCallId, toolUseId: String?
  let toolCalls: [JSONValue]?         // opaque; each entry is OpenAI-style {id,type,function{name,arguments}}
  let contentParts: [JSONValue]?      // opaque
  let reasoning: String?              // thinking block, rendered as a collapsed card
  let attachments: [MessageAttachment]?
  let displayKind: String?            // "steer" is special-cased
  let displayMetadata: [String: JSONValue]?
  let turnTps, turnDuration: Double?  // _turnTps / _turnDuration
}
```

Tool-call rendering lives client-side off `toolCalls`/`contentParts` — both opaque `JSONValue`
arrays, so the inner shape is ours as long as it is valid JSON. Thinking is a plain `reasoning`
string on the assistant message; there is no separate thinking object.

## 4. Chat: start + SSE stream

### 4.1 Start

```http
POST /api/chat/start
{"session_id":"…","message":"…","workspace":"…","model":"…","model_provider":"…",
 "profile":"…","explicit_model_pick":true,"attachments":[{…}]}
```
(`APIClient+Chat.swift:5-23, 169-178`.) Response (`ServerCatalog.swift:3-33`):

```swift
struct ChatStartResponse { let streamId: String?; let sessionId: String?
                           let pendingStartedAt: Double?; let error: String? }
```

**`stream_id` is mandatory** — without it the bubble is rolled back and `response.error` (or
"The server did not return a stream ID.") is shown (`ChatViewModel.swift:3789-3805`).

### 4.2 Stream

```http
GET /api/chat/stream?stream_id=<id>            Accept: text/event-stream
GET /api/chat/stream?stream_id=<id>&replay=1&after_seq=<n>     (reconnect only)
```
(`Endpoints.swift:462-470`.) No `Last-Event-ID` header is sent; the cursor is the query param.

**Events the decoder handles** (`Networking/SSEClient.swift:232-360`), in the order the server
should emit them:

| SSE `event:` | `data:` JSON | Effect |
|---|---|---|
| `token` | `{"text":"…"}` | append to the streaming assistant bubble |
| `interim_assistant` | `{"text":"…","already_streamed":bool}` | preamble text before tool calls |
| `reasoning` | `{"text":"…"}` | append to the thinking block |
| `tool` | `{"event_type","name","preview","args":{},"duration","is_error", "tid"\|"id"\|"tool_call_id"\|"tool_use_id"\|"call_id"}` | tool card opened |
| `tool_complete` | same shape | tool card closed (`args`/`duration`/`is_error`) |
| `title` | `{"session_id","title"}` | live rename of the chat title |
| `metering` | `{"tps","tps_available","estimated","session_id"}` | tok/s chip; ignored if `session_id` ≠ open session |
| `done` | `{"usage":{…},"session":{…SessionDetail}}` | **completion** |
| `initial` | pending approval *or* clarification payload | sent first if a prompt is already pending |
| `approval` | `{"pending":{…}}` | approval card |
| `clarify` | `{"pending":{…}}` | clarification card |
| `pending_steer_leftover` | `{"text":"…"}` | queued mid-run user text |
| `stream_end` | (no data) | clean end |
| `cancel` | (no data) | user cancelled |
| `error` / `apperror` | `{"error"\|"message":"…"}` | fatal for the run |
| *(anything else)* | — | ignored, logged at debug |
| `:` comment | — | keepalive → `.heartbeat` (`SSEClient.swift:406-410`) |

Terminal ordering that works with the client: emit all content → `done` → `stream_end`. The
coordinator fences late `token`/`reasoning` after `done` (`ChatStreamCoordinator.swift:803-840`),
and a duplicate `done` is dropped. `cancel` and `error` are accepted before or instead of `done`.

Behavioural details we must honour:

* **`done` must be valid JSON with decodable `usage`/`session` if present.** A malformed `done`
  becomes `.transportError("The stream returned a malformed completion event.")`
  (`SSEClient.swift:274-278`) → the app tears down and retries, not completes. If
  `done.session.messages` is non-empty the app skips the follow-up `GET /api/session`
  refresh (`ChatViewModel.swift:8269`); otherwise it re-fetches. Emitting `session` +
  `messages` is one request cheaper.
* **Heartbeat**: `:` comment lines every ~5 s; >18 s of silence is treated as a dead transport
  (`ChatStreamCoordinator.swift:12-25`).
* **Event ids**: any `id:` line is captured; on reconnect the client parses everything after the
  **last `:`** as an integer sequence and sends it as `after_seq`
  (`ChatStreamCoordinator.swift:781-800`). So `id: run42:17` or `id: 17` both work.
* **Reconnect**: transport error → `GET /api/chat/stream/status?stream_id=` →
  `{"active":bool,"stream_id","replay_available":bool,"journal":{"terminal","terminal_state"}}`
  (`ServerCatalog.swift:43-65`). `active:true`+`replay_available:true` → re-attach with
  `replay=1&after_seq=<cursor>`; `active:false` → reload transcript and finalise
  (`ChatStreamCoordinator.swift:486-566`). Backoff 1/2/4 s, 4 probes (lines 33-38).
* **404 semantics**: `GET /api/chat/stream/status` answering 404 with a body whose
  `error|message|detail` contains "stream not found" (case-insensitive) is read as *run finished*,
  not as an error (`APIError.swift:121-124`). Same string is the graceful way to end a stale stream.
* **Cancel**: `GET /api/chat/cancel?stream_id=<id>` (**GET**, `APIClient+Chat.swift:39-41`),
  response `{"ok":bool,"cancelled":bool,"stream_id","error"}`.

## 5. Approvals & clarify

They are **per-session**, addressed by `session_id` in the query — that is the entire
correlation mechanism. `PendingApproval` carries no session id; the coordinator files the prompt
under the session whose stream/URL produced it (`ChatPendingActionCoordinator.swift:66-67,
255-270`) and renders it only when it equals the open chat's id.

```
GET  /api/approval/pending?session_id=…    -> {"pending":{…}|null,"pending_count":n}
GET  /api/approval/stream?session_id=…     -> SSE, events: initial|approval (others ignored)
POST /api/approval/respond                 -> {"session_id","choice","approval_id"}
                                              choice ∈ "once"|"session"|"always"|"deny"
```

```swift
// Models/Approval.swift:10-49, 50-105
struct ApprovalPendingResponse { let pending: PendingApproval?; let pendingCount: Int? }  // pending_count
struct PendingApproval { let approvalId: String?   // also accepts approval_id and id
                         let command, description, patternKey: String?  // pattern_key
                         let patternKeys: [String]? }                   // pattern_keys
// respond: Models/Approval.swift:327-355
struct ApprovalRespondResponse { let ok: Bool?; let choice: ApprovalChoice?
                                 let staleCleared, relayed, stale: Bool? }
```

* The pending body may be **wrapped** (`{"pending":{…}}`) or **bare**; both decode
  (`Approval.swift:31-45`). `initial` disambiguates by sniffing for `question`/`choices_offered`
  (`Clarification.swift:38-47`) — **give a clarification payload one of those keys** or it renders
  as an approval card.
* Respond is checked strictly: `ok == true` **or** `stale_cleared == true`, else the card stays and
  the user is told "The server did not accept that response."
  (`ChatPendingActionCoordinator.swift:148-154`). `ok:false` is HTTP **200**, not an error.
* A 409 with `{"stale": true}` dismisses the card as expired (`APIError.swift:136-139`).
* Transport failure on the stream falls back to polling `pending` every **1.5 s**
  (`ChatViewModel.swift:196-200`, `ChatPendingActionCoordinator.swift:384-410`). **404s there are
  swallowed** (line 428-433): a missing approval endpoint silently hangs the run — the most
  user-hostile failure mode in the contract.

Clarify is the mirror image: `/api/clarify/{pending,stream,respond}`, body
`{"session_id","response","clarify_id"}`, and

```swift
// Models/Clarification.swift:49-117
struct PendingClarification { let clarifyId, question: String?; let choicesOffered: [String]?
                              let sessionId, kind: String?; let requestedAt: Double?
                              let timeoutSeconds: Int?; let expiresAt: Double? }
```

## 6. Models / commands / files (minimum shapes)

| Endpoint | Minimum body |
|---|---|
| `GET /api/models` | `{"models":[{"id","label"}],"groups":[…],"default_model":"…","active_provider":"…"}` — `models`/`groups` are opaque `JSONValue` (`ServerCatalog.swift:116-121`); a flat `models` array of `{id,label}` is enough |
| `GET /api/commands` | `{"commands":[{"name","description","category","aliases","args_hint","subcommands","cli_only","gateway_only"}]}` (`ServerCatalog.swift:123-148`) — all optional |
| `GET /api/workspaces` | `{"workspaces":[{"path","name"}],"last":"/path"}` — a bare string entry is also accepted (`Workspace.swift:3-28`) |
| `GET /api/profiles` | `{"profiles":[{"name",…}],"active":"default","single_profile_mode":true}` (`ServerCatalog.swift:590-600`) |
| `GET /api/reasoning` | `{"effective_effort","supported_efforts":[…],"supports_reasoning_effort":bool}` |
| `GET /api/file?session_id=&path=` | `{"content","path","name","language","size","lines"}` (`Workspace.swift:147-165`) |
| `GET /api/list?session_id=&path=` | directory entries; `/api/file/raw` and `/api/media` for bytes |
| `GET /api/session/yolo?session_id=` | `{"ok":bool,"yolo_enabled":bool}` (`Approval.swift:357-370`) |

All of this is optional for a usable chat.

## 7. Minimum viable host

**Tier 1 — login → list → send → stream → approve (in this order):**

1. `GET /health` → `{"status":"ok"}`
2. `GET /api/auth/status` → `{"auth_enabled":true,"logged_in":false,"password_auth_enabled":true}`
3. `POST /api/auth/login` → `{"ok":true}` + `Set-Cookie`
4. `GET /api/sessions` → `{"sessions":[…],"server_time":…}`
5. `GET /api/session?session_id=&messages=1&msg_limit=50` → `{"session":{…,"messages":[…]}}`
6. `POST /api/chat/start` → `{"stream_id":"s1","session_id":"…","pending_started_at":…}`
7. `GET /api/chat/stream?stream_id=s1` → `token`* → `tool`/`tool_complete`* → `done` → `stream_end`
8. `GET /api/approval/pending?session_id=` → `{"pending":null}` (must exist even if unused)
9. `GET /api/approval/stream?session_id=` → SSE keepalive; `event: approval` when needed
10. `POST /api/approval/respond` → `{"ok":true}`

Optional but strongly advised in tier 1: `GET /api/chat/stream/status` (reconnect),
`GET /api/chat/cancel` (Stop button — without it the Stop button 404s),
`GET /api/clarify/{pending,stream}` (so a clarification is not mis-rendered).

**Tier 2 (polish; each independently 404-tolerant):** `/api/models`, `/api/commands`,
`/api/workspaces`, `/api/profiles`, `/api/reasoning`, `/api/projects`, `/api/session/new` and
`/api/session/{rename,delete,pin,archive,yolo}`, `/api/file`, `/api/list`, `/api/media`,
`/api/settings`, `/api/insights`, `/api/crons/*`, `/api/skills`, `/api/memory`.

## 8. Fragility list — do not get these wrong

1. **`/health` must be 200 with `"status":"ok"`** — else no server can be added at all.
2. **Never send `password_auth_enabled:false`** in `/api/auth/status`; omit the key.
3. **Login must set a cookie** (the app never reads a body token) and answer `ok:true`.
4. **`stream_id` must be present in `/api/chat/start`** or the message is silently rolled back.
5. **`done` must be well-formed JSON** (`usage`/`session` optional but decodable). A bad `done`
   sends the client into reconnect, not completion.
6. **`cancel` is a GET** (`/api/chat/cancel?stream_id=`), not a POST.
7. **404 on the approval routes is silent** — the run hangs with no card. Always answer
   `{"pending":null}` rather than 404.
8. **`ok:false` on approval/clarify respond is HTTP 200 and keeps the card up.** Only
   `ok:true`/`stale_cleared:true` clears it; expiry is `409 {"stale":true}`.
9. **A clarification payload needs `question` or `choices_offered`**, else `initial` decodes it as
   an approval.
10. **Timestamps are epoch seconds as JSON numbers.** ISO strings decode to `nil` and every
    "last active" sort/grouping collapses.
11. **`session_id` must be a non-empty string on every row** — it is the key for the whole app.
    A row without it cannot be opened.
12. **Snake_case everywhere**, except SSE payloads which are decoded without case conversion
    (the models hand-decode both spellings — match `session_id`, `pending_count`, `approval_id`,
    `pattern_key`, `choices_offered`, `stale_cleared`, `replay_available`, `stream_id`).
13. **Case-insensitive substring "stream not found"** in a 404 body is how the client distinguishes
    "run over" from "transport broken" (`APIError.swift:121-124`). Keep that exact phrase available.
14. **Do not answer `/api/status`** with `auth_required` unless you implement the gateway RPC —
    the app will switch to the Hermes-host transport and require `session.active_list`,
    `prompt.submit`, `session.events_since` over WebSocket (`HermesCall.swift:93-200`).
15. **Enums are exact strings**: approval `choice` (`once|session|always|deny`,
    `Approval.swift:3-8`) and event names. Unknown events are ignored; an unknown `choice` fails
    decoding (`try? decodeIfPresent` → `nil` → card stays up).
16. **The 401 mapping is global**: a stray 401 anywhere on `/api/*` reads as "The password was
    rejected", even mid-chat. Use `403` for logical refusals.
