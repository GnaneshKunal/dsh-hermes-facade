# 03 — DSH host integration (the reusable API surface)

Everything below was read out of the working **mobile gateway** (`~/.dsh/profiles/web/node_modules/dsh-plugin-mobile-gateway/`), the minimal **swift bridge** (`dsh-swift-bridge/`), and the core packages under `/Users/gnanesh/.bun/install/global/node_modules/@deepseek-ai/`.

**The three APIs that matter most**

1. `ctx.typertGateway.invoke({ namespace, method, args, peer })` / `.stream({ …, signal })` — the *only* way to drive DSH. Every session, prompt, cancel, model, and command operation is a Typert Remote behind this one call. No HTTP, no cookies, no loopback hop.
2. `ctx.webServer.register({ kind, path, handler })` / `registerUpgrade(...)` — how the plugin gets its own HTTP+SSE (or WS) surface on the GUI's port.
3. `ctx.on('approval/request', …)` and `ctx.on('user-questions/request', …)` as **waterfalls** — how a plugin answers approvals/questions for a remote client instead of leaving them to the Web GUI.

**Blocker, up front:** there is **no SSE/streaming contract for authenticated routes.** `ctx.connection.fetch.register(...)` mounts only on `/api`, returns a `Response`, and answers 403 to any non-owner Peer — fine for JSON, unproven and awkward for long-lived streams. Both working plugins stream over **raw `webServer.register` + their own token** (swift-bridge) or **`registerUpgrade` + WebSocket** (mobile gateway). Plan for SSE on a raw route with your own bearer auth, not on `/api`.

---

## 1. Plugin skeleton

### package.json

`dsh-swift-bridge/package.json` is the cleanest template:

    {
      "name": "dsh-hermex-gateway",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "main": "index.js",
      "exports": { ".": "./index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
      "files": ["index.js", "src", "cordis.patch.yml", "README.md"],
      "dependencies": { "ws": "^8.21.0" },
      "peerDependencies": {
        "@deepseek-ai/cordis": "~4.0.5",
        "@deepseek-ai/dsh-api-gateway": "^0.2.1-rc.2",
        "@deepseek-ai/dsh-client-connection": "^0.2.1-rc.2",
        "@deepseek-ai/dsh-home-paths": "^0.2.1-rc.2",
        "@deepseek-ai/dsh-host-webserver": "^0.2.1-rc.2",
        "@deepseek-ai/schemastery": "~3.18.5"
      },
      "engines": { "node": ">=22", "dsh": "^0.2.1-rc.2" },
      "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
    }

Rules the loader actually enforces (`dsh-app-boot/lib/index.js:1097-1143`): **`engines.dsh` decides alone** — when present, `peerDependencies` are ignored for compatibility; when absent, every `@deepseek-ai/dsh` / `dsh-*` peer must satisfy the runtime. Ranges are evaluated with `semver.satisfies(…, { includePrerelease: true })`, so `^0.2.1-rc.2` **does** admit `0.2.2-rc.1` (verified locally). A mismatch does not crash: the bundle is skipped with `dsh: skipping profile bundle "<name>": …` and can only be forced by an exact-version exemption in the profile's `compatibility.json` (`dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`).

`peerDependencies` are **not installed** — they resolve against the host's own copies. `dependencies` are installed. The mobile gateway ships **no** `engines`/`peerDependencies` at all; that is the low-friction option if you want to survive 0.2.x churn.

`dsh.bundle.patch` may be a string or an ordered list of files (`bundlePatchFiles`, line 1335).

### cordis.patch.yml

`dsh-swift-bridge/cordis.patch.yml`:

    - insert:
        - id: hermex-gateway
          name: 'dsh-hermex-gateway'
          config:
            token: !!js process.env.DSH_HERMEX_TOKEN
            path: /hermex

Composition order (`dsh-app-boot/lib/index.js:1308-1318`): empty entry list → each bundle's patch in `dsh.profile.bundles` order → the profile's own `cordis.patch.yml` → `--patch` overlays. A later layer may re-state a row by `id` to override its whole `config`, or `disabled: true` it. `!!js` expressions run at load.

### Entry module

`dsh-swift-bridge/index.js` — named exports, no classes needed:

    import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

    export const name = 'hermex-gateway'
    export const inject = ['webServer', 'typertGateway', 'connection']
    export const Config = Schema.object({ /* schemastery, optional */ })

    export async function apply(ctx, config = {}) {
      const logger = ctx.logger ?? console          // ctx.logger may be absent
      const gateway = ctx.get('typertGateway')
      const connection = ctx.get('connection')
      if (gateway === undefined || connection === undefined) {
        logger.warn('hermex: host has no typertGateway/connection; not mounted')
        return
      }
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), 'hermex: routes')
      ctx.effect(() => () => server.close(), 'hermex: lifetime')
    }

