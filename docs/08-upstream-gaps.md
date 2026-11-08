# Upstream gaps: what Hermex asks for and DSH does not provide

This page is the durable answer to "why is this missing?" for every surface
where the phone shows a control or a field that this host cannot honestly
serve. It is deliberately separate from the happy-path contract in
[docs/06-hermes-gateway.md](06-hermes-gateway.md): if a feature is absent because
DeepSeek Harness has no primitive, it is recorded here with the evidence and the
smallest upstream change that would unlock it.

**Last audited:** 2026-11-08, against the DSH checkout and the Hermex 2.x client.
When DSH gains a primitive, move the row to "supported", add the route/method,
and keep the old evidence in the PR/CHANGELOG rather than deleting it silently.

## 1. Status key

| Key | Meaning |
|---|---|
| **UPSTREAM** | DSH has no primitive; the facade cannot implement this without faking data. The phone shows an honest refusal, an empty state, or hides the control. |
| **CLIENT** | The host has the data, but the Hermex client does not decode/use it on this wire (or hardcodes a value). A client change is the unblock. |
| **FACADE** | DSH has the underlying service; this facade still needs a store/mapping/design. This is our work, not an upstream gap. |
| **NON-GOAL** | Deliberately outside the Hermes host contract (external relay, screen, or client-only feature). |
| **LIMIT** | Implemented, with a documented bound/provider default rather than a missing primitive. |
| **PLUGIN** | An optional third-party DSH plugin supplies the board data, but Hermex's contract still needs a facade adapter; it is not out-of-box support. |

## 2. At a glance

| Surface | Hermex expectation | DSH reality | Facade today | Status | Smallest unblock |
|---|---|---|---|---|---|
| **Session preview** | the first user prompt, flattened to one line, as an untitled row's fallback title/search text | the session list carries no message text. `SessionSummary` has no preview; the real first prompt exists only in the internal `titleInput` projection, registered without a wire view. The wire `title` is the LLM title. | `preview` is accepted in the row shape but never fed; absent is a lossy nil in the client | **UPSTREAM** | register a client-visible first-prompt summary projection in DSH (or accept a bounded facade cache, not recommended for a list refresh) |
| **Chat cost** | the context ring's Cost row and per-turn cost | DSH reports tokens, not prices. `dsh-cost-meter` adds a USD ledger for the Usage screen; the Hermex chat path hardcodes `estimatedCost: nil` on both `session.usage` and `message.complete` | Usage/Insights carries cost when the plugin is installed; the Hermes chat ring does not | **CLIENT** (and a plugin for the data) | Hermex must decode `estimated_cost` on the Hermes frame path; the Legacy SSE path already does |
| **Session title / name** | rename and display | works via `session.title` / the write-fenced PATCH | works | **SUPPORTED** | — (not the same thing as `preview`) |
| **Goal** | `/goal` create/edit/pause/resume/clear and a goal snapshot | a real goal domain exists (`@deepseek-ai/dsh-goal`, `dsh-command-goal`) and `commands/execute` resolves a live agent | works: `command.dispatch` runs the host's `/goal`; `session.control.read` returns `{control:{goal:{title,status,turns_used,max_turns}}}`. `done`/`stop` map to clear; `wait`/`gate`/`draft`/`unwait` are refused. Loop/heartbeat are absent, and `session.control` stays unavailable | **PARTIAL / UPSTREAM** | goal works; a loop/heartbeat primitive is still missing |
| **Goal loop / heartbeat** | Pause/Resume in the goal menu | no loop/heartbeat primitive; only the goal phase/activation exists | absent/null; controls must hide or refuse | **UPSTREAM** | a DSH loop/heartbeat domain; do not emulate it with a cron job |
| **Bots** | create/configure a Profile-bot, hidden bot chats, soul | `agentPresets/*` is read-only; no profile store or writable soul | `profiles.*` answers 404/-32601; Bots screen errors | **FACADE** | a facade-owned profile store + soul injection; this is our work, not a DSH primitive |
| **Side tasks (`/btw`, `/background`)** | side question and background runs | no DSH side-task/background primitive | `prompt.btw`/`prompt.background` absent | **UPSTREAM** | a DSH sidechain/background-job API |
| **Delegated work** | subagent list/tail/interrupt | subagent sessions exist; their live events/tail do not | absent | **UPSTREAM** | subagent event/tail API |
| **Chat edit / regenerate / retry / undo / compress / clear** | rewind the transcript and re-run | no user transcript-truncation primitive; compaction exists but is not an edit/rewind API | these controls append or answer 404/400 | **UPSTREAM** | a DSH transcript truncate/rewind primitive |
| **Session delete** | remove a session | no delete primitive | honest 400 | **UPSTREAM** | a DSH session-delete primitive |
| **Move-to-Hermes import** | inject an exported transcript | DSH cannot inject a transcript | honest 400 | **UPSTREAM** | a DSH transcript-import primitive |
| **Spoken replies (TTS)** | `/api/audio/speak` | no synthesis primitive | 404 | **UPSTREAM** | a DSH speech-synthesis Remote |
| **Skills disable toggle** | turn a skill off | DSH has no skill-disable primitive | 400 with the reason | **UPSTREAM** | a DSH skill enable/disable API |
| **Memory USER.md / soul** | a user profile and a Profile SOUL.md | DSH has no user-profile file; the SOUL path is absent; only `$DSH_HOME/AGENTS.md` is real | MEMORY.md reads/writes; USER/soul keep 404 | **UPSTREAM** | DSH user-profile and SOUL files (or a documented equivalent) |
| **Fast / yolo / personality** | model controls | DSH has no such config; approvals mode is not exposed | key-level refusal so the control reverts | **UPSTREAM** | a DSH config primitive for those modes |
| **`@path` completion** | path completion in the composer | no client-visible complete.path RPC | `complete.path` answers `-32601` | **UPSTREAM** | a DSH path-completion RPC |
| **Usage Messages total** | a message count | no message-count projection | `insights.get` returns `{messages:0}` (labelled approximate) | **UPSTREAM** | a DSH message-count projection |
| **Git pull-request creation** | "create PR" ship flow | no PR/GitHub primitive; `ship-info` has no PR | `{pr:null}`; no PR is created | **FACADE / external** | a gh/GitHub integration or an explicit non-goal |
| **Kanban** | boards and cards | no native store/workers; optional `dsh-kanban-flow` (third-party, MIT) keeps one board per workspace in `.dsh-kanban-flow.json`, exposes `kanbanflow_*` tools and a `/api/kanban-flow` host route | config 404 → clean "unavailable" | **PLUGIN / FACADE** | install + pin the plugin, then a gateway adapter; board/card read-write is feasible, workers/dispatch/comments/dependencies/events are not |
| **Push notifications / Live Activity** | APNs relay | external `hermex-push` relay + APNs | not served | **NON-GOAL** | — |
| **Bot screen / `display.*`** | a host-rendered screen | external `hermex-screen` | not served | **NON-GOAL** | — |
| **Dictation limits** | record/transcribe | STT works, but only canonical 16 kHz mono PCM16 WAV; stock Remote default is 4 MiB/120 s | m4a→WAV via afconvert/ffmpeg; 25 MiB route bound; Remote bound still applies | **LIMIT** | raise/configure the speech Remote default, or stream |

