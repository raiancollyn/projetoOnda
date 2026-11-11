#!/bin/bash
set -euo pipefail

# Pterodactyl sets SERVER_PORT to the primary allocation.
PORT="${SERVER_PORT:-8080}"
REPO_ROOT="/home/container/source"
SOURCE_ROOT="${REPO_ROOT}/${PROJECT_DIR:-.}"
APP_ROOT="/home/container/app"

if [ ! -f "${SOURCE_ROOT}/Onda.csproj" ]; then
    echo "Onda.csproj não encontrado em ${SOURCE_ROOT}. Reinstale o servidor pelo painel." >&2
    exit 1
fi

# Atualização opcional na inicialização. O pull é feito no clone do install;
# o app é recompilado logo abaixo, antes de começar a atender.
auto_update="${AUTO_UPDATE:-0}"
case "${auto_update,,}" in
    1|true)
        if [ -d "${REPO_ROOT}/.git" ]; then
            branch="${BRANCH:-}"
            if [ -z "${branch}" ]; then
                branch="$(git -c safe.directory="${REPO_ROOT}" -C "${REPO_ROOT}" branch --show-current 2>/dev/null || true)"
            fi
            branch="${branch:-main}"
            echo "[auto-update] Verificando o branch ${branch}..."

            if GIT_TERMINAL_PROMPT=0 timeout 60 git \
                -c safe.directory="${REPO_ROOT}" \
                -C "${REPO_ROOT}" \
                fetch --depth 1 origin "${branch}"; then

                current="$(git -c safe.directory="${REPO_ROOT}" -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
                remote="$(git -c safe.directory="${REPO_ROOT}" -C "${REPO_ROOT}" rev-parse FETCH_HEAD 2>/dev/null || true)"

                if [ -n "${current}" ] && [ -n "${remote}" ] && [ "${current}" != "${remote}" ]; then
                    echo "[auto-update] Novo commit encontrado: ${current} -> ${remote}"
                    if git -c safe.directory="${REPO_ROOT}" -C "${REPO_ROOT}" reset --hard FETCH_HEAD; then
                        echo "[auto-update] Código atualizado."
                    else
                        echo "[auto-update] Não foi possível aplicar o novo commit; usando o código atual." >&2
                    fi
                else
                    echo "[auto-update] Já está no commit mais recente."
                fi
            else
                echo "[auto-update] Não foi possível consultar o Git; usando o código atual." >&2
            fi
        else
            echo "[auto-update] AUTO_UPDATE ativo, mas source não é um clone Git; ignorando." >&2
        fi
        ;;
esac

# O runtime .NET 10 do Pterodactyl inclui o SDK. Compilar no boot mantém o egg
# independente de uma imagem de build específica; o processo final é executado
# diretamente para receber o sinal de parada do Wings.
#
# Compila em um diretório separado e só troca o app depois do sucesso. Se uma
# atualização quebrar o build, a versão anterior continua disponível.
BUILD_ROOT="${APP_ROOT}.next"
PREVIOUS_ROOT="${APP_ROOT}.previous"
rm -rf "${BUILD_ROOT}"

if ! dotnet publish "${SOURCE_ROOT}/Onda.csproj" \
    -c Release \
    -o "${BUILD_ROOT}" \
    /p:UseAppHost=false; then
    rm -rf "${BUILD_ROOT}"
    if [ ! -f "${APP_ROOT}/Onda.dll" ]; then
        echo "Falha ao compilar e não há versão anterior para iniciar." >&2
        exit 1
    fi
    echo "Falha ao compilar a atualização; mantendo a versão anterior." >&2
else
    rm -rf "${PREVIOUS_ROOT}"
    if [ -d "${APP_ROOT}" ]; then
        mv "${APP_ROOT}" "${PREVIOUS_ROOT}"
    fi
    mv "${BUILD_ROOT}" "${APP_ROOT}"
    rm -rf "${PREVIOUS_ROOT}"
fi

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
