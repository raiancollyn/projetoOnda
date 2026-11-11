# Implantação do Onda

Esta pasta contém o pacote de infraestrutura para rodar o app com **LiveKit SFU**, **TURN (Coturn)** e um proxy HTTPS opcional, tanto em uma VPS com Docker quanto em um painel Pterodactyl.

## Visão geral

```
Navegador
 ├── HTTPS/WSS ── Caddy (opcional) ── Blazor Server (Onda)
 │                                └── LiveKit Server  (sinalização + SFU)
 ├── UDP/TCP ──── LiveKit SFU (50000-50040/udp, 7881/tcp)
 └── UDP/TCP ──── Coturn (3478, 49160-49200/udp)
```

- O app continua responsável por nomes, salas, senhas, presença, chat e listagem. Chat e metadados ficam em SQLite enquanto a sala tem usuários; ao esvaziar, tudo é apagado.
- O LiveKit transporta áudio, webcam e tela a partir de 2+ participantes, sem depender de o navegador abrir uma conexão para cada pessoa. Ele também pode rodar em um container/egg separado; veja [`livekit/`](livekit/).
- O TURN entra em ação quando uma conexão direta entre o participante e o LiveKit não é possível.
- No modo Docker, o app emite tokens LiveKit de curta duração; a API secret nunca vai para o navegador.
- A capacidade padrão do pacote é **25 pessoas por sala** (configurável).

## Docker Compose (recomendado)

### 1. Preparar

```bash
cd Onda/deploy
cp .env.example .env
```

Edite `.env` e defina:

- os domínios públicos (`APP_PUBLIC_URL`, `LIVEKIT_PUBLIC_URL`, `ONDA_DOMAIN`, `LIVEKIT_DOMAIN`);
- as chaves do LiveKit;
- as credenciais e o IP público do TURN;
- o limite de participantes.

Gere as chaves do LiveKit com:

```bash
docker run --rm livekit/livekit-server:v1.13.11 generate-keys
```

Copie `API Key` e `API Secret` para `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` e para a configuração do LiveKit (o Compose já faz isso via ambiente).

### 2. Subir com HTTPS

O overlay `docker-compose.tls.yml` usa Caddy e obtém certificados automaticamente para os dois domínios.

Pré-requisitos: DNS `A/AAAA` de `ONDA_DOMAIN` e `LIVEKIT_DOMAIN` apontando para a VPS, e portas 80/443 liberadas.

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.tls.yml \
  up -d --build
```

O acesso deve ser feito em `https://ONDA_DOMAIN`.

### 3. Firewall

Abra (UDP e TCP conforme indicado):

| Porta | Protocolo | Uso |
|---|---|---|
| 80/443 | TCP | Caddy / HTTPS / WSS |
| 443 | UDP | HTTP/3 opcional do Caddy |
| 7880 | TCP | sinalização do LiveKit (se não usar proxy/TLS) |
| 7881 | TCP | mídia WebRTC do LiveKit via TCP |
| 50000-50040 | UDP | mídia WebRTC do LiveKit |
| 3478 | TCP + UDP | TURN |
| 49160-49200 | UDP | relay do TURN |

Se você usar o Caddy, o tráfego de sinalização em 7880 pode ficar restrito ao proxy/rede interna; a mídia em 7881 e nos ranges UDP continua precisando ser acessível aos navegadores. O app em 8080 também só precisa ser alcançável pelo proxy.

Se você não usar o Caddy, precisa publicar o app e a sinalização em HTTPS/WSS por conta própria. Não use apenas HTTP em produção: o navegador bloqueia microfone/câmera fora de um contexto seguro.

O app grava o banco em `/data/onda.db`, no volume `onda_data`. O volume é local ao servidor; não é um banco compartilhado entre réplicas.

### 4. Testar

```bash
curl http://localhost:8080/health
```

Depois abra o app, crie uma sala e entre com uma segunda janela/aba.

## Sem Docker / desenvolvimento local

O modo padrão continua sendo mesh P2P. Para testar o app com um LiveKit local:

1. Suba um LiveKit de desenvolvimento:

   ```bash
   docker run --rm \
     -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
     livekit/livekit-server:v1.13.11 --dev --bind 0.0.0.0
   ```

2. Suba o app com o perfil `sfu`:

   ```bash
   cd Onda
   dotnet run --launch-profile sfu
   ```

O perfil `sfu` usa `devkey`/`secret`, LiveKit em `ws://127.0.0.1:7880` e capacidade de 25 pessoas. Esses valores são apenas para desenvolvimento.

## LiveKit dedicado (container separado)

