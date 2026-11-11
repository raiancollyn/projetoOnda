#!/bin/sh
set -eu

# Coturn's image starts as a regular program, but the Onda stack runs it
# behind Docker. The relay range is intentionally small and is mirrored in
# docker-compose.yml (49160-49200/udp). For a larger deployment, widen
# TURN_MIN_PORT/TURN_MAX_PORT and publish the matching range.
exec turnserver \
  -n \
  --log-file=stdout \
  --fingerprint \
  --lt-cred-mech \
  --realm="${TURN_REALM:-onda}" \
  --user="${TURN_USERNAME}:${TURN_PASSWORD}" \
  --listening-port=3478 \
  --external-ip="${TURN_EXTERNAL_IP}" \
  --min-port="${TURN_MIN_PORT:-49160}" \
  --max-port="${TURN_MAX_PORT:-49200}" \
  --no-cli \
  --no-multicast-peers \
  --no-tls \
  --no-dtls
