#!/bin/bash
set -euo pipefail

# Pterodactyl installation container; server volume is mounted at /mnt/server.
mkdir -p /mnt/server
cd /mnt/server

# Permite instalar mesmo em nodes sem DNS quando o binário foi enviado por
# SFTP. Sem isso, um reinstall tentaria baixar de novo e falharia.
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
echo "-----------------------------------------"
