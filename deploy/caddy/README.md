# Reverse proxy TLS

O overlay usa Caddy para terminar TLS em dois domínios:

- `ONDA_DOMAIN` → app Blazor
- `LIVEKIT_DOMAIN` → sinalização WebSocket do LiveKit

Configure `APP_PUBLIC_URL=https://onda...` e `LIVEKIT_PUBLIC_URL=wss://livekit...`.
O TURN continua acessado diretamente por UDP/TCP na porta 3478 e pela faixa de relay.

Para reduzir a exposição do app, você pode usar `APP_BIND=127.0.0.1` em `deploy/.env` (o Caddy fala com `onda:8080` pela rede do Compose). Não restrinja `LIVEKIT_BIND` a loopback: a porta 7881/TCP ainda precisa ser alcançável pelos navegadores para o fallback de mídia.
