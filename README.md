# dsh-hermes-facade

Makes your local **DeepSeek Harness** look like a **hermes-webui** server, so the
free, MIT-licensed iOS app **[Hermex](https://apps.apple.com/us/app/hermex/id6767006319)**
(4.7 stars, App Store) can drive your agent from an iPhone or iPad: sessions,
streaming replies, thinking, tool cards, approvals and clarifications, in native
SwiftUI instead of a web view.

    Hermex (iOS)  --HTTPS/SSE-->  tailscale serve :9443  -->  127.0.0.1:9120
                                                                   |
                                                          dsh-hermes-facade
                                                                   | in-process
                                                          dsh typertGateway

## Why a facade and not a fork

Hermex is a client, not a protocol. Its main app speaks the **hermes-webui**
HTTP+SSE contract; a separate JSON-RPC gateway stack is used only by the Bot
screens. Impersonating the *webui* host is therefore the smallest possible
change: no Xcode, no App Store listing, no fork to maintain, and the App Store
app keeps updating itself.

The facade is a DSH host plugin. It owns one loopback port, translates between
the two wire formats, and never touches dsh's own port-3080 origin (which is
already public through Tailscale Funnel, and whose /api is dsh's own fenced RPC
namespace).

## Install

    dsh plugin --profile web add dsh-hermes-facade

Then add the package to the profile bundle list in
~/.dsh/profiles/web/package.json:

    "dsh": { "profile": { "bundles": [ "... existing ...", "dsh-hermes-facade" ] } }

Restart the host so the plugin loads:

    dsh web

The first boot prints a generated password once:

    hermes-facade: FIRST RUN password = xxxxxxxxxxxx

It is stored hashed at ~/.dsh/hermes-facade/password.json (0600). To reset it,
delete that file and restart.

## Expose it to the phone

Tailnet only, never Funnel:

    tailscale serve --bg --https=9443 http://127.0.0.1:9120     # webui contract
    tailscale serve --bg --https=9444 http://127.0.0.1:9121     # Hermes contract
    tailscale serve status

The second rule is only useful once you add the Hermes-protocol listener below as
a **separate server** on the phone: the app decides a server's kind once, from
`GET /api/status`, so one URL cannot be both.

In Hermex: **Add server**, URL = https://<machine>.<tailnet>.ts.net:9443,
password = the one from first boot.

Remove the exposure with:

    tailscale serve --https=9443 off      # NOT 'serve reset': that also kills Funnel and :8443

## Reaching it from the phone

Three addresses work, all plain HTTP except the last. Hermex permits insecure
HTTP to local-network hosts and to the Tailscale 100.64.0.0/10 range, so no
certificate is needed for the first two.

| Where | URL |
|---|---|
| same Wi-Fi | http://<mac-lan-ip>:9120 |
| Tailscale, plain HTTP (no DNS, no TLS) | http://<mac-tailscale-ip>:9120 |
| Tailscale, HTTPS through serve | https://<machine>.<tailnet>.ts.net:9443 |

Find the addresses with:

    ipconfig getifaddr en0      # Wi-Fi LAN address
    tailscale ip -4             # Tailscale address

The LAN and Tailscale listeners exist because cordis.patch.yml sets
lanHost: auto. Without it the facade is loopback-only and only the serve rule
can reach it. iOS asks for Local Network permission the first time; allow it.

If the HTTPS address hangs, use the plain-HTTP Tailscale IP: it skips MagicDNS
and the TLS handshake entirely.

## From a checkout

    git clone git@github.com:GnaneshKunal/dsh-hermes-facade.git
    cd dsh-hermes-facade
    npm run check && npm test
    dsh plugin --profile web add ~/self/dsh-hermes-facade

## Develop without restarting dsh

dsh web loads plugins at boot, so host-plugin changes need a restart. To iterate
on the wire contract, run the same server standalone against a mock agent:

    node scripts/standalone.mjs --port 9120

That is what npm test uses, and it exercises the whole HTTP/SSE surface with
curl.

## Hermes-protocol listener (Hermex 2.x)

Hermex 2.0 talks to a Hermes host by default (REST + JSON-RPC over a WebSocket)
and marks webui servers as Legacy. This plugin can serve both contracts, on two
ports, from one process:

| Port | Contract | In the app |
|---|---|---|
| 9120 | hermes-webui (HTTP + SSE) | the original server, marked **Legacy**; shows the one-time Move to Hermes invite |
| 9121 | Hermes host (REST + WS JSON-RPC) | a native **Hermes** server; no invite, no Legacy badge |

