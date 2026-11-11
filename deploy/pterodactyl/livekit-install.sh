#!/bin/bash
set -euo pipefail

# Pterodactyl installation container; server volume is mounted at /mnt/server.
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

mkdir -p /mnt/server
cd /mnt/server

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/livekit/livekit/releases/download/v${VERSION}/livekit_${VERSION}_linux_${ARCH}.tar.gz"
echo "Baixando ${URL}"
curl -fsSL "$URL" -o "$TMP/livekit.tar.gz"
tar -xzf "$TMP/livekit.tar.gz" -C /mnt/server livekit-server
chmod +x /mnt/server/livekit-server

echo "-----------------------------------------"
echo "LiveKit ${VERSION} instalado em /mnt/server/livekit-server"
echo "Crie as alocações de signaling, RTC/TCP e RTC/UDP antes de iniciar."
echo "-----------------------------------------"
