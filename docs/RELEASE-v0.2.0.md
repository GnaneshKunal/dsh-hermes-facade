# v0.2.0

A DSH host plugin that makes your DeepSeek Harness look like a **hermes-webui** server, so the
stock [Hermex](https://apps.apple.com/us/app/hermex/id6767006319) iOS app drives your own agent.

## Upgrade

```bash
dsh plugin --profile web add dsh-hermes-facade
```

Keep `dsh-hermes-facade` in the `web` profile's `dsh.profile.bundles` list, restart
`dsh web`, then sign in with the password printed at boot (stored hashed at
`~/.dsh/hermes-facade/password.json`). If the host is already running with dsh-hmr, saving the
plugin files reloads it between turns without a restart.

Expose it tailnet-only:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:9120
```

In Hermex, add the server at `https://<machine>.<tailnet>.ts.net:9443` (or the plain-HTTP LAN
address), and answer the Local Network prompt.

## What's new since v0.1.0

### Phone-visible

- **Tool results in reloaded transcripts.** Reopening a chat now draws completed tool cards with
  their output, error verdict, duration and the assistant message they belong to. Arguments stay
  on the message, so a 300-call transcript ships ~160 KB instead of ~840 KB.
- **Transcript paging.** The first page is 200 messages and scrolling back pages through the
  newest 800 instead of stopping at 50.
- **The model picker applies.** `session/update`, `session/new` and `chat/start` resolve the
  picked id/provider against the DSH catalog, carry the reasoning effort over (or fall back to the
  model's declared default), and answer 400 with the catalog error when the model is unavailable.
- **Failed and cancelled turns report themselves.** `turn/end.reason` now maps to `error` /
  `cancel` instead of always `done`, so a failed run no longer looks successful.
- **Pin / archive visibility.** Rows carry real pinned/archived flags; archived sessions are
  hidden by default and served with `include_archived=1` (plus `archived_limit`) for the
  Archived screen.
- **Export / share.** `GET /api/session/export` answers JSON (default), HTML or markdown with a
  share-sheet filename; the JSON form is the one Move to Hermes imports.
- **Live models and providers.** `/api/models/live` overlays the cached catalog and
  `/api/providers` derives provider cards from it.
- **Approvals and clarifications survive reconnects.** Pending/initial payloads carry the command
  and description (approvals) or the question and choices (clarifications); a resolved or timed-out
  prompt is retracted on both streams, answering a resolved approval returns `409 {"stale":true}`,
  and "Allow session"/"Always allow" are remembered by the facade instead of collapsing to once.
- **Subagent sessions stay internal.** DSH child-agent sessions are hidden from the list (they are
  runner-owned and only addressable through their durable parent). docs/05 records the toggle path
  for a future release.

### Correctness and internals

- Reasoning effort reads the real `{lastUsed, next|pending}` projection and translates stale
  client spellings instead of rejecting them.
- Finished stream journals are pruned past the replay window (30 min) and capped at 64, so they no
  longer accumulate for the process lifetime.
- Reads are bounded (8 s) with cached catalog/workspace baselines; the plugin's disposer awaits its
  port release so a reload cannot hit EADDRINUSE.
- `/health` reports `features` (history-paging, tool-results, model-switch, session-export,
  pin-archive, providers, approval-retract, clarify-markers) for build verification.

## Tests

140 tests, `npm run check` clean. The suite covers the mapper, HTTP/SSE integration, the real host
adapter (model resolution, approvals, clarifications), the mock host and the plugin entry.

## Known limits

See [docs/05-compatibility-matrix.md](docs/05-compatibility-matrix.md) for the full matrix. The
important ones: a started session's cwd cannot change (workspace switch groups only), profile and
attachment fields on chat start are still ignored, history is bounded at 800 messages, approval
grants are keyed by tool name (no command pattern), and a clarification batch surfaces one question.
