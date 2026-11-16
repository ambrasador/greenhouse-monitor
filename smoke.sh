#!/usr/bin/env bash
# Димова перевірка стека Compose: від порожнього тому до показання, яке користувач
# бачить через проксі. Запуск: ./smoke.sh (потрібен .env; стек зупиняють docker compose down -v)
set -euo pipefail
cd "$(dirname "$0")"
PASS=$(openssl rand -hex 12)            # одноразовий пароль перевірки
URL=http://localhost:8080

# Без .env (чиста копія, CI) створюємо одноразові секрети; наявний .env не чіпаємо
if [ ! -f .env ]; then
  printf 'JWT_KEYS=k1:%s\nJWT_CURRENT=k1\nWEBHOOK_SECRETS=%s\nALLOWED_ORIGINS=%s\n' \
    "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" "$URL" > .env
fi

docker compose up -d --wait
docker compose exec -T backend node admin-cli.js device-add gh1-s01 "Грядка А" north
docker compose exec -T -e NEW_PASSWORD="$PASS" backend node admin-cli.js user-add smoke admin '*'

ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
docker compose exec -T mosquitto mosquitto_pub -q 1 -t greenhouse/gh1-s01/telemetry \
  -m "{\"metric\":\"temperature\",\"value\":24.5,\"ts\":\"$ts\"}"

token=$(curl -fsS -H 'Content-Type: application/json' \
  -d "{\"username\":\"smoke\",\"password\":\"$PASS\"}" "$URL/api/v1/auth/login" \
  | node -p "JSON.parse(require('fs').readFileSync(0)).access_token")

# показання доходить асинхронно: опитуємо до 10 с
for _ in $(seq 50); do
  body=$(curl -fsS -H "Authorization: Bearer $token" "$URL/api/v1/devices/gh1-s01" || true)
  case "$body" in *'"value":24.5'*) echo "ok: пристрій → брокер → сервер → проксі"; break ;; esac
  sleep 0.2
done
case "$body" in *'"value":24.5'*) ;; *) echo "ПОМИЛКА: показання немає"; exit 1 ;; esac

# /metrics доступний усередині мережі Compose і закритий ззовні
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/metrics")
[ "$code" = 404 ] || { echo "ПОМИЛКА: /metrics ззовні дає $code"; exit 1; }
docker compose exec -T web wget -qO- http://backend:3000/metrics | grep -q '^greenhouse_readings_total{result="stored"} 1$'
echo "ok: /metrics назовні 404, всередині рахує показання"
