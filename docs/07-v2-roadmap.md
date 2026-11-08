# 07 — V2 roadmap: parity first, then the full Hermes host

Status: **2026-11-07** · companion to [05-compatibility-matrix.md](05-compatibility-matrix.md), whose §2 is the state
this plan moves. Client: Hermex 2.0.1 (`7547796`); upstream host: `/tmp/hermes-agent` @ `90d6b98`; DSH
`0.2.2-rc.1`.

The goal has two parts, in this order:

1. **Parity.** Anything the **Legacy** server (`:9120`, hermes-webui) already does for the phone must also work on
   the **Hermes host** (`:9121`). That is the "similar to how V1 was" bar.
2. **Full V2.** Then add the surfaces only a Hermes host unlocks (Bots, session search,
attachments — attachments and Git writes now shipped),
   but only where DSH has a real primitive to back them. A screen that half-renders is worse than one that is
   cleanly hidden.

Two constraints shape everything below:

- **The app hides what the host cannot do.** `-32601` for a method, 404 for a route, and the matching control
  disappears. That makes honest refusal the cheapest correct behaviour — and makes a *partial* screen the most
  user-hostile outcome.
- **Only DSH primitives count.** `session/*`, `workspaceFiles/*`, `session/search`, `schedule/*`, `skills/list`,
  `agentPresets/*`, `pluginManager/*`, `speech/transcribe`, the `contextUsage`/`tokenUsage`/`goal` projections and
  the approval/question waterfalls are real. Kanban, git writes, usage rollups, TTS and transcript import are not.

---

## 1. Where V2 stands

Verified by the matrix and by the live `access.log`: the chat path is solid — sessions, streaming tokens, thinking,
tool cards, stop/steer, approvals and clarifications, model and effort, reconnect/replay, export and REST paging
all work on `:9121`. The phone has been driving it every day.

The gaps split cleanly:

| Kind of gap | Examples | What it costs the phone |
|---|---|---|
| Chat telemetry | `usage` on turn events, `terminal_backend`, canonical turn status | the context ring and token counts work (no cost); Files/Git now appear |
| Disabled feature that exists on the other transport | YOLO honesty | V2 is worse than V1 for that one feature |
| Screens with no backend yet | Bots | the screen errors (the sidebar toggles are local, not probes); attachments and Git writes are done |
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
| P5 | Chat transcript fidelity | tool results + verdicts | same over REST; status is canonical and `message.complete` now carries usage | add `persisted_turn` when the row ids are known | S |
| P6 | `@path` / file completion | n/a | `complete.path` -32601 | map to directory listing | S |

**Chat attachments are shipped** (v1.12): the Hermes listener stages images/documents, image uploads become native
image parts while the app's two-line vision reference stays in the transcript (Hermex rebuilds the chip), and a
document is an `@file:<path>` reference. V1 still refuses them; the V2 contract is where they become first-class.

---

## 3. Phase 2 — the Hermes-only screens, ranked

Effort: **S** = one route/method over an existing facade primitive; **M** = new shaping or a small mapping layer;
**L** = needs a new DSH primitive, a facade store, or a behaviour change.