`inject` is hard: Cordis will not activate the row before those services exist (`mobile-gateway/lib/index.mjs:2281`). `ctx.effect(fn, label)` registers a disposer and unwinds it on unload — **every route and socket must live inside one**. `export default { name, Config, inject, apply }` also works (the mobile gateway does both).

### Enabling it in the web profile

`~/.dsh/profiles/web/package.json` has `dsh.profile.bundles: [...]`. Add your package name there and it is installed and patched as a bundle; `cordis.yml` is intentionally `[]` — **never** edit it. For a local checkout, add `"dsh-hermex-gateway": "link:/Users/gnanesh/self/dsh-hermexxx"` to `dependencies`. Then restart `dsh web`. (`dsh plugin --profile web add …` is just pnpm forwarding.)

---

## 2. HTTP routes

Service: **`ctx.webServer`** (`@deepseek-ai/dsh-host-webserver`, `lib/index.js:375-411`).

    ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler: (req, res) => … })
    ctx.webServer.register({ kind, path, resource: (request, peer?) => Response })   // GET/HEAD only
    ctx.webServer.registerUpgrade({ path, handler(req, socket, head) })
    ctx.webServer.registerFallback(handler)   // ONE seat — already owned by frontend-static
    ctx.webServer.port / .host / .protocol / .getOrigin()

- `handler(req, res)` gets a raw `node:http` `IncomingMessage`/`ServerResponse`, is `await`ed, and a throw answers 400 (or destroys the socket if headers are already out) and logs a warning — it never exits the process.
- Matching: exact over the whole table → longest prefix → fallback. **Registering the same `(kind, path)` twice throws.**
- The gzip middleware explicitly skips `text/event-stream` and `no-transform`, so SSE is safe.

