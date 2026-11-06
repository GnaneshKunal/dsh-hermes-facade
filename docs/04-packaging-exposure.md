# 04 — Packaging & Exposure

*Verified on this Mac, 2026-11-06: DSH `0.2.2-rc.1`, Node `v24.18.0`, Tailscale `1.102.4`,
host `gnaneshs-macbook-pro.tailc03322.ts.net`.*

## 0. What is already on this box

```
$ tailscale serve status
https://gnaneshs-macbook-pro.tailc03322.ts.net       (Funnel on)    -> 127.0.0.1:3080
https://gnaneshs-macbook-pro.tailc03322.ts.net:8443  (tailnet only) -> 127.0.0.1:3081
```

| Port | Bind | Owner |
|---|---|---|
| 3080 | `127.0.0.1` | `dsh web` — host webserver + `/api` RPC |
| 3081 | `*` | mobile gateway (`dsh-plugin-mobile-gateway`) |
| 8791, 9230 | `127.0.0.1` | DSH internals |
| 9120, 9443 | — | **free**, verified via `lsof -nP -iTCP` |

## 1. Plugin package layout

Repo root `~/self/dsh-hermexxx` (a symlink to `~/self/dsh-hermes-facade`, so `link:` resolves),
installed into the profile as a `link:` dependency.

```
dsh-hermexxx/
├── package.json
├── cordis.patch.yml
├── index.js                 # cordis entry: name / inject / apply(ctx, config)
├── src/
│   ├── server.mjs           # node:http listener, route table, redacted logging
│   ├── auth.mjs             # scrypt verify, HMAC cookie, constant-time compare
│   ├── ratelimit.mjs        # per-IP + per-credential token bucket
│   ├── sse.mjs              # frame writer, heartbeat, cancel
│   ├── config.mjs           # Schemastery schema
│   └── routes/{auth,status,sessions,chat,approval}.mjs
├── test/*.test.mjs
├── scripts/hermex-smoke.sh
├── README.md
└── LICENSE                  # MIT
```

`package.json` — the fields that matter:

```json
{
  "name": "@gnanesh/dsh-hermexxx",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "src", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=22", "dsh": "^0.2.2-rc.1" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/dsh-api-gateway": "^0.2.2-rc.1",
    "@deepseek-ai/dsh-api-session-controller": "^0.2.2-rc.1",
    "@deepseek-ai/dsh-home-paths": "^0.2.2-rc.1",
    "@deepseek-ai/dsh-session": "^0.2.2-rc.1",
    "@deepseek-ai/schemastery": "~3.19.0"
  }
}
```

* **No `dsh.client`.** That field injects a browser bundle into the Web GUI (`platform: web`, as in
  `dsh-claude-mobile`); Hermex is native and needs no GUI asset.
* **`dsh.bundle.patch` is not self-activating.** `dsh-swift-bridge` sits symlinked in
  `~/.dsh/profiles/web/node_modules/` yet answers `404`: it is absent from `dsh.profile.bundles`.
  *Install ≠ enable* (§6).
* **Peer ranges follow the house style** (`dsh-interconnect` uses `*`, `dsh-swift-bridge` carets).
  We pin the installed `^0.2.2-rc.1` so a DSH bump fails at install, not at dispatch.
  `dsh-host-webserver` is a peer **only** for option (b).

`cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: hermexxx
      name: '@gnanesh/dsh-hermexxx'
      config:
        enabled: true
        port: 9120
        bindHost: 127.0.0.1
        publicOrigin: https://gnaneshs-macbook-pro.tailc03322.ts.net:9443
        passwordFile: !!js process.env.DSH_HERMEX_PASSWORD_FILE
```

## 2. Port / binding decision

Hermex takes one **base URL** and appends `/api/...`, so the facade needs a stable origin.

**(b) Mounting under :3080 is disqualified** — measured:

* `/api` is DSH's own RPC namespace. `@deepseek-ai/dsh-api-gateway` intercepts `/api` and claims
  endpoint names dynamically (`claimsEndpoint`); `/api/remote.mux` is its stream mux. Every path
  under it — including `/api/hermes` — answers `401 unauthorized`. It is an auth fence, not a
  free prefix.
* That fence also validates Host/Origin, widened by `dsh web --trusted-host` (currently the tailnet
  name). Our cookie auth would sit *inside* DSH's browser-trust fence — two auth systems on one
  prefix.
* `webServer.register({kind, path, handler})` *would* accept a prefix (`/hermes`; exact → longest
  prefix → fallback; duplicates throw) — but see below.