| # | Surface | Why the phone cares | Calls to add | DSH backing | Effort | Verdict |
|---|---|---|---|---|---|---|
| 1 | Session search | the list's search field 404s today | `GET /api/sessions/search` (REST) | `session/search` → `{items:[{sessionId,snippet}],hasMore}` + list rows | S | done |
| 2 | Live Working / Needs-you | the live dots are absent | `session.active_list`, `sessions.changed` | the gateway's own runner + session rows | S | done |
| 3 | Chat telemetry | context ring and turn metadata | `usage` on `message.complete` + live `session.usage`; `partial`/`persisted_turn` still absent | `tokenUsage`/`contextPressure` projections (`session/projections`) | S | done |
| 4 | Files | read code and artifacts from the phone | **done in this change** (read-only) | the facade's file routes behind the shared fence | M | done |
| 5 | Tasks / cron | scheduled jobs and history | `/api/cron/jobs`, `/runs`, pause/resume/trigger/delete, delivery-targets, `sources=cron` agenda | `schedule/*` (near-exact) | M | done |
| 6 | Memory | edit what the agent remembers | `/api/memory`, `files/read`, `files/upload`, `profiles/{n}/soul`, `profiles.list[].path` | `$DSH_HOME/AGENTS.md` chain; managed 2 MiB atomic save, no USER/soul file | M | done (read + write, global) |
| 7 | Git read | see what changed, diffs | `/api/fs/git-root`, `/api/git/status`, `review/list`, `review/diff`, `file-diff`, `rev-parse`, `branches` | exec `git` in the session folder | M | done |
| 8 | Git write | stage / commit / push | `review/{stage,unstage,revert,commit,push}`, `branch/switch` | exec `git` behind the idle guard; commit context feeds the app's message helper | M | done (v1.13) |
| 9 | Skills | browse skills and their files | `/api/skills`, `/api/skills/content` | `skills/list` (read-only) + the catalog SKILL.md path | S/M | done (read-only) |
| 10 | Usage / Insights | token and session usage | `/api/analytics/{usage,models}`, `insights.get` | a facade ledger over the session projections, plus `dsh-cost-meter` cost when installed | M/L | done (tokens + cost) |
| 11 | Attachments | send a photo or a file | `POST /api/chat/image-upload`, `file.attach` | native `session/prompt` image parts + a facade uploads staging root; the app's vision reference stays in the transcript text; documents stay path-based | M | done (v1.12) |
| 12 | Goal / loop / heartbeat | the goal menu | `command.dispatch` (`/goal`), `session.control.read` | DSH's real goal domain + `/goal` command; no loop/heartbeat | M/L | partial: goal works; loop/heartbeat absent |
| 13 | `/btw`, `/background` | side questions and background runs | `prompt.btw`, `prompt.background` | no DSH primitive | L | later |
| 14 | Delegated work | follow a subagent | `subagent.list/tail/interrupt` | DSH subagent sessions exist, their events do not | L | later |
| 15 | Bots | create/configure a bot (a Profile) | `profiles.create/configure/set_asset`, bot chat `session.list {include_hidden,title}` | `agentPresets/*` read-only; create needs a facade store + soul injection | L | later |
| 16 | Dictation | host STT | `POST /api/audio/transcribe` | `speech/transcribe`; m4a converted to canonical WAV with afconvert/ffmpeg | M | done (STT; TTS still absent) |

The durable "why this is missing" catalogue, including the upstream primitive
needed for each item, is [08-upstream-gaps.md](08-upstream-gaps.md).

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
relative MEDIA path resolves against `session_id`'s folder and is then fenced (`attachment:` refs answer 400);
the facade uploads root is an additional read root so an attached image/document can be previewed.
A denied path answers `403` with a detail; a directory answers `400 Path points to a directory`. Tests cover
listing (draft and session roots), text/binary previews, the truncation, downloads, traversal, a symlink escape,
credential files/directories, the 64 MiB cap on both routes, relative MEDIA resolution and the uploads-root preview.

