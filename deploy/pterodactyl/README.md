# Onda no Pterodactyl

O pacote tem **dois eggs independentes**:

| Egg | Papel |
|---|---|
| [`egg-onda.json`](egg-onda.json) | App Blazor, presença, salas, chat e emissão de tokens |
| [`egg-livekit.json`](egg-livekit.json) | LiveKit SFU dedicado, com o app apontando para ele |

O TURN continua separado. O app aceita um TURN externo pelas variáveis `TURN_URL`, `TURN_USERNAME` e `TURN_PASSWORD`; a stack Docker principal inclui Coturn, mas o egg do LiveKit não o embute.

## Por que separar?

O Pterodactyl é excelente para processos com portas bem definidas. WebRTC precisa de:

- uma porta de sinalização WebSocket;
- uma porta TCP para mídia;
- uma porta UDP para mídia;
- TLS na sinalização para o navegador aceitar `wss://`;
- um IP público que os participantes alcancem.

Colocar o app, o LiveKit e o TURN no mesmo container obrigaria a expor ranges UDP e complicaria o ciclo de vida de cada processo. Separar permite reiniciar o app sem derrubar chamadas e escalar o LiveKit de forma independente.

O caminho mais completo continua sendo a VPS com Docker Compose: ela entrega app + LiveKit + Coturn + Caddy. Os eggs são a alternativa para quem quer cada serviço em um servidor do painel.

## Egg do app

### Instalação

1. Publique este repositório em um Git acessível pelo nó.
2. Importe `egg-onda.json`.
3. Crie o servidor usando a imagem **Dotnet 10 (Pterodactyl yolk)**.
4. Preencha:
   - `GIT_ADDRESS` e `BRANCH`;
   - `PROJECT_DIR` (padrão `Onda`);
   - `APP_PUBLIC_URL` — URL HTTPS do app, usada nos links de convite;
   - `DATABASE_PATH` — padrão `/home/container/data/onda.db`;
   - `MAX_PARTICIPANTS`;
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` — os mesmos do egg LiveKit;
   - opcionalmente `TURN_URL`, `TURN_USERNAME` e `TURN_PASSWORD`.
5. Configure um proxy reverso HTTPS para a porta alocada. O app escuta HTTP; câmera, microfone e tela exigem HTTPS fora de `localhost`.

O install clona o repositório para `/home/container/source`. No boot, `start.sh` publica o projeto em `/home/container/app` e executa o app. O primeiro boot precisa de internet para restaurar o NuGet; os seguintes usam o cache.

### Banco SQLite

O app grava metadados e chat em `DATABASE_PATH` enquanto a sala tem usuários. Ao clicar em **Sair**, a sala e **todo o histórico** são apagados do SQLite imediatamente. Fechar ou recarregar a aba deixa uma janela de 30 segundos para reentrar; depois o janitor remove a sala vazia e o histórico. O arquivo fica no volume do servidor, fora de `/home/container/app`.

O banco é limpo também quando o processo inicia: depois de um restart, as antigas sessões de navegador não existem mais, então não há usuários reais nas salas.

## Egg do LiveKit

### Alocações

O egg precisa de **três portas**:

| Variável | Uso |
|---|---|
| `SERVER_PORT` (primária, automática) | sinalização WebSocket |
| `RTC_TCP_PORT` | mídia WebRTC via TCP |
| `RTC_UDP_PORT` | mídia WebRTC via UDP |

Crie as alocações no painel e informe os mesmos números em `RTC_TCP_PORT`/`RTC_UDP_PORT`. O Wings publica cada allocation em TCP **e** UDP, então o mesmo número cobre os dois protocolos. O egg usa um único port UDP (o Pterodactyl não aloca ranges de forma prática). Para muitas salas simultâneas, prefira a VPS com Compose.

Se a descoberta automática do IP público via STUN falhar, adicione `--node-ip SEU_IP_PUBLICO` ao comando de startup do egg (ou defina `LIVEKIT_RTC_USE_EXTERNAL_IP=false` para rede local).

### Instalação

1. Importe `egg-livekit.json`.
2. Crie o servidor e adicione as alocações.
3. Em `LIVEKIT_KEYS`, informe `apiKey: apiSecret` (o secret precisa de 32+ caracteres).
4. Aponte o domínio `wss://livekit.seudominio.com` para a porta primária por um proxy reverso com TLS.
5. No egg do app, use a mesma API key/secret em `LIVEKIT_URL` (`wss://...`), `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`.

O install baixa o binário oficial `livekit-server` 1.13.11. O processo não usa banco nem Redis: é um nó único.

Exemplo de proxy (Caddy) na máquina do nó:

```caddyfile
livekit.seudominio.com {
    reverse_proxy 127.0.0.1:PORTA_DA_ALOCACAO_PRIMARIA
}
```

Abra a porta primária apenas para o proxy, e as portas `RTC_TCP_PORT`/`RTC_UDP_PORT` diretamente para os navegadores.

## Limitações

- O TURN não está embutido no egg do LiveKit. Use um Coturn externo ou a stack Docker completa.
- Um único port UDP no Pterodactyl é suficiente para uso pequeno/médio, mas não tem a flexibilidade de um range dedicado.
- O proxy TLS da sinalização não é criado pelo egg; você precisa configurá-lo.
- O primeiro boot do app compila o projeto; pode demorar alguns segundos.
- O banco SQLite é um arquivo local. Não compartilhe o mesmo arquivo entre dois servidores do app.
- Este repositório não foi importado em uma instalação Pterodactyl real neste ambiente; os eggs foram validados como JSON e os scripts seguem o formato/entrypoint dos yolks oficiais.