Se você quer o LiveKit em um container próprio, sem o app ou o Coturn dentro dele:

```bash
cd Onda/deploy/livekit
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

O app aponta para o endereço `wss://` gerado pelo Caddy. As chaves do `.env` do LiveKit devem ser as mesmas configuradas no app. Esse pacote não inclui TURN; use a stack principal com Coturn ou um TURN externo. Detalhes em [`livekit/README.md`](livekit/README.md).

## Pterodactyl

Existem **dois eggs** em [`pterodactyl/`](pterodactyl/):

- `egg-onda.json` — app Blazor, compilado no primeiro boot pelo runtime .NET 10;
- `egg-livekit.json` — LiveKit SFU dedicado, baixado pelo install.

O app aponta para o LiveKit externo pelas variáveis `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`. O LiveKit precisa de três alocações: sinalização (primária), RTC/TCP e RTC/UDP. A sinalização deve ficar atrás de um proxy TLS (`wss://`); a mídia usa as portas diretas.

O TURN não está embutido no egg do LiveKit. Use a stack Docker principal com Coturn, um Coturn externo, ou deixe o app sem TURN (o LiveKit ainda tenta TCP/UDP direto).

O guia detalhado, incluindo o banco SQLite do app, está em [`pterodactyl/README.md`](pterodactyl/README.md).

## Salas e banco SQLite

Enquanto uma sala tem usuários, o app grava:

- metadados da sala (nome, dono, senha com hash) e mensagens de chat no arquivo SQLite;
- presença, fala e estado de mídia em memória, porque são dados efêmeros e de alta frequência.

Quando o último participante clica em **Sair**, a sala e todo o chat são deletados imediatamente do SQLite e da memória. Se a aba for fechada ou recarregada, o servidor mantém a sala por 30 segundos para permitir a reentrada; depois o janitor remove o participante e apaga a sala/histórico. Participantes fantasmas são removidos em até 2 minutos. Links de salas encerradas deixam de existir.

O caminho é configurável:

```text
Storage__DatabasePath=/data/onda.db           # Docker
Storage__DatabasePath=/home/container/data/onda.db  # egg do Pterodactyl
```

No Docker, `/data` é um volume nomeado (`onda_data`). O processo inicia com o banco vazio: um restart perde as sessões de navegador e, portanto, as salas antigas são consideradas órfãs. O arquivo não guarda histórico de salas encerradas.

## Configuração por ambiente

As variáveis são lidas pelo `Microsoft.Extensions.Configuration` via `.NET`:

```text
Media__Provider=LiveKit
Media__MaxParticipants=25
Media__LiveKit__Url=wss://livekit.seudominio.com
Media__LiveKit__ApiKey=...
Media__LiveKit__ApiSecret=...
Media__LiveKit__TokenTtlHours=6
Media__IceServers__0__Urls__0=turn:turn.seudominio.com:3478?transport=udp
Media__IceServers__0__Username=...
Media__IceServers__0__Credential=...
Media__IceServers__1__Urls__0=stun:stun.l.google.com:19302
Storage__DatabasePath=/data/onda.db
App__PublicUrl=https://onda.seudominio.com
HttpsRedirection__Enabled=false
ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
```

Para o modo mesh, use `Media__Provider=Mesh` e configure apenas ICE/TURN. A capacidade do mesh é limitada a 8 pessoas por segurança, mesmo que `Media__MaxParticipants` seja maior.

## Notas

- O Docker não estava disponível no ambiente onde o código foi desenvolvido; os contêineres e os eggs foram escritos e validados sintaticamente, mas **não puderam ser executados aqui**. A integração LiveKit/TURN no app foi testada localmente com um servidor LiveKit real.
- Para uma implantação em várias máquinas com LiveKit distribuído, coloque Redis e vários nós atrás de um balanceador. Este pacote é intencionalmente de nó único.
- As salas ativas usam memória apenas para presença e estado de mídia. Metadados e chat ficam no SQLite e são apagados quando a sala fica vazia; reiniciar o app também limpa o banco porque todas as sessões foram perdidas. O LiveKit descarta as sessões de mídia ao reiniciar.
- Ajuste o range UDP do LiveKit e do Coturn no Compose e no firewall se precisar de mais sessões simultâneas.
- Use segredos longos e exclusivos para TURN e LiveKit. Não compartilhe o `.env`.
- O TURN deste pacote opera em `3478` sobre UDP/TCP, sem TLS (`turns:`); o conteúdo de mídia continua protegido por DTLS-SRTP. Se sua política exigir TURN sobre TLS, configure certificados no Coturn ou use o TURN embutido do LiveKit.