**The Git menu, read-only.** `src/hermes/git.mjs` runs `git` with `execFile` (no shell), a timeout, a bounded
output, and `$DSH_HOME`/SSH-style secret directories excluded; the shared fence admits the chat folder, and the
session's folder resolves a relative MEDIA path for Files. The listener now serves `/api/fs/git-root` and the read
routes the panel calls: `/api/git/status` (branch, ahead/behind, staged/unstaged/untracked/conflicted counts, rows),
`/api/git/review/list` (uncommitted/branch/lastTurn), `/api/git/review/diff`, `/api/git/file-diff`,
`/api/git/review/rev-parse` and `/api/git/branches`. The client names the repository root, which is normally
*above* the chat folder, so the Git scope admits the top-level of a repository that holds an allowed folder and
nothing else. A `file` is realpath-checked inside the root, a symlink is refused, `base`/`ref` are validated so a
query cannot inject a git option, a credential or `.ssh`/`.aws`/`.gnupg`/`.dsh` path is hidden and refused, and
the all-add fallback runs only for an untracked file. Writes (stage, unstage,
revert, commit, push, branch switch) are live: stage/unstage/revert take one literal file (unstage also all),
commit uses the staged index and returns a short sha, push uses the upstream or sets `origin`, and branch switch
moves the tree. Every write is refused with `409` while a turn on this listener is running; a conflict is `409`, a bad path/ref or
a `git` failure is `400`, and a credential/symlink path is refused by the same fence. `commit-context` returns the
staged diff and recent subjects for the app's message helper. `ship-info` answers no pull request. Tests cover a real
temporary repository: status, changes, patches (tracked and untracked), branches, sha, the fence for a non-root, the
non-repo shapes, stage/unstage/revert/commit/push/switch, the client's `:(literal)` prefix, the idle guard and the
commit context.

**Session search (both listeners).** `GET /api/sessions/search` now backs the list's search field on `:9120` and
`:9121`. One facade reply carries both shapes: `results` (the Hermes host rows: `session_id`, `id`,
`lineage_root`, title, recency, model and `match_type`; `snippet`/`role` are null) and `sessions` (the webui rows
with `match_preview`/`match_type`). Matching runs id first, then DSH's message-content search (`session/search`, a
literal FTS read that never resumes an agent), then a title supplement; each row carries the session
summary; the webui rows also carry `match_preview`, while the host rows carry no excerpt because DSH's search API
exposes no author and Hermex drops a snippet without a role. One row per session, capped by `limit` (1–100); DSH
returns at most 20 content hits, so the id/title lanes fill the rest. An empty query answers an empty result, and a
source filter DSH cannot satisfy (`sources=cron`) honestly matches nothing because DSH stores no session provenance.
Tests cover both shapes, id/content/title lanes, the empty query, the limit, the source filters and `/stats`
staying 404.

**Chat telemetry (no cost).** A turn now carries its context and token usage. `host.sessionUsage` reads the
`tokenUsage` and `contextPressure` projections through `session/projections`; the facade publishes a live `usage`
frame with the assistant message and the authoritative `usage` on its `done` event, and the gateway maps both to
the host vocabulary: `session.usage` mid-turn and `usage` on `message.complete`, each `{input, output,
context_used, context_max}`. Legacy's `done.usage` is the context-window snapshot the app already decodes
(`input_tokens`, `output_tokens`, `context_length`, `last_prompt_tokens`), so both transports fill the same ring.
There is **no cost**: DSH reports tokens, not prices, and Hermex's chat snapshot ignores cost even when present —
Usage/Insights reads that same projection data per session, and takes cost from `dsh-cost-meter` where installed. `partial`/`persisted_turn` remain absent because the
saved row ids are not in the turn event. The facade's `/api/session` detail and JSON export carry the same snapshot
(`context_length`, `last_prompt_tokens`, `input_tokens`, `output_tokens`), so the Legacy ring survives the app's
post-turn transcript refresh and a later chat open. Tests cover the Legacy SSE usage frame, the done payload, the
detail/export snapshot, the host mapping against fake projections, and the gateway's live `session.usage` plus
`message.complete.usage`.