The gateway listener does not reimplement DSH: it translates to the webui facade
over loopback with an internal token, so sessions, streaming, approvals,
clarifications and export keep one implementation. It covers chat, sessions,
approvals, clarifications, models, commands, export and the session write
fence the list's rename/pin/archive actions read first, the read-only in-chat Files browser and the read-only Git
menu; Tasks, Skills, Memory, Usage, Bots and session import are not implemented and answer `-32601` (the app
hides those controls). Details, endpoint table and gaps:
[docs/06-hermes-gateway.md](docs/06-hermes-gateway.md).

```yaml
config:
  gatewayEnabled: true      # false keeps only the webui listener
  gatewayPort: 9121
  gatewayBindHost: 127.0.0.1
  gatewayLanHost: auto      # also bind Wi-Fi LAN + Tailscale IPv4 (plain HTTP)
```

Both listeners share the password file, the cookie secret and the state directory.
Expose the second one with `tailscale serve --bg --https=9444 http://127.0.0.1:9121`
and add it in Hermex as its own server.

## What is supported

| Surface | State |
|---|---|
| health, auth (password + signed cookie) | full |
| session list, session detail, history | full: newest 200 + 50-message scroll-back pages within the newest 800 |
| chat start / SSE stream / cancel / stream status | full; a failed or cancelled turn ends the stream with `error`/`cancel` instead of `done`; `profile`/`attachments` in the start body are ignored |
| token deltas, thinking, tool cards | full: live and reloaded transcripts carry tool results, error verdicts and durations |
| approvals (once / session / always / deny) | full: a reconnect keeps command/description, expired prompts answer `409 {"stale":true}` and are retracted. `session`/`always` are standing grants keyed by tool name (no command-pattern allowlist) |
| clarifications / agent questions | full: live and re-attached cards carry `question`/`choices_offered` and answer correctly |
| reasoning effort | full: levels come from the model catalog |
| model picker | full: applied through `session/selectModel`; the catalog id/provider is resolved and the reasoning effort carried over |
| live model overlay / providers | full (derived): both read the DSH model catalog; providers is read-only |
| workspaces | partial: list only; add/remove/rename/reorder refused or 404 |
| workspace file browser (`/api/list`, `/api/file`) | full: read-only |
| in-chat Files on the Hermes listener (`/api/fs/*`) | read-only: listing, 512 KiB text preview, binary downloads, fenced to the chat folder |
| in-chat Git on the Hermes listener (`/api/fs/git-root`, `/api/git/*`) | read-only: status, changes, diffs, branches, sha; credential files filtered and refused; writes answer 400 with a reason |
| profiles (DSH has agent presets, not profiles) | partial: one static profile |
| session rename / branch (fork) | full |
| session pin / archive | full: rows report the real flags; `include_archived`/`archived_limit` list archived chats |
| session export | full (bounded): JSON, HTML or markdown download with the filename in `Content-Disposition` |
| session delete / duplicate / compress / clear / undo / retry / truncate / move / update | not implemented (refusals) |
| projects (one per DSH workspace) | partial: read-only list |
| tasks/cron, skills, memory, insights, kanban | stubbed: screens open empty or unavailable |
| bots, push, Move to Hermes | different transport (Hermes gateway); not served |
| Hermes host contract (second listener, :9121) | v1.4: chat/streaming, sessions incl. the write fence the list actions need, approvals, clarifications, models, commands, export, the read-only in-chat Files browser (fenced to the chat folder) and the read-only Git menu; Git writes, tasks/skills/memory/usage/kanban/bots and import answer -32601 or 400 (the per-surface state and plan are docs/05 §2 and docs/07) |

The verified matrix — every surface, the endpoint behind it, what the phone shows, and whether it is
bridgeable here — is [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md). docs/00 is
the frozen design note.

A 404 is not an empty state: Hermex shows "The server endpoint was not found. Check that the URL
points to your configured server.", and only 408/502/503/504 fall back to cached rows. The
approval/clarify family must never 404 — an unanswered pending hangs the run.

## Endpoints

GET /health, GET /api/auth/status, POST /api/auth/login, POST /api/auth/logout,
GET /api/sessions, GET /api/session, POST /api/chat/start, GET /api/chat/stream,
GET /api/chat/cancel, GET /api/chat/stream/status,
GET /api/approval/pending, GET /api/approval/stream, POST /api/approval/respond,
GET /api/clarify/pending, GET /api/clarify/stream, POST /api/clarify/respond,
GET /api/models, GET /api/commands, GET /api/workspaces, GET /api/profiles,
GET /api/reasoning, POST /api/reasoning, POST /api/default-model,
GET /api/list, GET /api/file, GET /api/media, GET /api/file/raw, GET /api/projects,
GET /api/session/export, GET /api/models/live, GET /api/providers.

