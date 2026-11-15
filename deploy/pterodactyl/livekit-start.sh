#!/bin/bash
set -u
cd /home/container

# Primeiro SIGINT/SIGTERM inicia o desligamento normal do LiveKit. Se os
# participantes não saírem dentro da carência, um segundo SIGINT força a saída.
grace="${SHUTDOWN_GRACE_SECONDS:-10}"
args=(
  --bind 0.0.0.0
  --port "${SERVER_PORT:-7880}"
  --rtc.tcp_port "${RTC_TCP_PORT:-7881}"
  --udp-port "${RTC_UDP_PORT:-7882}"
)

if [ -n "${NODE_IP:-}" ]; then
  args+=(--node-ip "${NODE_IP}")
fi

if [ -n "${LIVEKIT_EXTRA_ARGS:-}" ]; then
  read -r -a extra_args <<< "${LIVEKIT_EXTRA_ARGS}"
  args+=("${extra_args[@]}")
fi

./livekit-server "${args[@]}" &
pid=$!
forwarded=0

shutdown() {
  if [ "$forwarded" -eq 0 ]; then
    forwarded=1
    kill -INT "$pid" 2>/dev/null || true
    (
      sleep "$grace"
      kill -INT "$pid" 2>/dev/null || true
    ) &
  else
    kill -INT "$pid" 2>/dev/null || true
  fi
}

trap shutdown INT TERM

wait "$pid"
status=$?
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid"
  status=$?
done
exit "$status"
