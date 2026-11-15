#!/bin/bash
set -euo pipefail

# Pterodactyl installation container; server volume is mounted at /mnt/server.
mkdir -p /mnt/server
cd /mnt/server

# Permite instalar mesmo em nodes sem DNS quando o binário foi enviado por
# SFTP. Sem isso, um reinstall tentaria baixar de novo e falharia.
cat > /mnt/server/livekit-start.sh <<'ONDA_START'
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
ONDA_START
chmod 755 /mnt/server/livekit-start.sh

if [ -x /mnt/server/livekit-server ]; then
    echo "livekit-server já existe em /mnt/server; pulando download."
    exit 0
fi

apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl tar

VERSION="1.13.11"
case "$(uname -m)" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7l|armv7)  ARCH="armv7" ;;
    *)
        echo "Arquitetura não suportada: $(uname -m)" >&2
        exit 1
        ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/livekit/livekit/releases/download/v${VERSION}/livekit_${VERSION}_linux_${ARCH}.tar.gz"
echo "Baixando ${URL}"
if ! curl --retry 3 --connect-timeout 10 --max-time 180 -fsSL "$URL" -o "$TMP/livekit.tar.gz"; then
    echo "-----------------------------------------" >&2
    echo "Falha ao baixar o LiveKit (DNS/rede do node)." >&2
    echo "Baixe em uma máquina com internet:" >&2
    echo "  ${URL}" >&2
    echo "Extraia 'livekit-server' e envie para /home/container/livekit-server via SFTP." >&2
    echo "Depois aplique permissão 755: chmod 755 /home/container/livekit-server" >&2
    echo "-----------------------------------------" >&2
    exit 1
fi

tar -xzf "$TMP/livekit.tar.gz" -C /mnt/server livekit-server
chmod +x /mnt/server/livekit-server

echo "-----------------------------------------"
echo "LiveKit ${VERSION} instalado em /mnt/server/livekit-server"
echo "Crie as alocações de signaling, RTC/TCP e RTC/UDP antes de iniciar."
echo "As opções de inicialização ficam nas variáveis do egg."
echo "-----------------------------------------"