A working SSE snippet (mirrors `dsh-client-hmr/lib/index.js:124-152`, the shipped pattern):

    const clients = new Set()

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!authorize(req)) { res.writeHead(401); res.end(); return }

      if (url.pathname === '/hermex/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        clients.add(res)
        res.on('close', () => clients.delete(res))
        return                      // do NOT res.end(): the stream stays open
      }

      const body = req.method === 'POST' ? await readBody(req) : {}
      sendJson(res, 200, { ok: true, body })
    }

    const publish = frame => {
      const line = 'data: ' + JSON.stringify(frame) + '\n\n'
      for (const res of clients) res.write(line)
    }

    function readBody(req) {                       // mobile-gateway/lib/index.mjs:2181
      return new Promise((resolve, reject) => {
        let data = '', bytes = 0, oversized = false
        req.on('data', c => { bytes += c.length; if (bytes > 1 << 20) oversized = true; else data += c })
        req.on('end', () => {
          if (oversized) { const e = new Error('too large'); e.status = 413; return reject(e) }
          try { resolve(data === '' ? {} : JSON.parse(data)) } catch (cause) {
            const e = new Error('body must be a JSON object', { cause }); e.status = 400; reject(e)
          }
        })
        req.on('error', reject)
      })
    }

    function sendJson(res, status, value) {        // gateway security headers, line 2212
      const body = JSON.stringify(value)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

Headers and cookies are plain `req.headers['authorization']` / `req.headers.cookie`. The loopback check used everywhere compares `req.socket.remoteAddress` against `127.0.0.1`, `::1`, `::ffff:127.0.0.1` (`mobile-gateway` `isLoopback`).

**Authenticated alternative (JSON only):** `ctx.connection.fetch.register({ path: '/api/hermex', methods: ['POST'], requestBody: 'buffered' | 'streaming', fetch(request) })` — mounted on the shared `/api` handler, peer-authenticated by the browser/API cookie, and **403 for any non-owner Peer** (`dsh-client-connection/lib/index.js:840-853`). Good for command endpoints, not for SSE.

---

## 3. Sessions

All via the gateway. Peer first:

    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    const invoke = (namespace, method, args, signal) =>
      ctx.typertGateway.invoke({ namespace, method, args, peer, ...(signal ? { signal } : {}) })

**List** — `session/list`, args `{ _request: {} }` → `{ items: SessionSummary[] }` (`dsh-api-session-controller/lib/types/types.d.ts:136`):

    { sessionId, updatedAt, running, blank, agentAvailable,
      parentSessionId?, origin?: 'subagent', cwd?, formatStatus?,
      projections?: { kind: 'cached'|'sequenced', asOfSeq, values: { title?, … } } }

    const { items } = await invoke('session', 'list', { _request: {} })

The `_request` name is not a typo: the controller's reserved parameter is literally `_request`, and Typert descriptors keep source names (`mobile-gateway/lib/dsh-host-adapter.mjs:71-76`). Every *other* session endpoint wraps its payload as `{ request: … }`.

**Create** — `session/create`, `{ request: { workspaceId?, cwd?, sessionId?, agentPreset? } }` → `{ sessionId, agentPreset? }`. A named `sessionId` is reused while blank; a started or foreign one yields a *new* id — **always read the response id**. Group sessions under one workspace by calling `workspace/create` once (`{ request: { path } }` → `{ workspace: { workspaceId } }`, `dsh-swift-bridge/src/hostapi.js:85-113`).

**History** — open `session/follow` and close it after the first frame; that is the cheapest full read (`dsh-host-adapter.mjs:107-144`):

    const stream = ctx.typertGateway.stream({
      namespace: 'session', method: 'follow', peer, signal,
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: 200, assistantStream: true } },
    })
    const first = await stream[Symbol.asyncIterator]().next()
    // first.value = { type:'snapshot', header, cursor, records:[{type:'event',event}], hasMore, projections }

Older pages: `session/page` with `{ request: { address, throughSeq: cursor, beforeSeq, maxMessages } }` → `{ records, hasMore }`.

**Projections** — `session/projections` `{ request: { sessionId } }` → `{ kind:'sequenced', asOfSeq, values }`. `session/control` (args `{}`) streams one `{ type:'baseline', value:{ projections: { [sessionId]: { asOfSeq, values } } } }` and then `{ type:'projection', sessionId, seq, changes:[{key,val}] }` for every committed event on **any** session. Projection keys are merge-extensible: `title`, `todos`, `goal`, `turnOutline`, `modelSelection`, `inbox`, `agentPreset`, `sessionListMetadata`, `contextUsage`, …

---

## 4. Driving a turn

**Prompt** — `session/prompt`, `{ request: { requestId, sessionId, mode: 'queue'|'steer', content, clientTimeZone? } }` → `{ accepted: true }`:

    await invoke('session', 'prompt', {
      request: {
        requestId: crypto.randomUUID(),          // idempotency key, echoed as inbox rpcId
        sessionId,
        mode: 'queue',                            // 'steer' injects at the next step boundary
        content: [{ type: 'text', text: 'hi' }],
        clientTimeZone: 'Asia/Calcutta',
      },
    })

