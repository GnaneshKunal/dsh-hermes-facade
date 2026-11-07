# 06 — The Hermes-protocol listener (port 9121)

Hermex 2.0 changed its default server kind from **hermes-webui** to a **Hermes
host** (the `hermes-agent` dashboard: REST + JSON-RPC over a WebSocket). webui
servers still work, but are marked *Legacy* and only get fixes.

This document describes the second listener in this plugin that speaks the
Hermes host contract, so the same iOS app can be pointed at DeepSeek Harness as
a native Hermes server. It is additive: port 9120 keeps serving the webui
contract unchanged.

Status: **v1** (2026-11-07). Chat, sessions, approvals, clarifications, models,
commands and export. Not implemented: session import, files, tasks, skills,
memory, kanban, git, insights, bots and the bot screen. Those answer
`-32601` (socket) or 404 (REST), which the client degrades on.

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
| `session.list` | every facade session, id/title |
| `session.most_recent` | no-op acknowledgement |
| `session.create` | creates a DSH session (optional `cwd`, `model`, `provider`) |
| `session.resume` | live state only (`messages_omitted`); the transcript is read over REST |
| `session.title` | rename through the facade |
| `session.branch` | fork through the facade; refused with the host's reason when the session has no completed turn |
| `session.interrupt` | stops the running turn |
| `session.steer` | queues a mid-run message |
| `session.delete` | refused: DSH has no session-delete primitive |
| `session.events.since` | `{latest_seq, epoch, truncated, events}`, contiguous per session |
| `prompt.submit` | starts a turn and returns `{status:"accepted"}` |
| `approval.respond` | `{session_id, request_id, choice: once|session|always|deny}` -> `{resolved}` |
| `request.answer` / `clarify.lock` | answers a clarification |
| `model.options` | providers/models from the DSH catalog |
| `commands.catalog` | slash commands as `pairs` + `canon` |
| `config.set` | acknowledged, not stored (the app's platform note) |
| anything else | `-32601`, which the client records and uses to hide the control |

### Events

Every event is `{"jsonrpc":"2.0","method":"event","params":{type, seq, session_id, payload}}`
with **per-session**, contiguous `seq` starting at 1. Screens admit their own
session only; sequence gaps make the client rebuild from a snapshot, so the ring
(`src/hermes/events.mjs`) keeps 1000 events per session.

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
| `message.complete` | `{status: completed|error|interrupted, text}` |
| `request.cancel` | `{request_id, reason}`; withdraws an unanswered card |

Reverse requests: `approval` (`request_id, command, description, choices`), and
`clarify` (`request_id, question, choices`). The client answers with
`approval.respond`, `request.answer` or `clarify.lock`; a turn that ends
withdraws whatever is still open.

---

## 5. REST surface

| Route | Behaviour |
|---|---|
| `GET /api/sessions` | `profile, order=recent|created, archived=exclude|only|include, limit, offset`; `scheduled=1` answers empty (no cron rows are exposed) |
| `GET /api/sessions/{id}` | one row, 404 when unknown |
| `GET /api/sessions/{id}/messages` | `order=latest|oldest, limit<=500, offset`; rows in the transcript shape (`role, content, timestamp, row_id, tool_calls…`) |
| `PATCH /api/sessions/{id}` | `title`, `pinned`, `archived` through the facade's rename/pin/archive routes |
| `DELETE /api/sessions/{id}` | 400 with the reason (no DSH primitive) |
| `GET /api/sessions/{id}/export` | forwards the facade's JSON transcript download |
| `POST /api/sessions/import` | 400: DSH cannot inject a transcript, so Move to Hermes cannot land here yet |
| `GET /api/profiles/active`, `GET /api/profiles` | the single Profile |
| `GET /api/config` | `{platform_hints:{}}`; the app's note is advisory |
| `GET /api/models`, `GET /api/commands` | the catalogs |
| `GET /api/fs/*`, `/api/files/*` | **not implemented** (404) |

---

## 6. What the phone shows

- **Works:** chat with tokens, thinking, live tool cards, stop, approvals
  (once/session/always/deny), clarifications, session list, open, rename, pin,
  archive, branch, export, model picker, slash commands.
- **Empty/absent:** Tasks, Kanban, Skills, Memory, Usage, Files, Git, Bots, Bot
  screen. Those screens exist on a Hermes host; here they have no backend, and
  unimplemented methods make their controls hide rather than error.
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

`tests/hermes-gateway.test.mjs` drives the whole contract with a real WebSocket
client: status, login, ticket, `gateway.ready`, capabilities, session list,
REST paging, a streamed turn, and an approval answered as a reverse request.

---

## 9. Known gaps and risks

1. **No session import.** Move to Hermes cannot use this host as a destination
   until DSH can accept a transcript. The webui side also refuses
   `/api/profile/switch`, so a move cannot even read its source yet.
2. **No files/git/tasks/skills/memory/kanban/bots.** Each is a separate backend
   (and DSH has no memory or kanban store at all).
3. **One Profile.** Everything is filed under `default`; DSH has agent presets,
   not Profiles.
4. **Version claim.** We report 0.22.5 to clear the gate, but only implement the
   subset above. Unimplemented methods are answered honestly with -32601.
5. **Protocol drift.** The client pins 0.22.5; the contract at HEAD already has
   more methods. Re-read `/tmp/hermex` (the client source) before chasing a new
   build; do not implement from the 261-method OpenRPC document.
6. **Two ports, two servers on the phone.** Kind is fixed per URL, so the same
   host:port cannot be both. Keep the webui entry as the fallback until the
   Hermes one covers what you use.
