# 07 — V2 roadmap: parity first, then the full Hermes host

Status: **2026-11-07** · companion to [05-compatibility-matrix.md](05-compatibility-matrix.md), whose §2 is the state
this plan moves. Client: Hermex 2.0.1 (`7547796`); upstream host: `/tmp/hermes-agent` @ `90d6b98`; DSH
`0.2.2-rc.1`.

The goal has two parts, in this order:

1. **Parity.** Anything the **Legacy** server (`:9120`, hermes-webui) already does for the phone must also work on
   the **Hermes host** (`:9121`). That is the "similar to how V1 was" bar.
2. **Full V2.** Then add the surfaces only a Hermes host unlocks (Tasks, Skills, Memory, Usage, Git, Bots, Files),
   but only where DSH has a real primitive to back them. A screen that half-renders is worse than one that is
   cleanly hidden.

Two constraints shape everything below:

- **The app hides what the host cannot do.** `-32601` for a method, 404 for a route, and the matching control
  disappears. That makes honest refusal the cheapest correct behaviour — and makes a *partial* screen the most
  user-hostile outcome.
- **Only DSH primitives count.** `session/*`, `workspaceFiles/*`, `session/search`, `schedule/*`, `skills/list`,
  `agentPresets/*`, `pluginManager/*`, `speech/transcribe`, the `contextUsage`/`tokenUsage`/`goal` projections and
  the approval/question waterfalls are real. Memory, Kanban, git, usage rollups, TTS and transcript import are not.

---

## 1. Where V2 stands

Verified by the matrix and by the live `access.log`: the chat path is solid — sessions, streaming tokens, thinking,
tool cards, stop/steer, approvals and clarifications, model and effort, reconnect/replay, export and REST paging
all work on `:9121`. The phone has been driving it every day.

The gaps split cleanly:

| Kind of gap | Examples | What it costs the phone |
|---|---|---|
| Chat telemetry | `usage` on turn events, `terminal_backend`, canonical turn status | a frozen context ring; Files/Git tabs never appear |
| Disabled feature that exists on the other transport | YOLO honesty | V2 is worse than V1 for that one feature |
| Screens with no backend yet | Tasks, Skills, Memory, Usage, Git, Bots, search, attachments | the screen errors (the sidebar toggles are local, not probes) |
| Silent misbehaviour | edit/regenerate appends, fast/yolo echo | the phone believes something happened that did not |

---

## 2. Phase 1 — parity with the Legacy server

The Legacy surface is [05 §1](05-compatibility-matrix.md). Most of it is either already done on V2 or was a stub on
V1 too, so real parity work is short:

| # | Surface | V1 | V2 today | Work | Effort |
|---|---|---|---|---|---|
| P1 | Rename / pin / archive from the list | works | **broken** (no mutation snapshot → the fence probe throws) | **done in this change**: `GET /api/sessions/{id}/mutation-snapshot` + revision check | S |
| P2 | Files browser (list, text, image/media download) | works, read-only | **done in this change**: `terminal_backend:"local"` + `/api/fs/{list,read-text,download}` behind the shared path fence | Git reuses the fence next | M |
| P3 | YOLO / approval bypass | POST reports false | **done in this change**: refused with a key-level error, so the switch reverts | wire the approval policy later, or leave it refused | S |
| P4 | Session list rows | rich rows | the v1 row shape is mapped on both REST and WS; still no `preview` | map `preview` through | S |
| P5 | Chat transcript fidelity | tool results + verdicts | same over REST; the status is canonical now, but `message.complete` carries no usage/receipt | add `usage` and `persisted_turn` when the row ids are known | S |
| P6 | `@path` / file completion | n/a | `complete.path` -32601 | map to directory listing | S |

**Chat attachments are not parity work** — V1 refused them too. They are a Phase-2 item because the V2 contract
makes them first-class.

---

## 3. Phase 2 — the Hermes-only screens, ranked

Effort: **S** = one route/method over an existing facade primitive; **M** = new shaping or a small mapping layer;
**L** = needs a new DSH primitive, a facade store, or a behaviour change.