* **The killer: :3080 is already public.** Funnel is ON for 443 → `127.0.0.1:3080`, so a plugin bug
  there is a public bug.

**(a) Own port 9120 — recommended.** Bind `127.0.0.1:9120`, never `0.0.0.0` (that would expose the
LAN too). Serve terminates TLS and gates the tailnet. This is the mobile gateway's posture — its own
listener, commented *"DSH WebUI remains loopback-only on 3080."* Cost: one process, one `serve` rule.

**Contract:** base URL `https://gnaneshs-macbook-pro.tailc03322.ts.net:9443`; the facade owns that
origin and `/api/*` outright.

## 3. Tailscale exposure

```zsh
# add — background, tailnet-only
tailscale serve --bg --https=9443 http://127.0.0.1:9120

# check
tailscale serve status
tailscale serve status --json

# remove ONLY this handler (target optional, all original flags required)
tailscale serve --https=9443 off

# NOT this — it also wipes Funnel and 8443:
# tailscale serve reset
```

**Funnel may only listen on 443, 8443 and 10000; Serve is unrestricted**, so 9443 is legal and free.
A port cannot be both — *"if the most recent command was `serve`, the port will be completely
private."* Port forwarding needs no `sudo`; only file/directory serving does.

**Why tailnet-only, not Funnel.** Funnel publishes to the open internet with no tailnet identity —
the password would be the only barrier. ⚠️ **The 443 Funnel already exposes the DSH Web UI publicly
at `https://…ts.net`; that standing exposure is independent of this plugin.**

Phone: base URL `https://gnaneshs-macbook-pro.tailc03322.ts.net:9443` → Hermex calls
`…:9443/api/status`, `…:9443/api/chat/stream`. MagicDNS must resolve on the phone; the raw
`http://100.114.12.18:9120` is no substitute — Serve provides the cert and the name.

## 4. Security

* **Password → verifier.** Provision `DSH_HERMEX_PASSWORD` once; persist only
  `scrypt(password, salt, 32)` to `~/.dsh/hermexxx/password.hash` (`0600`). Compare derived keys with
  `crypto.timingSafeEqual` on equal-length buffers (length guard first) — never raw passwords. A
  missing hash fails closed with `503`, never "no auth".
* **Signed cookie.** `base64url(payload).base64url(HMAC-SHA256(payload))` over `{sub, exp, iat, v}`;
  32-byte secret at `~/.dsh/hermexxx/cookie.secret` (`0600`). Attributes:
  `HttpOnly; SameSite=Strict; Path=/`, `Max-Age=2592000`, and `Secure` **only for HTTPS requests**
  (`X-Forwarded-Proto: https` or TLS socket). Hard-coding `Secure`/`__Host-` makes every
  `http://127.0.0.1:9120` curl test silently cookie-less. The token is also accepted as
  `Authorization: Bearer` for scripted clients.
* **Login rate limit.** Token bucket per IP *and* per credential: 5 attempts / 15 min, then `429` +
  `Retry-After`. Failures cost a full scrypt derivation.
* **No secrets in logs.** One line per request: `ts reqId method path status ms ip`. Redact
  `password`, `cookie`, `set-cookie`, `authorization`; never log the hash, cookie secret, or derived
  token. Bodies are never logged.
* **Shared tailnet.** Node sharing or a stale member device reaches 9443. The tailnet is an *outer*
  boundary we do not administer; the password is the real one. Restrict `:9443` by ACL grant to the
  phone's node/tag and rotate on device loss.

## 5. Test plan

```zsh
BASE=http://127.0.0.1:9120
JAR=$(mktemp -t hermex)

# 1 auth/status unauth -> 401 {"error":"unauthorized"}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/status                 # 401

# 2 login -> 200 {"ok":true} + Set-Cookie
curl -s -c $JAR -H 'content-type: application/json' \
  -d '{"password":"'"$DSH_HERMEX_PASSWORD"'"}' $BASE/api/login | grep -q '"ok":true'

# 3 status -> 200 {"ok":true,"version":…,"capabilities":[…]}
curl -s -b $JAR -w '\n%{http_code}\n' $BASE/api/status

# 4 sessions -> 200 {"sessions":[…]}  (exits non-zero if the shape drifts)
curl -s -b $JAR $BASE/api/sessions | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!Array.isArray(j.sessions))process.exit(1);console.log(j.sessions.length+" sessions")})'

# 5 chat/start -> 201 {"chatId":"…"}
CHAT=$(curl -s -b $JAR -H 'content-type: application/json' \
  -d '{"sessionId":"…","prompt":"say hi"}' $BASE/api/chat/start \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).chatId')

# 6 chat/stream -> 200 text/event-stream, frames "event: X\ndata: {json}\n\n"
curl -sN -b $JAR "$BASE/api/chat/stream?chatId=$CHAT" | tee /tmp/hermex.sse | head -20
grep -c '^data: ' /tmp/hermex.sse ; grep -q '^event: done' /tmp/hermex.sse

# 7 approval/respond -> 200 {"ok":true}
curl -s -b $JAR -H 'content-type: application/json' \
  -d '{"approvalId":"…","decision":"allow"}' $BASE/api/approval/respond

# 8 cancel -> 200 {"ok":true}
curl -s -b $JAR -X POST "$BASE/api/chat/cancel?chatId=$CHAT"

# negatives
curl -s -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  -d '{"password":"x"}' $BASE/api/login                                  # 401
for i in {1..6}; do curl -s -o /dev/null -w '%{http_code} ' \
  -H 'content-type: application/json' -d '{"password":"x"}' $BASE/api/login; done   # …429
```