## 3. Details behind the rows people ask about

### 3.1 Session preview is not the session title

Hermex's `preview` is **the first user prompt** flattened to one line and cut at
60 characters; it is used as the fallback title for an untitled row and as local
search text. DSH's wire session summary has no message text, and the real first
prompt lives in the internal `titleInput` projection without a wire view. The
wire `title` is the LLM-generated title, which is a different thing.

The facade consequently leaves `preview` absent. That is safe: Hermex decodes
it lossily and falls back to the title. A bounded facade cache of the durable log
would make it work, but it turns every list refresh into N cold reads and needs
invalidation on rename/archive/fork, so it was deliberately not added. The
durable fix is a DSH first-prompt summary projection.

### 3.2 Chat cost is a client gap, not a host gap

DSH itself reports tokens, not prices. The `dsh-cost-meter` plugin keeps a USD
ledger and powers the Usage screen. The **Legacy** webui path (`done.usage` and
session detail) decodes `estimated_cost`, and the ring popover renders it. The
**Hermes** chat coordinator builds its `ContextWindowSnapshot` with
`estimatedCost: nil` in both `session.usage` and `message.complete`, so adding
the field would be dead. The facade therefore leaves the Hermes chat cost absent
and keeps cost on Usage/Insights.

### 3.3 Goal exists; loop/heartbeat does not

DSH has a real goal domain: a goal has `id`, `revision`, `objective`, `phase`
(`active|paused|blocked|complete`), `activation` (armed/disarmed), rounds and a
blocked reason. `/goal` is a real command and the goal tool is part of the
agent's toolset. The facade exposes the **goal** through the host's own command
(`command.dispatch` -> `commands/execute`) and reads the durable projection
(`session.control.read` -> `session/projections`), so create/edit/pause/resume/
clear and a status snapshot work. Hermex's `done`/`stop` end a goal, so they map
to DSH's `clear`; `wait`/`gate`/`draft`/`unwait` have no DSH equivalent and are
refused rather than becoming objectives.

There is **no loop or heartbeat** primitive. Their keys are absent and
`session.control` stays unavailable, so the phone hides Pause/Resume. Emulating
them with a cron schedule would be a different feature and would lie about the
state the client is asking for. A `/goal done` that needed the goal service's
`complete()` would also be a second goal path; mapping it to `clear` is the
honest parity choice.

### 3.4 Chat mutation needs a transcript primitive

The phone's edit/regenerate/retry/undo/compress/clear controls need to remove or
rewrite transcript rows. DSH has compaction, but that is a model-driven summary,
not an arbitrary user truncation API. Until DSH exposes one, those controls must
append or refuse; do not implement a local shadow transcript, because it would
diverge from the session log the agent reads.

