# v0.3.0

A DSH host plugin that makes your DeepSeek Harness drive the
[Hermex](https://apps.apple.com/us/app/hermex/id6767006319) iOS app — on one port as a
**hermes-webui** server (HTTP + SSE), and on a second port as a native **Hermes host**
(REST + JSON-RPC over a WebSocket).

This is the first release with the Hermes-protocol listener, so the whole app works against
your own agent instead of only its Legacy webui path.

## Upgrade

```bash
dsh plugin --profile web add dsh-hermes-facade
```

Keep `dsh-hermes-facade` in the `web` profile's `dsh.profile.bundles` list, restart
`dsh web`, then sign in with the password printed at boot (stored hashed at
`~/.dsh/hermes-facade/password.json`; delete that file to reset it). If the host is already
running with dsh-hmr, saving the plugin files reloads it between turns without a restart.

Expose both listeners, tailnet only, never Funnel:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:9120     # webui contract (Legacy)
tailscale serve --bg --https=9444 http://127.0.0.1:9121     # Hermes contract
```

The app decides a server's kind once, from `GET /api/status`, so one URL cannot be both: add
each as its own server in Hermex. Keep the `:9443` entry as the fallback — anything the Hermes
listener does not implement answers `-32601`, and the app hides that control rather than
showing a broken screen.

The second listener is on by default. Its config:

```yaml
config:
  gatewayEnabled: true      # false keeps only the webui listener
  gatewayPort: 9121
  gatewayBindHost: 127.0.0.1
  gatewayLanHost: auto      # also bind Wi-Fi LAN + Tailscale IPv4 (plain HTTP)
```

## What's new since v0.2.0

### The Hermes-protocol listener (`:9121`)

- **Hermex 2.x talks to it natively.** Hermex 2.0 files webui servers as Legacy and offers a
  one-time Move to Hermes invite; `:9121` answers the Hermes host contract instead: boot
  (`/api/status` with a stable `install_id`), cookie login against the same scrypt record,
  a 30-second single-use WebSocket ticket, `gateway.ready` and `client.capabilities`.
- **It is a translation layer, not a second integration.** Every method calls the webui facade
  over loopback with a 0600 internal token, so sessions, streaming, approvals, clarifications
  and export keep exactly one implementation. A dependency-free RFC 6455 server carries the
  socket (the ticket rides in `Sec-WebSocket-Protocol`, never in a query string).
- **Chat on the socket:** `prompt.submit`, `session.create|resume|list|title|branch|interrupt|
  steer`, `session.events.since`, `model.options`, `commands.catalog`, `config.set`.
- **Approvals and clarifications as server-to-client JSON-RPC requests** — the 2.0 contract's
  own human-in-the-loop shape, with no polling and no side streams. A reattaching phone gets
  its open request back through `open_requests` on `session.resume` / `session.events.since`.

### Chat

- **Attachments.** Images become native image parts (keeping the app's `[The user attached an
  image: …]` reference) and documents are staged as `@file:<path>` under a shared uploads
  root; the image renders in the transcript and the model gets the bytes.
- **Tool-heavy turns stop looking empty.** The first transcript page anchors on a tool-only
  newest page, a cold open appends tool rows that exist only in the event ring, and persisted
  tool results are re-materialized into the cards a reopened chat expects.
- **Live telemetry.** A turn carries `session.usage` and `usage` on `message.complete`
  (context used/max, input and output tokens).
- **Reconnect hardening.** The per-session event ring is 5,000 events and an in-flight turn
  pins its first event as a replay floor, so a phone returning to a long turn replays
  contiguously instead of falling back to a transcript without the tool rows.
- **Live Working / Needs-you.** `session.active_list` plus `sessions.changed`: `starting`
  between submit and the turn going live, Working while it runs, Needs-you while an approval
  or clarification is open; idle rows are omitted.
- **Transcript images and Quick Look** resolve through `GET /api/media` and
  `GET /api/file/raw` on `:9121` too, fenced to the chat folder.

### The file-aware screens

- **Files** — read-only in-chat browser: listing, 512 KiB text preview with `truncated`, and
  binary downloads, all behind the shared realpath fence (chat folders only; state and secret
  directories refused).
- **Git** — status, changes, diffs, branches and sha; then the writes: stage/unstage/revert,
  commit, push and branch switch. Every write refuses with 409 while a turn runs, credential
  files are filtered, and push honours `branch.<name>.pushRemote`, `remote.pushDefault` and an
  explicit `branch:upstream` refspec.
- **Memory** — read/write of the global `$DSH_HOME/AGENTS.md` as MEMORY.md, saved atomically
  with a 2 MiB cap; `overwrite:false` against an existing file answers 409 and leaves the text
  intact.
- **Skills** — read-only catalogue; a package-provided skill body now opens instead of 404ing.
- **Usage / Insights** — tokens always, cost from `dsh-cost-meter` where it is installed.
- **Tasks / cron** — list, create, edit, pause, resume, trigger and delete, with run history;
  writes go to DSH schedules and delivery is local only.
- **Plugins** — the Settings → Server → Plugins screen lists DSH's plugin packages (one row per
  bundle, not per Loader entry), toggles with `pluginManager/setBundleEnabled`, and updates a
  registry package to the newest version that is a valid bundle and compatible with this DSH.
- **Search** — `GET /api/sessions/search` backs the search screen on both listeners: id, title
  and message-content matches with an excerpt.
- **Goal** — `/goal` in the slash catalogue and through the host command, with a goal snapshot
  and live control updates.
- **Dictation** — `POST /api/audio/transcribe` over DSH's real `speech/transcribe`; m4a/mp4/aac
  is converted to canonical 16 kHz mono WAV (`afconvert` on macOS, `ffmpeg` elsewhere) and a
  host with no converter answers 400 with a detail instead of a fabricated transcript.

### Correctness and internals

- **One path fence** (`src/hermes/fence.mjs`) behind Files, Git, media and memory: realpath
  resolution, session-scoped roots, and the host's secret-cache basenames denied.
- **A session write fence.** `GET /api/sessions/{id}/mutation-snapshot` exists before any
  rename, pin or archive, so a write never lands on a stale view.
- **Reverse requests survive** a reconnect, a timeout and a stop; a turn that ends withdraws
  whatever is still open, and `session.interrupt` withdraws with reason `interrupted` instead
  of parking the pump.
- **The ticket is accepted only from the subprotocol offer**, and the Hermes listener never
  inherits a widened `bindHost` — widening stays explicit.
- Finished stream journals are pruned past the replay window and capped at 64; reads are bounded
  (8 s) with cached baselines; the plugin's disposer awaits its port release so a reload cannot
  hit `EADDRINUSE`.
- `docs/08-upstream-gaps.md` now records every surface the phone expects and DSH cannot honestly
  provide, with evidence, the current refusal and the smallest upstream change.

## Tests

344 tests across 15 files, `npm run check` clean. The suite covers the mapper, HTTP/SSE
integration, the real host adapter, the mock host, the plugin entry, the WebSocket codec, the
end-to-end gateway contract (boot, login, ticket, streamed turn, reverse-request approval), the
plugin wire, Git writes, cron, audio and the exporter.

## Known limits

See [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md) and
[docs/06-hermes-gateway.md](docs/06-hermes-gateway.md) §9. The
important ones: no session import, kanban or bots (those answer `-32601`); workspace and
session-lifecycle actions still refuse; one static Profile (DSH has agent presets); a started
session's cwd cannot change; history is bounded at 800 messages; approval grants are keyed by
tool name; and the `:9120` file routes remain unfenced exactly as they always were — only the
`:9121` surfaces use the shared fence. Keep the Legacy entry in Hermex until the Hermes
listener covers what you use.