SSE must assert: `content-type: text/event-stream`; every frame ends `\n\n`; a comment-only
keepalive within 15 s; `event: done` exactly once, then EOF; a mid-stream `cancel` ends with
`event: cancelled`, not `done`.

**SSE parser one-liner** (`event` + `data` per frame):

```zsh
curl -sN -b "$JAR" "$BASE/api/chat/stream?chatId=$CHAT" \
 | awk 'BEGIN{RS="\n\n"} {e="";d="";n=split($0,L,"\n");for(i=1;i<=n;i++){if(L[i]~/^event: /)e=substr(L[i],8);else if(L[i]~/^data: /)d=substr(L[i],7)} if(e!=""||d!="")printf "%-10s %s\n",e,d}'
```

**Through Tailscale** — from the phone or another tailnet node, not this Mac:

```zsh
TS=https://gnaneshs-macbook-pro.tailc03322.ts.net:9443
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' $TS/api/status   # 401 0 — no -k
curl -sS -c /tmp/ts.jar -H 'content-type: application/json' -d '{"password":"…"}' $TS/api/login
curl -sS -b /tmp/ts.jar -N "$TS/api/chat/stream?chatId=$CHAT" | head -3
```

`000` = Serve down or port missing from `tailscale serve status`; `502` = Serve up, facade down.

## 6. Runbook

```zsh
# INSTALL — pnpm turns this into link:/Users/gnanesh/self/dsh-hermexxx
dsh plugin --profile web add /Users/gnanesh/self/dsh-hermexxx

# ENABLE — install is not enable: add the package to
# ~/.dsh/profiles/web/package.json -> dsh.profile.bundles, or insert the §1 row
# into ~/.dsh/profiles/web/cordis.patch.yml ("patchReload": "live" here, so a
# patch edit may apply without a restart).

# RESTART — foreground process, no LaunchAgent
kill 77285                                   # or Ctrl-C in its terminal
cd ~ && node /Users/gnanesh/.bun/bin/dsh web \
  --trusted-host gnaneshs-macbook-pro.tailc03322.ts.net --no-open

# DISABLE — set config.enabled: false (apply() returns without binding 9120);
# remove the row to unload entirely.

# LOGS
tail -f ~/.dsh/logs/hermexxx.log              # ours, 0600, rotated at 10 MB

# VERIFY
lsof -nP -iTCP:9120 -sTCP:LISTEN              # listening on 127.0.0.1
tailscale serve status                        # :9443 -> 127.0.0.1:9120

# UNINSTALL
dsh plugin --profile web remove @gnanesh/dsh-hermexxx
tailscale serve --https=9443 off              # only our rule, not "reset"

# ROTATE PASSWORD — no restart; hash re-read per login
export DSH_HERMEX_PASSWORD='new-…'
node -e 'const{scryptSync,randomBytes}=require("node:crypto"),f=process.env.HOME+"/.dsh/hermexxx/password.hash",s=randomBytes(16);require("node:fs").writeFileSync(f,s.toString("hex")+":"+scryptSync(process.env.DSH_HERMEX_PASSWORD,s,32).toString("hex"),{mode:0o600})'
# cookies survive until expiry — bump cookie.secret (the "v" claim) to revoke all sessions
```

## 7. Risks

1. **Funnel 443 → :3080 exposes the DSH Web UI to the internet today** — pre-existing and unrelated
   to this plugin.
2. `--trusted-host` admits the tailnet name at DSH's `/api` fence; revisit if Funnel stays on.
3. `tailscale serve reset` wipes Funnel and 8443 — hence `--https=9443 off` above.
