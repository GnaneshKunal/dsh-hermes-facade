#!/usr/bin/env bash
# Restart the dsh web host that serves the GUI, the facade and this very agent.
#
# Killing dsh kills the agent that asked for the restart, so this runs detached
# and does the whole cycle itself: stop, wait for the port, relaunch in the same
# tmux pane, wait for health.
#
#   bash scripts/restart-dsh.sh --delay 20
#   bash scripts/restart-dsh.sh --dry-run
set -u

DELAY=20
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delay) DELAY="${2:-20}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) shift ;;
  esac
done

LOG=/tmp/dsh-restart.log
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }

TMUX_SESSION=0
TMUX_PANE=0:0.0
TRUSTED=gnaneshs-macbook-pro.tailc03322.ts.net
DSH_BIN=/Users/gnanesh/.bun/bin/dsh
WORKDIR=/private/tmp
WEB_PORT=3080

# macOS pgrep here does not match the full argv of this process, so ask ps.
find_pid() {
  ps -Ao pid,command | grep -F 'dsh web --trusted-host' | grep -v grep | awk '{print $1}' | head -1
}

PID=$(find_pid)
if [ -z "${PID:-}" ]; then log "no dsh web process found; nothing to do"; exit 0; fi

log "delay ${DELAY}s, target pid ${PID}"
if [ "$DRY" = "1" ]; then
  log "DRY RUN: would kill ${PID}, wait for :${WEB_PORT}, send '$DSH_BIN web --trusted-host $TRUSTED --no-open' to tmux ${TMUX_PANE}"
  exit 0
fi

sleep "$DELAY"

log "stopping ${PID}"
kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  log "still alive after 15s; SIGKILL"
  kill -KILL "$PID" 2>/dev/null || true
  sleep 1
fi

for _ in $(seq 1 20); do
  if ! lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.5
done
log "port $WEB_PORT released"

cd "$WORKDIR" || true

# Preferred: reuse the tmux pane, so the host keeps living where the user expects.
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  log "relaunching in tmux $TMUX_PANE"
  tmux send-keys -t "$TMUX_PANE" "$DSH_BIN web --trusted-host $TRUSTED --no-open" Enter
else
  log "tmux session missing; relaunching detached"
  nohup "$DSH_BIN" web --trusted-host "$TRUSTED" --no-open >> /tmp/dsh-web.out 2>&1 &
fi

FALLBACK_DONE=0
for i in $(seq 1 120); do
  if [ "$i" = "40" ] && [ "$FALLBACK_DONE" = "0" ]; then
    # tvn send-keys did not take (pane busy, shell gone): start it detached.
    if ! lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      log "tmux relaunch did not take after 40s; starting detached"
      nohup "$DSH_BIN" web --trusted-host "$TRUSTED" --no-open >> /tmp/dsh-web.out 2>&1 &
      FALLBACK_DONE=1
    fi
  fi
  if curl -sf --max-time 2 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then
    log "host is back on :$WEB_PORT"
    NEWPID=$(find_pid)
    log "new pid ${NEWPID:-unknown}"
    for _ in $(seq 1 60); do
      if curl -sf --max-time 2 "http://127.0.0.1:9120/health" >/dev/null 2>&1; then
        log "hermes facade is back on :9120"
        exit 0
      fi
      sleep 1
    done
    log "host is up but the facade did not answer on :9120 within 60s"
    exit 0
  fi
  sleep 1
done

log "host did not come back within 120s; check /tmp/dsh-web.out"
exit 1
