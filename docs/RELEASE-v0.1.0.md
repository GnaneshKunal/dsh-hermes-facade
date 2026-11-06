# v0.1.0

A DSH host plugin that makes your DeepSeek Harness look like a **hermes-webui** server, so the
stock [Hermex](https://apps.apple.com/us/app/hermex/id6767006319) iOS app drives your own agent.

## Install

```bash
dsh plugin --profile web add dsh-hermes-facade
```

Add it to the `web` profile's bundle list, restart `dsh web`, then read the generated password
from the boot log (stored hashed at `~/.dsh/hermes-facade/password.json`).

Expose it tailnet-only:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:9120
```

In Hermex, add the server at `https://<machine>.<tailnet>.ts.net:9443` (or the plain-HTTP LAN
address), and answer the Local Network prompt.

## What works

Sessions, streaming tokens, thinking, tool cards, stop, approvals, clarifications, the model and
effort pickers, workspaces as projects, media, and rename/pin/archive/branch. Unsupported screens
render an empty state; unsupported actions answer a message, never a 404 banner.

See the support matrix in `docs/00-DESIGN.md`.