**Tasks / cron.** `GET /api/cron/jobs`, `/runs` and the create/edit/pause/resume/trigger/delete routes now translate
DSH's `schedule/*` service: a schedule entry becomes a job (name, prompt, schedule text, next/last run, state), one
delivery becomes a run whose `id` is the session it ran in, and the editor's text becomes a timing DSH's own
validators accept: five-field numeric cron, `every` (60 s minimum), `daily`/`weekdays`/`weekly` at HH:MM (sent as
HH:mm:ss with ISO weekdays 1-7), an ISO time with an explicit offset, or the two-line DTSTART/RRULE form. Invalid
text, or a host `schedule/input-invalid` refusal, answers 400 with the reason. Delivery is **local only** (a DSH schedule delivers into a
session); a non-local `deliver`, model, provider or skills are refused with a reason instead of being ignored, and a
trigger the service reports as already pending answers `409`. Run history is the schedule's delivery records, so a
run opens as its session and there are no host output files or per-run cost. `sources=cron` on the agenda stays empty
because DSH stores no session provenance. Tests cover the mapping and the full lifecycle through the gateway and the
facade.

**Memory (read/write).** The Memory screen loads: `profiles.list` carries the real, absolute `$DSH_HOME` path,
`/api/config` turns on only the memory section, `/api/profiles/default/soul` is an empty soul, and
`/api/files/read` serves `.../memories/MEMORY.md` as the global `$DSH_HOME/AGENTS.md` (a missing file is 404 → an
empty screen). `POST /api/files/upload` saves that same managed suffix back to `$DSH_HOME/AGENTS.md`: the body is
base64 `text/plain`, empty content clears, 2 MiB cap, valid UTF-8, and a 0600 temp file is renamed into place so a
failed save leaves the old text intact. There is no USER.md (the section is off; DSH has no user-profile file) and no
soul, and those paths keep their 404. The requested path is never opened, so Memory is not a second file browser and
cannot write outside the allowlist. Per-workspace `AGENTS.md` files are not part of this global screen, and DSH's
global chain (`$DSH_HOME/AGENTS.md` then `$DSH_AGENTS_HOME/AGENTS.md`) is represented by its first file only; the
`memory_char_limit` in the config is the editor's ceiling, not a DSH cap, and the read is not size-limited.
Tests cover the loaded document, the write→read round trip, empty saves, malformed/oversized bodies and the 404s.

**Skills (read-only).** `GET /api/skills` maps DSH's per-session catalogue to the bare array the screen decodes
(`enabled: true`, because every skill DSH lists is invocable), and `GET /api/skills/content` returns the named
skill's SKILL.md plus its catalog path; an unknown name is a 404, so a missing skill is an honest error. DSH's
catalogue is scoped to a session composition, so the newest session (archived included) supplies the cwd/preset;
no sessions means an empty catalogue. `PUT /api/skills/toggle` answers 400 with the reason: DSH has no skill-disable primitive. Linked files
are the client's `/api/fs/*` reads from the SKILL.md folder; they appear only when that folder sits inside a chat's
fenced roots, so a skill under `$DSH_HOME` opens without them. Tests cover the list, the content, the 404 and the
refused toggle.