`requestId` is a real dedupe key: a retry whose id is already queued or logged returns the original acceptance without inserting a second message (session-controller README). Use it on flaky mobile networks.

**Subscribe** — one `session/follow` per watched session. Frames (`types.d.ts:526-537`):

| frame | payload |
|---|---|
| `snapshot` | `{ header, cursor, records, hasMore, projections, assistantStream? }` |
| `event` | `{ type:'event', event: { type, seq, time, data } }` — durable, contiguous |
| `assistant-stream` | `{ type:'assistant-stream', frame: { type:'start'|'chunk'|'end', attemptId, revision, index, chunk?, outcome? } }` — token deltas, **process-local, never durable** |

Durable event types and `data` shapes (`dsh-session/lib/types/types.d.ts:261-396`): `turn/start {turn}`, `turn/end {turn, reason}`, `step/start` / `step/end {turn, step}`, `user/message`, `assistant/message {turn,step,message,stream,usage,interrupted?}`, `assistant/attempt`, `tool/call {turn,step,callId,name,arguments}` (`arguments` is the **raw model JSON string**), `tool/result {message, error?, meta?}`, plus `system/message`, `developer/message`, `request/header`.

Two independent clocks must be validated (`mobile-gateway/lib/session-follower.mjs:16-70`): durable `seq` must be dense (`event.seq === cursor + 1`) and assistant `revision` dense, with `index` dense per attempt. Reconnect with exponential backoff and re-open `follow` for a fresh atomic snapshot; treat `unsupported-session-format`, `session/not-found`, `subagent/*` as permanent and everything else as retryable.

**Busy / queueing.** Three sources: the `running` flag on list rows; `api-session/status(sessionId, running)` as a cordis event (`types.d.ts:636-672`, alongside `api-session/added|removed|activity|error`); and the passive read `session/state` `{ request: { sessionId } }` → `{ cursor, active, running, queue, pendingInput }`. `session/wait` (`{ sessionId, timeoutMs?, afterSeq? }`) long-polls until `idle | input-required | timeout`. You never block a prompt: `mode:'queue'` is accepted while running, and the inbox surfaces as `projections.inbox['next-turn'|'next-step']`.

**Cancel / steer.** `session/cancel` `{ request: { sessionId } }` → `{ accepted: true }` (admission, not completion — wait for `turn/end`). Steer or edit a pending message with `session/updateQueue` `{ request: { sessionId, itemId, action: { kind:'edit', content } | { kind:'remove' } | { kind:'steer' } } }`. Subagents: `subagents/prompt` and `subagents/interruptByParent`, only for `mode:'continuable'`.

---

## 5. Approvals & questions

The host offers them as **cordis waterfalls**, so a plugin can answer instead of the GUI, or race it. The mobile gateway prepends itself and still delegates when no client is subscribed (`mobile-gateway/lib/index.mjs:3367-3437`):

    ctx.on('user-questions/request', (request, next) => {
      const sessionId = String(request.agent?.id ?? '')
      if (!hasClientFor(sessionId)) return next()          // let the GUI answer
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, request })
        publish({ kind: 'question-requested', id, sessionId,
                  questions: request.questions })           // [{ id, header?, question, options:[{label,description?}], multiSelect? }]
        request.signal?.addEventListener('abort', () => {
          const e = new Error('cancelled'); e.code = 'ASK_CANCELLED'; reject(e)
        }, { once: true })
      })
    }, { prepend: true })

    ctx.on('approval/request', (request, next) => {
      if (!hasClientFor(String(request.agent?.id ?? ''))) return next()
      return new Promise(resolve => pendingApprovals.set(rpcId, {
        resolve, sessionId: String(request.agent.id), toolName: request.toolName,
        callId: request.callId, reason: request.reason, displayReason: request.displayReason,
      }))
    }, { prepend: true })

Resolve shapes:

- **Approval** → resolve with the string `'allowed-once'` or `'rejected'`. That is the whole contract (`completeApproval`, line 2609: `pending.resolve(outcome)`).
- **Question** → resolve with `{ answers: [{ id, selected: string[], custom?: string }] }`, one entry per question in order; `selected` values must be offered option labels; single-select accepts at most one and no `custom` alongside a selection. To cancel, **reject** with an `Error` whose `code` is `ASK_CANCELLED` (or `ASK_ABORTED` when the caller's signal fired) and set `name = 'UserQuestionError'`.

Practicalities: a duplicate answer is a no-op (guard with `if (pending.get(id) !== pending) return false`); when the last remote client disconnects you must fall back — call `next()` / resolve with the downstream value, or cancel — otherwise a turn hangs forever. `request.signal` aborts when the GUI or the agent gives up, and *that* is what removes your sheet.

---

## 6. Models & commands

- `session/modelCatalog` (args `{}`) → `{ default: {provider, model, reasoningEffort?}, routableProviders, groups: ModelProviderGroup[], failures: [] }` (`types.d.ts:79-124`). The per-session current selection lives in `projections.modelSelection.next`.
- `session/selectModel` `{ request: { sessionId, provider, model, reasoningEffort? } }` → `{ selected }`; rejects `session/model-unavailable` when the pair is not in the catalog.
- `llm/listConfigurableProviders` → provider rows for a settings UI.
- `commands/list` `{ agentId: sessionId }` → slash commands and skills for the composer; `commands/execute` `{ agentId, line, submittedAttachments }`.
- `skills/list` `{ request: { sessionId } }` → `{ skills: [{ name, description, whenToUse?, path?, modelInvocable }] }`.
- `agentPresets/list` and `agentPresets/select` `{ agentId, agentPreset }`. Presets lock once a session has started — the reference checks `sessionListMetadata.blank` / `lastPromptAt` first.

---

## 7. Auth / identity

**The gateway never authenticates anyone.** Identity is the `Peer` you construct:

    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })

- `principal: { kind:'owner' }` is the local operator with full authority: the gateway makes **no** `remoteAccess` decisions for owner calls. Any remote client you authenticate inherits exactly that — your token *is* the security boundary.
- `interactions: 'answer'` is required to take part in `$events` / Remote waterfalls; `'none'` still allows unary calls and streams. The mobile gateway uses `'none'` precisely because it answers approvals through local cordis listeners (§5) instead of remote ones.
- Peers are disposed with the reading Context or via `peer.dispose()`; dispatch from a disposed peer fails `gateway/peer-disposed`.

**Do not reuse the browser cookie.** `client-connection`'s cookie is authority-bound (hostname + port), signed from the `client-connection/browser-session` credential, `HttpOnly` / `SameSite=Strict`, and minted only by `authorizeIndex` / `authorizeConnect`. It belongs to the GUI.

Two proven patterns:

1. **Persisted bearer token** (`dsh-swift-bridge/src/token.js`): mint once with `randomBytes(32).toString('hex')`, write atomically at `dshHomePath('swift-bridge-token')` with mode `0600`, compare with `crypto.timingSafeEqual`. The client reads the file once at launch — no copy-paste, survives restarts. `resolveToken()` prefers an env/config-pinned token, else the file, else a fresh one.
2. **Paired device credentials** (`mobile-gateway/lib/devices.js`): 256-bit tokens (43-char base64url) shown once via QR pairing with a 5-minute TTL, **only SHA-256 digests persisted** (`{version:3, devices:[{id,name,clientDeviceId,tokenHash,createdAt,lastSeenAt}]}`, mode `0600`), hex `timingSafeEqual` on every connect.

Transport: the gateway accepts `Authorization: Bearer <43 chars>`, or the token in `Sec-WebSocket-Protocol` (never echoed back as the negotiated protocol). For SSE, `Authorization` plus a same-origin check (`isSameOrigin`, line 2170) is enough. Keep admin routes `adminLoopbackOnly` and fail closed — the reference defaults are `gatewayEnabled: false, requireAuth: true`.