Hermes listener (:9121): GET /api/status, GET /api/health,
POST /auth/password-login, POST /auth/logout, GET /api/auth/me,
POST /api/auth/ws-ticket, GET /api/auth/providers, GET /api/profiles/active,
GET /api/profiles, GET /api/config, GET /api/models, GET /api/commands,
GET /api/sessions, GET /api/sessions/{id}, GET /api/sessions/{id}/messages,
GET /api/sessions/{id}/mutation-snapshot, GET /api/sessions/{id}/export,
PATCH /api/sessions/{id} (title/pin/archive behind the write fence),
POST /api/sessions/import, GET /api/fs/list, GET /api/fs/read-text,
GET /api/fs/download (read-only, fenced to the chat folder),
GET /api/fs/git-root, GET /api/git/status, GET /api/git/branches,
GET /api/git/review/list, GET /api/git/review/diff, GET /api/git/file-diff,
GET /api/git/review/rev-parse (read-only; the Git panel's routes),
WS /api/ws (JSON-RPC with server-to-client approval/clarify requests).

## Diagnostics

Everything the facade sees is in ~/.dsh/hermes-facade/:

| File | Written | Contents |
|---|---|---|
| `access.log` | every request, when `logRequests: true` | method, path, query, status, ms, user-agent, plus `unknown`/`stub`/`effort`/`error` annotations |
| `unknown-endpoints.log` | **always** | every call to an endpoint the facade does not implement, with its request body |
| `requests.log` | every JSON body, when `logRequests: true` | the literal bodies the iOS app posts |

    tail -f ~/.dsh/hermes-facade/unknown-endpoints.log   # what the app wants that we do not serve
    tail -f ~/.dsh/hermes-facade/access.log              # status and duration of everything

`GET /health` also reports `active_streams` and the transcript `history` page/window sizes.
The app ignores keys it does not know; they make it easy to see which build is live after a hot
reload or restart, and whether a turn is still streaming.

`client_gone: true` on an access-log line means the client hung up before the
answer about a request the facade still finished — that is what a client-side
timeout looks like from the server, and it explains "the app says the server is
unreachable but the server log says 200".

`stub` marks a request answered from a fixed empty/refusal payload, so a screen
that looks broken can be traced to a route that was never implemented.

Both files rotate at 1 MiB and keep one previous generation. Logging never
throws: a full disk or an unwritable directory cannot break a request.

## Security

* binds 127.0.0.1 only; reachable solely through the serve rule you add
* password: scrypt, constant-time compare, 5 attempts / 15 min per address
* cookie: HMAC-signed, HttpOnly, SameSite=Lax, Secure when served over TLS
* the facade acts as an owner peer inside dsh, so remote-access rules do not
  apply; the cookie is the boundary. Do not widen the bind address.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Password rejected everywhere | cookie not sent: check the URL scheme, and that Path=/ is intact |
| "The server endpoint was not found" with /health fine | the app called a route we do not serve: `tail ~/.dsh/hermes-facade/unknown-endpoints.log` names it, with the body |
| A screen works on the second try, fails on the first | cold catalog/workspace read outlived the client's patience: `access.log` shows the `ms` and `client_gone: true`. Reads are bounded to 8 s and the catalog is warmed at boot. |
| Effort chip always says "medium" | fixed: the facade read the wrong projection shape, so it reported the fallback and sent effort changes without a provider/model |
| a run hangs with no approval card | approval endpoint returned 404 instead of pending:null |
| messages roll back instantly | /api/chat/start returned no stream_id |
| empty session list | /api/sessions failed; the app falls back to its cache |

## Docs

* [docs/00-DESIGN.md](docs/00-DESIGN.md): architecture, mapping tables, design snapshot
* [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md): the verified matrix for both transports — Legacy webui (:9120) and Hermes host (:9121)
* [docs/06-hermes-gateway.md](docs/06-hermes-gateway.md): the Hermes-protocol listener (port 9121), its methods, events and gaps
* [docs/07-v2-roadmap.md](docs/07-v2-roadmap.md): parity with the Legacy server first, then the V2-only screens, with effort and acceptance criteria
* docs/01-webui-api-contract.md: hermes-webui server contract
* docs/02-hermex-client-wire.md: the client decoder, read from Swift
* docs/03-dsh-host-integration.md: dsh host API surface
* docs/04-packaging-exposure.md: packaging, ports, Tailscale, test plan

MIT.