| # | Surface | Why the phone cares | Calls to add | DSH backing | Effort | Verdict |
|---|---|---|---|---|---|---|
| 1 | Session search | the list's search field 404s today | `GET /api/sessions/search` (REST), `session/search` | `session/search` → `{items:[{sessionId,snippet}],hasMore}` | S | **next** |
| 2 | Live Working / Needs-you | the live dots are absent | `session.active_list`, `sessions.changed` | the gateway's own runner + session rows | S | **next** |
| 3 | Chat telemetry | context ring and turn metadata | `usage`/`partial`/`persisted_turn` on `message.complete`, `usage` on `session.info` | `contextUsage`/`tokenUsage` projections | S | **next** |
| 4 | Files | read code and artifacts from the phone | **done in this change** (read-only) | the facade's file routes behind the shared fence | M | done |
| 5 | Tasks / cron | scheduled jobs and history | `/api/cron/jobs`, `/runs`, pause/resume/trigger/delete, delivery-targets, `sources=cron` agenda | `schedule/*` (near-exact) | M | next |
| 6 | Memory | edit what the agent remembers | `/api/memory`, `files/read`, `files/upload`, `profiles/{n}/soul`, `profiles.list[].path` | `$DSH_HOME/AGENTS.md` + the project AGENTS.md chain (a real memory) | M | next |
| 7 | Git read | see what changed, diffs | `/api/fs/git-root`, `/api/git/status`, `review/list`, `review/diff`, `file-diff`, `rev-parse`, `commit-context`, `branches` | exec `git` in the session folder | M | next |
| 8 | Git write | stage / commit / push | `review/{stage,unstage,revert,commit,push}`, `branch/switch` | exec `git`, with the idle guard the client already expects | M | later |
| 9 | Skills | browse skills and their files | `/api/skills`, `/api/skills/content` | `skills/list` (read-only) + `workspaceFiles/read` | S/M | next |
| 10 | Usage / Insights | token and session usage | `/api/analytics/{usage,models}`, `insights.get` | a facade ledger over `assistant/message.usage`; **no cost data** | M/L | later |
| 11 | Attachments | send a photo or a file | `POST /api/chat/image-upload`, `file.attach` | `fileUploads/upload` returns a receipt, not a path — needs a staging convention | M | later |
| 12 | Goal / loop / heartbeat | the goal menu | `session.control.read`, `session.control` | `goal` projection only; no loop/heartbeat | M/L | later |
| 13 | `/btw`, `/background` | side questions and background runs | `prompt.btw`, `prompt.background` | no DSH primitive | L | later |
| 14 | Delegated work | follow a subagent | `subagent.list/tail/interrupt` | DSH subagent sessions exist, their events do not | L | later |
| 15 | Bots | create/configure a bot (a Profile) | `profiles.create/configure/set_asset`, bot chat `session.list {include_hidden,title}` | `agentPresets/*` read-only; create needs a facade store + soul injection | L | later |
| 16 | Dictation | host STT | `POST /api/audio/transcribe` | `speech/transcribe` | M | later |

**Non-goals (deliberately not planned):** Kanban (no store or workers in DSH; the client already shows a clean
"unavailable" on its config 404), push/Live Activity (`hermex-push` is an external relay + APNs), the bot screen
(`display.*`/`hermex-screen`), Move-to-Hermes import (DSH cannot inject a transcript — keep the honest 400),
spoken replies (no TTS primitive), provider quota, dashboard themes, `config/defaults|schema`, `model/info`, and
session stats/prune (the 2.0.1 client never calls them).

---

## 4. The first tasks — landed in this change

**The session write fence.** Hermex reads `GET /api/sessions/{id}/mutation-snapshot` before **every** session write
(rename, pin, archive) and sends the revision back as `expected_revision`; it treats only a 404 whose detail starts
`No such API endpoint` as "old host, write bare". `:9121` had no such route, so the catch-all 404 was rethrown and
**every list action failed silently** even though `docs/06` claimed they worked. This was the smallest change with
the highest certainty of a visible bug.

What shipped:

- `GET /api/sessions/{id}/mutation-snapshot` answers `{session_id, exists, runtime_revision}`; an unknown session
  answers `exists:false` (the client turns that into its own 404 instead of writing to a ghost).
- The revision is seeded from the session's activity timestamp and advanced by every gateway write and every turn,
  so a snapshot read before a turn no longer matches after it.
- `PATCH` validates `request_id` + `expected_revision` when present: a stale pair answers
  `409 {"detail":"revision_conflict"}` ("This session changed on the server. Try again."), half a pair answers
  `409 mutation_identity_required`, and a write with neither is applied bare for older clients.
- `unread` is refused with a detail instead of a 200 that changed nothing.
- Tests: the fence is exercised end to end (snapshot → write, stale → 409, half identity → 409, bare write → 200,
  unknown → `exists:false`).

**The wire-defect pass.** The audits found contract drift and two dishonest states; all of it is fixed in the same
change, each with a test:

| Fix | Before | After |
|---|---|---|
| Turn status | `"completed"` (client defaulted it) | canonical `"complete"` |
| `session.interrupt` | `ok`/`idle` | `interrupted`/`not_interrupted` |
| `session.title` | `-32602` with no title | the contract's read form |
| `session.list` | id/title only | the REST row shape on the socket too |
| `PATCH` | only the first field applied | every field named is applied |
| `/sessions/search`, `/stats` | "Session not found" (row regex) | a plain 404 |
| `sources` | substring `cron` emptied the list | exact CSV membership |
| `limit=0` | became the 20-row default | honoured |
| Reverse requests | sent to unadvertised sockets; raw answers left the card open | gated on `client.capabilities`; a raw answer withdraws the frame |
| Login rate limit | keyed on the shared proxy address | keyed on the forwarded client (loopback-trusted only) |
| Empty prompt | promoted the draft, then failed | refused before promotion |
| Double submit | could start two streams | queued instead (`starting` guard) |
| `session.info` model | blank for a session that never picked one | falls back to the catalog default |
| Fast / yolo | echoed as applied | key-level refusal, so the control reverts |
| `unread` | 200 that changed nothing | refused with a detail |

