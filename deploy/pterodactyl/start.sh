#!/bin/bash
set -euo pipefail

# Pterodactyl sets SERVER_PORT to the primary allocation.
PORT="${SERVER_PORT:-8080}"
SOURCE_ROOT="/home/container/source/${PROJECT_DIR:-Onda}"
APP_ROOT="/home/container/app"

if [ ! -f "${SOURCE_ROOT}/Onda.csproj" ]; then
    echo "Onda.csproj não encontrado em ${SOURCE_ROOT}. Reinstale o servidor pelo painel." >&2
    exit 1
fi

# O runtime .NET 10 do Pterodactyl inclui o SDK. Compilar no boot mantém o egg
# independente de uma imagem de build específica; o processo final é executado
# diretamente para receber o sinal de parada do Wings.
rm -rf "${APP_ROOT}"
dotnet publish "${SOURCE_ROOT}/Onda.csproj" \
  -c Release \
  -o "${APP_ROOT}" \
  /p:UseAppHost=false

exec env \
  "ASPNETCORE_ENVIRONMENT=Production" \
  "ASPNETCORE_URLS=http://0.0.0.0:${PORT}" \
  "ASPNETCORE_FORWARDEDHEADERS_ENABLED=true" \
  "HttpsRedirection__Enabled=false" \
  "App__PublicUrl=${APP_PUBLIC_URL:-}" \
  "Storage__DatabasePath=${DATABASE_PATH:-/home/container/data/onda.db}" \
  "Media__Provider=LiveKit" \
  "Media__MaxParticipants=${MAX_PARTICIPANTS:-25}" \
  "Media__LiveKit__Url=${LIVEKIT_URL:-}" \
  "Media__LiveKit__ApiKey=${LIVEKIT_API_KEY:-}" \
  "Media__LiveKit__ApiSecret=${LIVEKIT_API_SECRET:-}" \
  "Media__LiveKit__TokenTtlHours=${LIVEKIT_TOKEN_TTL_HOURS:-6}" \
  "Media__IceServers__0__Urls__0=${TURN_URL:-}" \
  "Media__IceServers__0__Username=${TURN_USERNAME:-}" \
  "Media__IceServers__0__Credential=${TURN_PASSWORD:-}" \
  "Media__IceServers__1__Urls__0=stun:stun.l.google.com:19302" \
  "Media__IceServers__1__Urls__1=stun:stun.cloudflare.com:3478" \
  dotnet "${APP_ROOT}/Onda.dll" \
    --contentRoot "${APP_ROOT}" \
    --urls "http://0.0.0.0:${PORT}"
