# MONITORING_BASELINE.md

Минимальный monitoring/runbook для текущего production baseline:

- 1 existing Yandex VM
- 2 Docker контейнера (`t2-call-summary`, `ai-gateway`)
- текущий route без изменений:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram

Non-goals этого этапа:

- без Redis / queue / worker / Kubernetes / Prometheus / Grafana
- без изменения бизнес-логики, DB schema, deploy topology, provider routing
- без возврата direct OpenAI runtime path

## Monitoring scope (минимум)

Покрываем только практичный baseline:

- healthz checks (`/healthz` для main app и gateway)
- видимость main app 5xx и crash/fatal
- видимость ai-gateway failures
- видимость Polza upstream failures
- видимость Telegram delivery failures
- видимость DB connectivity failures

Инструменты:

- Docker `HEALTHCHECK` в обоих image
- JSON logs (через `docker logs`)
- один shell-скрипт: `scripts/monitoring/baseline-check.sh`

## Step 1. Rebuild and redeploy images (one-time to enable Docker health)

### What we are doing
Обновляем images, чтобы Docker начал хранить health status контейнеров.

### Why we are doing it
`docker ps` и `docker inspect` будут показывать `healthy/unhealthy`, это базовый monitoring сигнал.

### Where to run
Локальный терминал (build/push) + SSH на VM (pull/restart).

### Exact command
```bash
cd <repo-root>

export REGISTRY_ID="<your-registry-id>"
export APP_IMAGE="cr.yandex/${REGISTRY_ID}/t2-call-summary:prod-v3-monitoring"
export GATEWAY_IMAGE="cr.yandex/${REGISTRY_ID}/ai-gateway:prod-v3-monitoring"

docker build -t "${APP_IMAGE}" .
docker push "${APP_IMAGE}"

docker build -t "${GATEWAY_IMAGE}" ./ai-gateway
docker push "${GATEWAY_IMAGE}"
```

На VM:
```bash
export REGISTRY_ID="<your-registry-id>"
export APP_IMAGE="cr.yandex/${REGISTRY_ID}/t2-call-summary:prod-v3-monitoring"
export GATEWAY_IMAGE="cr.yandex/${REGISTRY_ID}/ai-gateway:prod-v3-monitoring"

docker pull "${APP_IMAGE}"
docker pull "${GATEWAY_IMAGE}"

docker rm -f ai-gateway || true
docker rm -f t2-call-summary || true

docker run -d \
  --name ai-gateway \
  --restart unless-stopped \
  --network t2-app-net \
  -p 3001:3001 \
  --env-file /opt/t2-call-summary/gateway.env \
  "${GATEWAY_IMAGE}"

docker run -d \
  --name t2-call-summary \
  --restart unless-stopped \
  --network t2-app-net \
  -p 3000:3000 \
  --env-file /opt/t2-call-summary/main.env \
  "${APP_IMAGE}"
```

### Expected result
Оба контейнера снова `Up` и через короткое время становятся `healthy`.

### How to verify
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
docker inspect --format '{{.Name}} -> {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' ai-gateway t2-call-summary
```

### If the result is different
Проверь `docker logs ai-gateway` и `docker logs t2-call-summary`, затем исправь env/доступность БД и перезапусти контейнер.

## Step 2. Run baseline monitoring check

### What we are doing
Запускаем единый скрипт проверки контейнеров, health endpoints и error-сигналов в логах.

### Why we are doing it
Это самый простой способ регулярно получать статус по ключевым failure points без новой инфраструктуры.

### Where to run
SSH на production VM.

### Exact command
Локально (копируем скрипт на VM):
```bash
scp <repo-root>/scripts/monitoring/baseline-check.sh <vm-user>@<VM_PUBLIC_IP>:/tmp/baseline-check.sh
```

На VM:
```bash
sudo install -m 755 /tmp/baseline-check.sh /opt/t2-call-summary/baseline-check.sh
LOG_WINDOW=15m /opt/t2-call-summary/baseline-check.sh
```

### Expected result
Финальная строка:
- `[OK] baseline monitoring checks passed.`  
или
- `[ATTENTION] ...` (есть warning signals),  
или
- `[FAIL] ...` (контейнер/health сломан).

### How to verify
Проверь секции output:
- `Container state and Docker health`
- `Health endpoints`
- `Log signals`

### If the result is different
- при `[FAIL]`: сначала почини контейнер/healthz;
- при `[ATTENTION]`: разберись с сигналами в логах и повтори запуск.

## Step 3. Manual spot-check commands (without script)

### What we are doing
Проверяем те же сигналы вручную через Docker/curl.

### Why we are doing it
Это fallback, если нужно быстро локализовать проблему вручную.

### Where to run
SSH на production VM.

### Exact command
```bash
# healthz
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3000/healthz

# container health
docker inspect --format '{{.Name}} -> {{.State.Status}} / {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' ai-gateway t2-call-summary

# main app 5xx
docker logs --since 15m t2-call-summary 2>&1 | grep -E '"message":"http_request".*"statusCode":5[0-9][0-9]'

# ai-gateway failures
docker logs --since 15m ai-gateway 2>&1 | grep -E '"message":"analyze_failed_known_error"|"message":"analyze_failed_unhandled_error"|"message":"gateway_auth_failed"|"message":"express_unhandled_error"'

# Polza upstream failures
docker logs --since 15m ai-gateway 2>&1 | grep -E '"message":"analyze_failed_known_error".*"code":"POLZA_[A-Z_]+"|"message":"analyze_failed_known_error".*"message":"Polza '

# Telegram failures
docker logs --since 15m t2-call-summary 2>&1 | grep -E '"message":"telegram_send_failed"|"message":"telegram_send_timeout"|"message":"telegram_send_error"'

# DB connectivity failures
docker logs --since 15m t2-call-summary 2>&1 | grep -E '"message":"healthz_failed"|"message":"healthcheck_failed"|"message":"bootstrap_failed"|"ECONNREFUSED"|"ENOTFOUND"|"ETIMEDOUT"'
```

### Expected result
- `healthz`: main app `status=ok,database=ok`; gateway `status=ok`
- по grep-командам: в штатном режиме пустой вывод

### How to verify
Если grep ничего не вернул, за окно `15m` ошибок этого типа нет.

### If the result is different
Скопируй последние строки ошибок:
```bash
docker logs --since 15m --tail 200 t2-call-summary
docker logs --since 15m --tail 200 ai-gateway
```
Исправь причину и повтори Step 2.

## Optional lightweight alerting (no heavy infra)

Можно добавить `cron` на этой же VM, который запускает `baseline-check.sh` каждые 5 минут и при non-zero exit отправляет одно короткое сообщение в Telegram через уже существующего бота.

Это опционально и не требует Prometheus/Grafana.
