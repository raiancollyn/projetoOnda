# Nginx na frente do LiveKit (WSS)

Use o exemplo [`livekit-wss.conf.example`](livekit-wss.conf.example) em um novo server block do Nginx para o subdomínio do LiveKit.

## Antes de aplicar

1. Descubra a porta de sinalização do servidor LiveKit no Pterodactyl. No exemplo do projeto ela aparece no log como `portHttp` (por exemplo, `25567`).
2. Confirme onde essa porta está ligada no host:

   ```bash
   ss -ltnp | grep 25567
   ```

   - Se aparecer `0.0.0.0:25567` ou `127.0.0.1:25567`, o Nginx no host pode usar `127.0.0.1:25567`.
   - Se aparecer o IP público/privado do node, troque o `proxy_pass` para esse IP.
   - Se o Nginx estiver em outro container, `127.0.0.1` não serve; use o IP do host/node e libere a porta para ele.

3. Aponte o DNS `livekit.seudominio.com` para a VM e libere 443/TCP. As portas de mídia (`RTC_TCP_PORT` e `RTC_UDP_PORT`) continuam abertas diretamente; elas não passam pelo Nginx.

## Certificado

O exemplo aponta para `/etc/letsencrypt/live/livekit.seudominio.com/`. Se esse caminho ainda não existir, **não ative o server block 443**: o `nginx -t` falha com `BIO_new_file() failed ... No such file or directory`.

Primeiro veja o que já existe:

```bash
sudo certbot certificates
sudo ls -l /etc/letsencrypt/live/
```

Se houver um certificado válido que cubra `livekit.seudominio.com` (por exemplo, um wildcard `*.seudominio.com`), use os caminhos dele.

Se não houver, emita antes de ativar o site. A forma mais direta é parar o Nginx por alguns instantes e usar o desafio standalone:

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d livekit.seudominio.com
sudo systemctl start nginx
```

Pré-requisitos: DNS de `livekit.seudominio.com` apontando para a VM e porta 80 liberada. Se o DNS estiver atrás da Cloudflare com proxy laranja, deixe-o como **DNS only** durante a emissão ou use o desafio DNS da Cloudflare.

Se você já tem um server block HTTP para o subdomínio e o Nginx está saudável, também pode usar:

```bash
sudo certbot --nginx -d livekit.seudominio.com
```

Depois da emissão, confira o caminho real e ajuste o `ssl_certificate`/`ssl_certificate_key` no arquivo do site.

## Aplicar

Com o certificado existente:

```bash
sudo cp livekit-wss.conf.example /etc/nginx/sites-available/livekit
sudo ln -s /etc/nginx/sites-available/livekit /etc/nginx/sites-enabled/livekit
sudo nginx -t
sudo systemctl reload nginx
```

Não crie arquivos `.pem` vazios para “enganar” o Nginx; ele precisa de um certificado válido.

## Testar

```bash
curl -I https://livekit.seudominio.com
```

O LiveKit pode responder `404` na raiz; o importante é não receber `502/504` e o TLS abrir. Um teste de WebSocket útil é:

```bash
npx wscat -c wss://livekit.seudominio.com/rtc
```

A conexão deve concluir o handshake e depois ser fechada/rejeitada por falta de token — isso já indica que o Nginx está encaminhando o upgrade. Se der `502`, o `proxy_pass` está no endereço/porta errada; se der `504`, veja timeouts e se o LiveKit está rodando.

Depois configure no app:

```text
LIVEKIT_URL=wss://livekit.seudominio.com
```
