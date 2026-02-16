#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-manuscritos.live}"
EMAIL="${LETSENCRYPT_EMAIL:-}"

if [[ -z "$EMAIL" ]]; then
  echo "ERROR: define LETSENCRYPT_EMAIL=tu@email para emitir certificados" >&2
  exit 1
fi

DATA_PATH="./deploy/certbot"

SUDO=""
if [[ "${EUID:-$(id -u)}" != "0" ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

mkdir -p "$DATA_PATH/conf" "$DATA_PATH/www"

if [[ ! -e "$DATA_PATH/conf/options-ssl-nginx.conf" ]]; then
  echo "== Descargando TLS params recomendados =="
  curl -sS https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
    -o "$DATA_PATH/conf/options-ssl-nginx.conf" || true
fi

if [[ ! -e "$DATA_PATH/conf/ssl-dhparams.pem" ]]; then
  echo "== Descargando dhparams =="
  curl -sS https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
    -o "$DATA_PATH/conf/ssl-dhparams.pem" || true
fi

if [[ ! -d "$DATA_PATH/conf/live/$DOMAIN" ]]; then
  echo "== Creando certificado dummy para arrancar Nginx =="
  mkdir -p "$DATA_PATH/conf/live/$DOMAIN"
  docker compose run --rm --entrypoint "\
    openssl req -x509 -nodes -newkey rsa:2048 -days 1\
      -keyout '/etc/letsencrypt/live/$DOMAIN/privkey.pem'\
      -out '/etc/letsencrypt/live/$DOMAIN/fullchain.pem'\
      -subj '/CN=localhost'\
    " certbot
fi

echo "== Arrancando Nginx para desafío ACME =="
docker compose up -d nginx

echo "== Eliminando certificado dummy (si existe) =="
rm -rf "$DATA_PATH/conf/live/$DOMAIN" 2>/dev/null || $SUDO rm -rf "$DATA_PATH/conf/live/$DOMAIN" || true
rm -rf "$DATA_PATH/conf/archive/$DOMAIN" 2>/dev/null || $SUDO rm -rf "$DATA_PATH/conf/archive/$DOMAIN" || true
rm -f "$DATA_PATH/conf/renewal/$DOMAIN.conf" 2>/dev/null || $SUDO rm -f "$DATA_PATH/conf/renewal/$DOMAIN.conf" || true

echo "== Solicitando certificado real (Let's Encrypt) =="
docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  -d "www.$DOMAIN"

if [[ ! -e "$DATA_PATH/conf/live/$DOMAIN/fullchain.pem" ]]; then
  candidate_dir="$(ls -dt "$DATA_PATH/conf/live/${DOMAIN}"-* 2>/dev/null | head -n 1 || true)"
  if [[ -n "$candidate_dir" && -d "$candidate_dir" ]]; then
    echo "== Ajustando ruta live/$DOMAIN -> $(basename "$candidate_dir") =="
    rm -rf "$DATA_PATH/conf/live/$DOMAIN" 2>/dev/null || $SUDO rm -rf "$DATA_PATH/conf/live/$DOMAIN" || true
    (cd "$DATA_PATH/conf/live" && ln -sfn "$(basename "$candidate_dir")" "$DOMAIN") 2>/dev/null \
      || $SUDO bash -lc "cd '$DATA_PATH/conf/live' && ln -sfn '$(basename "$candidate_dir")' '$DOMAIN'" \
      || true
  fi
fi

echo "== Recargando Nginx =="
docker compose exec nginx nginx -s reload

echo "Listo: certificados emitidos para $DOMAIN y www.$DOMAIN"