---

## 8. Gotchas

- **`engines.dsh` wins over `peerDependencies`, and a mismatch silently disables you** (stderr only, at boot). Prereleases participate (`includePrerelease: true`), so `^0.2.1-rc.2` covers `0.2.2-rc.1`. Exemptions are per exact `name@version` plus exact runtime version in `<profile>/compatibility.json`.
- **The installed runtime here is `dsh 0.2.2-rc.1` on Node 24.18.0.** The reference adapter pins `DSH_VERSION = '0.2.1-rc.2'` and `SESSION_FORMAT_VERSION = 4`; the follow snapshot is rejected when `header.version !== 4`. Treat the **session format version**, not the product version, as your compatibility contract.
- **ESM only.** `"type": "module"`, real `import` statements, `node:` prefixes. The module is imported once at profile boot; **editing plugin source does not hot-reload** — restart `dsh web`. No file watcher exists in the boot path (I grepped `dsh-app-boot` and `cordis-plugin-loader`); the profile's `dsh.profile.patchReload: "live"` is not read by any installed lib, so do not depend on it. The only live path is the plugin-manager Remotes (`pluginManager/setPluginEnabled`).
- **Never touch host config.** Do not write `cordis.yml` (deliberately `[]`), do not rewrite `cordis.patch.yml` from inside the plugin, do not register the fallback seat (owned by `frontend-static`), and do not re-register an existing `(kind, path)` (throws). **Only `/api` is authenticated**; sharing the port grants nothing.
- **`session/list` uses `_request`; everything else uses `request`.** Getting this wrong fails argument validation with `gateway/input-invalid`.
- **Streams are `AsyncIterable`s bound to an `AbortSignal`.** Always `iterator.return()` in a `finally` *after* aborting — "the producer may be waiting for another event" (`session-follower.mjs:126-128`). Never share one signal across a reconnect.
- **`tool/call.arguments` is a raw JSON string**, not an object. Parse defensively.
- **Logging:** `const logger = ctx.logger ?? console` — `ctx.logger` is not guaranteed on every Context. Keep it off the hot path (a file append per line is fine at turn granularity, not per token).
- **Config defaults must be fail-closed.** A bundle install must never open an unauthenticated control plane.
- **Payload limits:** `/api` buffers up to 300 MiB; your own raw route gets whatever you choose to read. Cap frames (reference: 8 MiB) and reject binary WS frames explicitly.

---

## Reference map

| File | What to copy |
|---|---|
| `dsh-swift-bridge/index.js` | entry module, `inject`, `ctx.effect` route registration, discovery route |
| `dsh-swift-bridge/src/hostapi.js` | `createPeer` + `gateway.invoke`, workspace bootstrap, follow wiring, failure mapping |
| `dsh-swift-bridge/src/token.js` | token mint / atomic persist / constant-time verify |
| `dsh-swift-bridge/src/server.js` | WS carrier state machine (hello deadline, ping/pong, single active socket) |
| `dsh-plugin-mobile-gateway/lib/dsh-host-adapter.mjs` | **the** endpoint table: every namespace/method/arg shape |
| `dsh-plugin-mobile-gateway/lib/session-follower.mjs` | follow decoder, seq/revision gap rules, backoff |
| `dsh-plugin-mobile-gateway/lib/index.mjs:3367-3437` | approval/question waterfalls, fallback semantics |
| `dsh-plugin-mobile-gateway/lib/devices.js` | paired-device credential store |
| `dsh-host-webserver/lib/index.js:375-411` | `register` / `registerUpgrade` / `registerFallback` |
| `dsh-client-hmr/lib/index.js:124-152` | the shipped SSE handler pattern |
| `dsh-api-session-controller/lib/types/types.d.ts` | authoritative request/response/frame types |
