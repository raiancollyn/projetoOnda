# LiveKit standalone

Este pacote sobe **apenas o LiveKit SFU** em um container, separado do app. É a alternativa para quem não quer o LiveKit dentro da stack do Onda ou precisa apontar o egg do Pterodactyl para um servidor de mídia dedicado.

## Docker

```bash
cd Onda/deploy/livekit
cp .env.example .env
# edite LIVEKIT_API_KEY, LIVEKIT_API_SECRET e LIVEKIT_DOMAIN
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

Sem o Caddy, use seu próprio proxy com TLS. O app precisa de uma URL **WSS**; em produção, não use `ws://` em uma página HTTPS.

### Portas

| Porta | Protocolo | Uso |
|---|---|---|
| 7880 | TCP | sinalização WebSocket (pode ficar atrás do Caddy) |
| 7881 | TCP | mídia WebRTC via TCP |
| 50000-50040 | UDP | mídia WebRTC |

Abra 7881/TCP e a faixa UDP no firewall. O Caddy só faz proxy da sinalização; a mídia vai direto.

## Apontar o app

No egg do Onda (ou nas variáveis do Compose do app), use:

```text
LIVEKIT_URL=wss://livekit.seudominio.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

As chaves devem ser exatamente as mesmas deste `.env`. A capacidade (`MAX_PARTICIPANTS`) fica no app.

## Pterodactyl

Se preferir rodar o LiveKit em um servidor do Pterodactyl, importe [`../pterodactyl/egg-livekit.json`](../pterodactyl/egg-livekit.json). Ele baixa o binário oficial e usa o entrypoint padrão dos yolks do Pterodactyl.

O egg exige **três alocações**:

- a porta primária (`SERVER_PORT`) para sinalização;
- uma porta TCP para RTC (`RTC_TCP_PORT`);
- uma porta UDP para RTC (`RTC_UDP_PORT`).

Cada allocation do Pterodactyl é publicada em TCP e UDP pelo Wings. O egg usa um único port UDP; para salas maiores, prefira a VPS com Compose. Se a descoberta do IP público via STUN falhar, acrescente `--node-ip IP_PUBLICO` ao startup do egg. O TLS da sinalização precisa ser feito por um proxy reverso apontando para a porta primária.

O TURN não é executado neste pacote. A stack principal (`../docker-compose.yml`) inclui Coturn; o egg do app também aceita um TURN externo.
