#!/bin/bash
set -euo pipefail

# Pterodactyl install container mounts the server volume at /mnt/server.
apt-get update -y
apt-get install -y --no-install-recommends git ca-certificates curl

mkdir -p /mnt/server
cd /mnt/server

if [ "${USER_UPLOAD:-0}" = "1" ] || [ "${USER_UPLOAD:-0}" = "true" ]; then
    echo "Upload skipped: USER_UPLOAD=1. O start.sh deve estar em /home/container/start.sh."
    exit 0
fi

if [ -z "${GIT_ADDRESS:-}" ]; then
    echo "GIT_ADDRESS is required. Set the repository URL in the egg variables."
    exit 1
fi

rm -rf source app
if ! echo "${GIT_ADDRESS}" | grep -q '\.git$'; then
    GIT_ADDRESS="${GIT_ADDRESS}.git"
fi

if [ -n "${BRANCH:-}" ]; then
    git clone --depth 1 --single-branch --branch "${BRANCH}" "${GIT_ADDRESS}" source
else
    git clone --depth 1 "${GIT_ADDRESS}" source
fi

# The app is compiled on startup by the .NET 10 runtime image. This keeps the
# install independent from a .NET SDK being present in the installer image.
install -m 0755 "source/${PROJECT_DIR:-.}/deploy/pterodactyl/start.sh" /mnt/server/start.sh

echo "-----------------------------------------"
echo "Onda clonada em /mnt/server/source"
echo "O start.sh compila e inicia o app no primeiro boot."
echo "Configure as variáveis de LiveKit/TURN e inicie o servidor."
echo "-----------------------------------------"