**The in-chat Files browser (parity).** `session.info` now reports `terminal_backend:"local"` (drafts, resume
snapshots and live events), and the listener serves the three read routes the phone's workspace browser calls:
`/api/fs/list`, `/api/fs/read-text` and `/api/fs/download`. A new shared realpath fence (`src/hermes/fence.mjs`)
admits a path only inside a chat folder (DSH workspaces, known session folders, a draft's chosen folder) and denies
the facade state, `$DSH_HOME`, `~/.ssh`, `~/.aws` and `~/.gnupg`; symlinks resolve first. It also mirrors the
host's own Files guard: credential basenames (`.env`, `.env.*`, `.envrc`, `.git-credentials`, `auth.json`,
`credentials`, `config.yaml`, …) and any `mcp-tokens`/`pairing` component are refused and hidden, and the host's
build/VCS caches are hidden from listings. Sizes match the host: a preview reads only the first 512 KiB through the
facade's new `max_bytes`, and a source over 64 MiB answers `413 File too large` before anything is buffered; a
relative MEDIA path resolves against `session_id`'s folder and is then fenced (`attachment:` refs answer 400).
A denied path answers `403` with a detail; a directory answers `400 Path points to a directory`. Git keeps its menu
hidden until `fs/git-root` exists. Tests cover listing (draft and session roots), text/binary previews, the
truncation, downloads, traversal, a symlink escape, credential files/directories, the 64 MiB cap on both routes,
relative MEDIA resolution and the attachment refusal.

Verify: `npm run check && npm test` (178 tests), then rename a chat from the phone's list, pin it, archive it,
unarchive it, stop a running turn, and open Files in a chat to browse a folder and preview a file.

---

## 5. Next picks, with acceptance criteria

Files is done (see §4). The next three, in order:

### Pick 1 — Session search

Calls: `GET /api/sessions/search?q=&profile=&limit=[&sources=cron&exclude_sources=…]` (the list's search field), and
the Bot inbox's search. Backing: `session/search({query})` → `{items:[{sessionId,snippet}],hasMore}`, capped at 20.
Done when: searching returns rows with titles and snippets, an empty query does not 500, results respect the same
source filters as the list, and a caching/debounce policy keeps keystrokes cheap.

### Pick 2 — Chat telemetry

Calls: `usage` on `message.complete` (`{context_used, context_max, input, output}`), `usage` on `session.info`,
and `persisted_turn` when the facade can name the saved rows. (The canonical `status:"complete"` is already in.)
Backing:
`contextUsage`/`tokenUsage` projections (already mapped for the Legacy rows).
Done when: the context ring fills during and after a turn, the turn outcome row is unchanged, and no event grows
unbounded.

### Pick 3 — Git read

Calls: `GET /api/fs/git-root`, `/api/git/status`, `/api/git/review/{list,diff}` (scope uncommitted/branch/lastTurn),
`/api/git/file-diff`, `/api/git/review/{rev-parse,commit-context}`, `/api/git/branches`. Backing: exec `git` in the
chat folder, reusing the Files fence; **read-only first** (stage/commit/push stay hidden until the write guard is
reviewed). Done when: a chat in a repository shows the Git menu with status, change list and diffs; a non-repo folder
hides it; every path is fenced and a diff over 512 KiB is flagged.

---

## 6. Sequencing and cross-cutting work

Order after this change: **session search → chat telemetry → Git read → Tasks → Memory → Skills → Usage →
attachments → goal/btw/background → Bots**.

Cross-cutting items that should ride the first task that touches them. The capability gate, the honest refusals,
the rate-limit key and the prompt-concurrency guards landed in the bugfix pass; these remain:

1. **One path fence** shared by Files, Git and Memory — **done for Files** (`src/hermes/fence.mjs`); Git and
   Memory must call the same fence. The Legacy `:9120` routes remain unfenced, as before.
2. **Cache headers** on file reads (ETag from mtime+size) so transcript images and previews do not re-download.
3. **Event-ring bounds** (per-session bytes + a session cap) and a `forget` on delete/archive.
4. **Docs discipline**: every shipped row updates `docs/05` §2, `docs/06` where the method/REST table changed, the
   README row, and `CHANGELOG` under Unreleased.

Each item is verified the same way: unit/integration tests in `test/`, the standalone probe
(`node scripts/standalone.mjs --port 9199 --gateway-port 9198`), then a phone check on the `:9121` entry. A claim in
the matrix without a probe or a test is marked **UNVERIFIED** there rather than assumed.