**Usage/Insights.** `GET /api/analytics/usage` and `/models` aggregate DSH's cached session
projections: sessions, input/output/cache-read tokens, per-model rows and a UTC daily chart for the requested
window (1-365 days). DSH has no per-day ledger, so a session's cumulative tokens are attributed to its last prompt
day (falling back to the row's `updatedAt`); its last-used model names its row. Archived and subagent sessions are
included because their tokens are real usage, and a session with no model still counts in totals/daily but has no
model row. Cost comes from the **`dsh-cost-meter`** plugin when it is installed on the same host: its ledger stores USD,
so its total, daily and per-model amounts are used directly (the plugin's display currency does not change them).
The query uses the host-local day the ledger writes, and empty-date zero entries are dropped so a cost-free window
stays an empty state. Without the plugin the
cost fields stay absent (the screen reads 0). OpenRouter Plus's exact per-request `usage.cost` is not merged yet, so
the figure is the plugin's estimate. `insights.get` answers `{messages:0}` because DSH exposes no message count; the screen
already marks its Messages total approximate. No sessions in the window is a real empty state. Tests cover the host
aggregation, both routes and the RPC.

**Live Working, dictation, Git and goal (parallel batches).** `session.active_list` reports
`{session_key,status}` for the list (`starting` before a turn goes live, `streaming` while it runs, `waiting` for an
open approval/clarify; idle omitted), and `sessions.changed` broadcasts on turn/request boundaries. `POST`
`/api/audio/transcribe` calls DSH `speech/transcribe`, converting the phone's m4a to canonical 16 kHz mono WAV
with afconvert (macOS) or ffmpeg; no converter is an honest 400. Git push prefers
`branch.<name>.pushRemote`, then `remote.pushDefault`, then `branch.<name>.remote` (refspec explicit), and status
uses `--untracked-files=all` so an untracked directory lists its files. `/goal` is in the slash catalogue and
runs through the host command; `session.control.read` returns the goal snapshot and a goal command publishes one
`session.control.update`; loop/heartbeat remain absent. A reattaching client replays the **active turn** because
the event ring pins the turn's first event (up to 20,000) instead of dropping its start; after settle it trims
back to the quiet 5000. Tests cover the live states, converter, memory save/overwrite, Git remotes, goal
verbs/read/update, and the active-turn replay pin.

Verify: `npm run check && npm test` (280 tests), then rename a chat from the phone's list, pin it, archive it,
unarchive it, stop a running turn, watch a starting/Working/Needs-you dot settle, edit Memory and re-read it,
dictate a short recording, run `/goal` and read its snapshot, push a branch with a slash-named remote, and open
Files in a chat to browse a folder and preview a file.

---

## 5. Next picks, with acceptance criteria

Files, Git read, session search, chat telemetry, Tasks, Memory, Skills, Usage, Attachments, Git writes, Live
Working / Needs-you, Memory write, Dictation, the goal surface (partial) and the small polish batch are done
(see §4 and [08-upstream-gaps.md](08-upstream-gaps.md)). The next two, in order:

### Pick 1 — Bots

Calls: `profiles.create`/`configure`/`set_asset` and the bot chat's hidden session list. Backing: DSH's
`agentPresets/*` is read-only, so creating a bot needs a facade store and a soul injection; the socket should keep
answering `-32601` until that exists. Done when a bot can be created and chatted with from the phone.

### Pick 2 — Side tasks (`/btw`, `/background`)

Calls: `prompt.btw`/`prompt.background` and the side-chain frames. Backing: DSH's btw sidechains/background jobs
where they are exposed; otherwise the socket keeps answering `-32601` honestly. Done when: a side prompt runs
without disturbing the main turn and its result has its own panel.

---

## 6. Sequencing and cross-cutting work

Order after this change: **Bots → side tasks when DSH exposes them**.

Cross-cutting items that should ride the first task that touches them. The capability gate, the honest refusals,
the rate-limit key and the prompt-concurrency guards landed in the bugfix pass; these remain:

1. **One path fence** shared by Files and Git — **done** (`src/hermes/fence.mjs`). Memory deliberately reads
   only its `AGENTS.md` allowlist: the fence denies `$DSH_HOME`, and the screen must not become a second file
   browser. The Legacy `:9120` routes remain unfenced, as before.
2. **Cache headers** on file reads (ETag from mtime+size) so transcript images and previews do not re-download.
3. **Event-ring bounds** (per-session bytes + a session cap) and a `forget` on delete/archive.
4. **Docs discipline**: every shipped row updates `docs/05` §2, `docs/06` where the method/REST table changed, the
   README row, and `CHANGELOG` under Unreleased.

Each item is verified the same way: unit/integration tests in `test/`, the standalone probe
(`node scripts/standalone.mjs --port 9199 --gateway-port 9198`), then a phone check on the `:9121` entry. A claim in
the matrix without a probe or a test is marked **UNVERIFIED** there rather than assumed.