### 3.5 Kanban can be a plugin adapter, but it is not Hermex Kanban

A real DSH plugin exists: **`dsh-kanban-flow`** (MIT, external) keeps one
board per workspace in `<workspace>/.dsh-kanban-flow.json`, injects none of the
session transcript, and registers both agent tools (`kanbanflow_*`) and a host
HTTP route `POST /api/kanban-flow` (`{method, args}`, `workspaceId` picks the
board). It is a useful **workflow board** with fixed columns **Backlog → To Do →
In Progress → Review → Done**, a per-item task session, a status note, and a
human/agent actor guard. Several `dsh-task-board` variants cover similar ground.

It is **not** the Hermes Kanban bridge. Hermex's `/api/kanban/*` contract also
has board lifecycle/config, dispatch, worker logs, comments, dependencies,
assignees/stats, and an events SSE feed. The plugin has none of those as a
Hermex-shaped API, and its one-board-per-workspace model does not match Hermex's
board switcher. A proxy can therefore land a **Kanban-lite** surface, not parity:

| Hermex surface | Plugin equivalent | Adapter result |
|---|---|---|
| `config`, `boards`, `boards/{slug}`, `switch` | `getMeta` + the DSH workspace list | one board per workspace; no independent board create/archive |
| `board` snapshot | `get` / `summary` | columns and items map cleanly; fixed five columns |
| tasks create/edit/move/status | `createItem`/`updateItem`/`moveItem`/`setStatus` | map with actor `human`; `setSession` links the item's session |
| task detail / open chat | item `sessionId` | open that DSH session; no worker process/log |
| dispatch, worker log | per-item task session only | open the session; `dispatch`/`log` stay 501/empty |
| comments, dependencies, events stream, assignees/stats | absent | empty/501; hide or degrade those controls |

The natural seam is the gateway (Hermex talks to `:9121`): add `/api/kanban/*`
there and call the plugin's `/api/kanban-flow` on the DSH web listener
(loopback), resolving the DSH workspace id from `/api/workspaces`. Reading the
JSON file directly is simpler but unsafe while the plugin's in-memory cache is
active, so it is not the recommended seam. The plugin is third-party code:
review and pin a commit, and do not make it mandatory for chat to work.

**Recommendation:** scope the first adapter to **read board + create/edit/move
cards + open the task session**. Keep dispatch/workers/comments/dependencies/
events out until the plugin (or a facade-owned store) grows those primitives.
Do not call this full Kanban in docs or UI. A facade-owned full Kanban remains a
larger alternative if the plugin's workflow model is not acceptable.

### 3.6 Bots are facade work, not an upstream missing primitive

DSH's `agentPresets/*` is read-only and has no writable soul. A Bots screen needs
a facade-owned profile store and a controlled soul injection. It is a large
feature, but it is **our** work rather than an upstream gap; it stays on the
roadmap as such.

## 4. Non-goals, restated

Push/Live Activity, the bot screen (`display.*`), Move-to-Hermes import,
spoken replies without a DSH TTS primitive, provider quota, dashboard themes,
`config/defaults|schema`, `model/info`, and session stats/prune are outside the
host contract. They are not bugs and should not be half-implemented. Kanban is a
separate case: it is optional **plugin-adapter** work, not a non-goal, but a
board-lite adapter must not be presented as Hermex Kanban parity.

## 5. UI presentation that can look like missing data

A completed Turn folds its work rows in the Web client's default work-details
modes. In **Compact**, **Standard** and **Detailed**, the answer stays visible
and the tool/reasoning/code rows sit behind the Turn control ("Completed in
…"); **Verbose** never folds them. The live "Deep diving for Ns ···"
(`RunningStatus`) is a status indicator, not a substitute for the rows. If a
Turn finished while the screen was away, returning to the session therefore
shows the answer plus the folded Turn, not a lost transcript.

**Workaround:** Settings → General → **Work details** → **Verbose** (or expand
the "Completed in …" row / group header). An explicit in-app choice overrides
a profile's `ui-chat.transcriptView` default, so confirm the row in Settings.

There is one genuine edge defect: when the opening page's 500-message budget
cuts inside the still-running Turn, its `turn/start` is absent, the Turn is
classified as historical, and its rows start collapsed — one live header
("Analyzing the request") plus the clock. The two-line upstream fix is to cut
at the enclosing `turn/start` for the newest Turn (session-controller history)
and to group only a `closed` Turn as historical (Web `ChatGroupSeat`). That is
a DSH fix, not a facade workaround.

## 6. Maintenance

1. When DSH adds a primitive, implement the route/method with tests first.
2. In the same PR, move the row from the "At a glance" table to the supported
   side and link the new test/route.
3. Keep the evidence here until **all four transport surfaces** (REST, WS,
   events, push) agree; a half-wired primitive is worse than an honest gap.
4. If a row becomes `CLIENT`, say so explicitly and link the Hermex change, not
   a facade route.
