# DEPLOYMENT_YC.md

Пошаговый beginner-friendly runbook для текущего production-контура в Yandex Cloud.

## Scope guardrails

- 1 VM (Yandex Compute Cloud)
- 1 main app container
- 1 `ai-gateway` container
- 1 Managed PostgreSQL
- 1 Container Registry
- без Redis / queue / worker / Kubernetes / load balancer
- не углубляем `t2` production ingest в этом этапе

## Fixed strategy and status

- fixed long-term provider strategy: **Polza**
- mandatory integration boundary: `main app -> ai-gateway`
- current stage: **production Polza cutover complete on the existing Yandex VM**
- current production route:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- direct OpenAI runtime path больше не является активным production route

## Current confirmed production status

The following is already confirmed in production on the existing Yandex VM:

- main app and `ai-gateway` run as separate Docker containers on the same VM
- container-to-container routing uses user-defined Docker network `t2-app-net`
- production main app uses `AI_GATEWAY_URL=http://ai-gateway:3001`
- host-level checks on VM succeed:
  - `curl http://127.0.0.1:3001/healthz`
  - `curl http://127.0.0.1:3000/healthz`
- `POST /analyze` works through Polza
- `POST /api/process-call` on VM returned `processed`
- Telegram delivery status in production smoke is `sent`
- full production path works:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram

Additional confirmed facts:

- `ai-gateway` logs confirmed successful `POST /analyze` through Polza
- external EU/VPS gateway host is not used
- PostgreSQL topology unchanged
- Telegram integration unchanged

## Current production routing note

For the current production baseline on the existing Yandex VM:

- main app and `ai-gateway` run as separate Docker containers on the same VM
- container-to-container routing uses Docker network `t2-app-net`
- production `AI_GATEWAY_URL` must be `http://ai-gateway:3001`
- `127.0.0.1:3001` is acceptable only for host-level checks from the VM, not as the main app container runtime URL

## Runtime naming status (important)

Canonical runtime names in `ai-gateway` code:

- `AI_GATEWAY_SHARED_SECRET`
- `POLZA_API_KEY`
- `POLZA_BASE_URL`
- `POLZA_MODEL`
- `POLZA_TRANSCRIPTION_MODEL` (legacy alias `POLZA_TRANSCRIBE_MODEL` is still supported)
- `ALLOW_REQUEST_MODEL_OVERRIDES` (keep `false` in production)
- `POLZA_TIMEOUT_MS`
- `POLZA_MAX_RETRIES`

Production cutover is confirmed, and runtime naming cleanup is applied.

## Step 1. Rotate secrets

### What we are doing
Обновляем все секреты перед production-использованием.

### Why we are doing it
Компрометированные секреты нельзя использовать в production.

### Where to run
Кабинеты провайдеров + локальные env-файлы.

### Exact action
- Rotate the exposed Polza API key if it has not already been rotated after local testing
- Rotate `TELEGRAM_BOT_TOKEN`
- Rotate shared secret between main app and gateway

### Expected result
Есть новый комплект валидных секретов.

### How to verify
Локально оба сервиса стартуют без auth ошибок.

### If the result is different
Остановите deploy и исправьте секреты до следующего шага.

## Step 2. Verify infra baseline in Yandex Cloud

### What we are doing
Проверяем, что инфраструктурная база готова.

### Why we are doing it
Без готового baseline контейнеры не запустятся стабильно.

### Where to run
Yandex Cloud Console и/или `yc` CLI.

### Checklist
- Registry существует
- VM запущена
- PostgreSQL cluster `Running`
- VM и PostgreSQL в одной VPC
- security groups соответствуют текущему baseline
- `ai-gateway` не публикуется как отдельный внешний сервис для production traffic

### Expected result
Все пункты checklist подтверждены.

### How to verify
Сверьте состояния в Console (`Compute`, `PostgreSQL`, `Container Registry`, `VPC`).

### If the result is different
Исправьте несоответствия до публикации образов.

## Step 3. Build and push images

### What we are doing
Собираем и публикуем образы main app и `ai-gateway`.

### Why we are doing it
VM должна запускать фиксированные теги из Registry.

### Where to run
Локальный терминал:
`<repo-root>`

### Exact command
```bash
cd <repo-root>
export REGISTRY_ID="<ваш-registry-id>"

# main app
export APP_IMAGE="cr.yandex/${REGISTRY_ID}/t2-call-summary:prod-v2"
docker build -t "${APP_IMAGE}" .
docker push "${APP_IMAGE}"

# ai-gateway
export GATEWAY_IMAGE="cr.yandex/${REGISTRY_ID}/ai-gateway:prod-v2"
docker build -t "${GATEWAY_IMAGE}" ./ai-gateway
docker push "${GATEWAY_IMAGE}"
```

### Expected result
Оба тега опубликованы в Registry.

### How to verify
```bash
yc container image list --registry-id "${REGISTRY_ID}"
```

### If the result is different
Проверьте docker auth и выбранный `REGISTRY_ID`.

## Step 4. Prepare env files on VM

### What we are doing
Создаём отдельные env-файлы для main app и gateway.

### Why we are doing it
Контейнеры должны получить явные runtime-переменные.

### Where to run
SSH-сессия на VM.

### Exact command
```bash
sudo mkdir -p /opt/t2-call-summary

# Main app env
sudo tee /opt/t2-call-summary/main.env >/dev/null <<'EOF_MAIN'
PORT=3000
APP_TIMEZONE=Europe/Moscow
LOG_LEVEL=info
AUTO_RUN_MIGRATIONS=true
IGNORE_LIST_BOOTSTRAP_FROM_ENV=true

DB_HOST=<private-fqdn-managed-postgresql-host>
DB_PORT=6432
DB_NAME=ats_call_summary
DB_USER=<db-user>
DB_PASSWORD=<db-password>
DB_SSL=false

# Production container-to-container routing on the current VM network:
AI_GATEWAY_URL=http://ai-gateway:3001
AI_GATEWAY_SHARED_SECRET=<shared-secret>
AI_GATEWAY_TIMEOUT_MS=70000
AI_ANALYZE_MIN_TRANSCRIPT_CHARS=16

TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_CHAT_ID=<telegram-chat-id>
# Optional additional recipients (numeric chat_id only)
TELEGRAM_GLOBAL_CHAT_IDS=
# Optional number-based routing (JSON)
TELEGRAM_NUMBER_ROUTE_RULES=
EOF_MAIN

# ai-gateway env
sudo tee /opt/t2-call-summary/gateway.env >/dev/null <<'EOF_GATEWAY'
PORT=3001
LOG_LEVEL=info
BODY_LIMIT=1mb
SHUTDOWN_TIMEOUT_MS=10000

AI_GATEWAY_SHARED_SECRET=<shared-secret>
POLZA_API_KEY=<polza-api-key>
POLZA_BASE_URL=https://polza.ai/api/v1
POLZA_MODEL=<polza-model>
POLZA_TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe
ALLOW_REQUEST_MODEL_OVERRIDES=false
POLZA_TIMEOUT_MS=65000
POLZA_MAX_RETRIES=0
EOF_GATEWAY
```

### Expected result
Оба env-файла сохранены на VM.

### How to verify
```bash
sudo ls -la /opt/t2-call-summary
```

### Safe env update for existing VM files (no duplicate keys)
If `main.env` and `gateway.env` already exist and you only need to update cost-guard vars, use replace flow below (Linux VM safe):

```bash
# main app: low-signal threshold
sudo sed -i '/^AI_ANALYZE_MIN_TRANSCRIPT_CHARS=/d' /opt/t2-call-summary/main.env
sudo sh -c "printf '%s\n' 'AI_ANALYZE_MIN_TRANSCRIPT_CHARS=16' >> /opt/t2-call-summary/main.env"

# main app: optional Telegram multi-recipient routing
sudo sed -i '/^TELEGRAM_GLOBAL_CHAT_IDS=/d;/^TELEGRAM_NUMBER_ROUTE_RULES=/d' /opt/t2-call-summary/main.env
sudo sh -c "printf '%s\n' 'TELEGRAM_GLOBAL_CHAT_IDS=' >> /opt/t2-call-summary/main.env"
sudo sh -c "printf '%s\n' 'TELEGRAM_NUMBER_ROUTE_RULES=' >> /opt/t2-call-summary/main.env"

# ai-gateway: request-level override guard
sudo sed -i '/^ALLOW_REQUEST_MODEL_OVERRIDES=/d' /opt/t2-call-summary/gateway.env
sudo sh -c "printf '%s\n' 'ALLOW_REQUEST_MODEL_OVERRIDES=false' >> /opt/t2-call-summary/gateway.env"

# ai-gateway: STT runtime model (canonical var)
sudo sed -i '/^POLZA_TRANSCRIPTION_MODEL=/d;/^POLZA_TRANSCRIBE_MODEL=/d' /opt/t2-call-summary/gateway.env
sudo sh -c "printf '%s\n' 'POLZA_TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe' >> /opt/t2-call-summary/gateway.env"
```

Quick verify:

```bash
grep -n '^AI_ANALYZE_MIN_TRANSCRIPT_CHARS=' /opt/t2-call-summary/main.env
grep -n '^ALLOW_REQUEST_MODEL_OVERRIDES=' /opt/t2-call-summary/gateway.env
grep -n '^POLZA_TRANSCRIPTION_MODEL=' /opt/t2-call-summary/gateway.env
```

### Important note
- Production container runtime routing on the existing Yandex VM uses:
  - Docker network `t2-app-net`
  - `AI_GATEWAY_URL=http://ai-gateway:3001`
- `127.0.0.1:3001` допустим только для host-level checks с VM
- не фиксируйте `http://127.0.0.1:3001` как production main app runtime URL внутри контейнера

### If the result is different
Проверьте права пользователя и повторите команды `tee`.

## Step 5. Run containers on existing VM

### What we are doing
Запускаем `ai-gateway` и main app на одной VM.

### Why we are doing it
Это текущий production target без расширения архитектуры.

### Where to run
SSH-сессия на VM.

### Exact command
```bash
export REGISTRY_ID="<ваш-registry-id>"
export APP_IMAGE="cr.yandex/${REGISTRY_ID}/t2-call-summary:prod-v2"
export GATEWAY_IMAGE="cr.yandex/${REGISTRY_ID}/ai-gateway:prod-v2"

docker pull "${APP_IMAGE}"
docker pull "${GATEWAY_IMAGE}"

docker network inspect t2-app-net >/dev/null 2>&1 || docker network create t2-app-net

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
Оба контейнера в статусе `Up`.

### How to verify
```bash
docker ps --filter "name=ai-gateway" --filter "name=t2-call-summary"
docker network inspect t2-app-net
```

### If the result is different
Проверьте `docker logs` упавшего контейнера и исправьте env.

## Step 6. Verify health endpoints

### What we are doing
Проверяем liveness main app и gateway.

### Why we are doing it
Без health-check нельзя переходить к smoke.

### Where to run
SSH-сессия на VM.

### Exact command
```bash
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3000/healthz
```

### Expected result
- gateway: `{"status":"ok"}`
- main app: JSON с `"status":"ok"` и `"database":"ok"`

### How to verify
Проверьте оба JSON-ответа и отсутствие критических ошибок в логах.

### If the result is different
Исправьте ошибки и перезапустите соответствующий контейнер.

## Step 7. Run production smoke (end-to-end)

### What we are doing
Отправляем контрольный `process-call` в main app.

### Why we are doing it
Проверяем полный маршрут: app -> gateway -> provider -> DB -> Telegram.

### Where to run
Локальный терминал или SSH на VM.

### Exact command
```bash
curl -s -X POST http://<VM_PUBLIC_IP>:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+7 (999) 123-45-67",
    "callDateTime": "2026-03-13T15:30:00+03:00",
    "transcript": "Клиент просит коммерческое предложение и срок поставки."
  }'
```

### Expected result
HTTP 200 и ожидаемый `status` (`processed`/`ignored`/`duplicate`).

### How to verify
Проверьте HTTP-ответ + логи контейнеров:
```bash
docker logs --tail 200 ai-gateway
docker logs --tail 200 t2-call-summary
```

### If the result is different
Проверьте секрет, URL gateway, provider credentials и доступ к БД.

### Important note
Этот smoke уже подтверждён для текущего production baseline. Повторяйте его после каждого значимого изменения env, образа или маршрутизации.

## Step 8. Verify DB writes in WebSQL

### What we are doing
Проверяем, что данные реально записались в PostgreSQL.

### Why we are doing it
Smoke считается успешным только при подтверждённой записи.

### Where to run
Yandex Cloud Console -> Managed PostgreSQL -> WebSQL.

### Exact queries
```sql
SELECT COUNT(*) AS summaries_count FROM summaries;
SELECT COUNT(*) AS events_count FROM call_events;
SELECT COUNT(*) AS processed_count FROM processed_calls;
SELECT COUNT(*) AS deliveries_count FROM telegram_deliveries;
```

### Expected result
Счётчики увеличены после smoke.

### How to verify
Сравните значения до/после тестового запроса.

### If the result is different
Проверьте логи и параметры `DB_*`.

## Step 9. Record progress

### What we are doing
Обновляем operational docs после значимого шага.

### Why we are doing it
Это текущий source of truth для проекта.

### Where to run
Локально, в репозитории.

### Exact action
1. Update `DEPLOY_PROGRESS.md`
2. If milestone changed, sync `TASKS.md`
3. If project-wide status changed, sync `README.md`

### Expected result
Документация синхронизирована с фактическим состоянием.

### How to verify
Сделайте `git diff` и проверьте, что статус в трёх файлах не конфликтует.

### If the result is different
Исправьте рассинхрон перед следующим deploy-шагом.

## Step 10. Minimal monitoring / post-cutover hardening

### What we are doing
Добавляем и проверяем минимальный monitoring слой для текущего production baseline без изменения архитектуры.

### Why we are doing it
После cutover нужен простой и стабильный способ видеть проблемы по `healthz`, 5xx, gateway/provider, Telegram и DB.

### Where to run
1) Локальный терминал (build/push обновлённых images)  
2) SSH на VM (pull/restart/verify)

### Exact command
Локально:
```bash
cd <repo-root>

export REGISTRY_ID="<ваш-registry-id>"
export APP_IMAGE="cr.yandex/${REGISTRY_ID}/t2-call-summary:prod-v3-monitoring"
export GATEWAY_IMAGE="cr.yandex/${REGISTRY_ID}/ai-gateway:prod-v3-monitoring"

docker build -t "${APP_IMAGE}" .
docker push "${APP_IMAGE}"

docker build -t "${GATEWAY_IMAGE}" ./ai-gateway
docker push "${GATEWAY_IMAGE}"

scp <repo-root>/scripts/monitoring/baseline-check.sh <vm-user>@<VM_PUBLIC_IP>:/tmp/baseline-check.sh
```

На VM:
```bash
export REGISTRY_ID="<ваш-registry-id>"
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

docker ps --format "table {{.Names}}\t{{.Status}}"
docker inspect --format '{{.Name}} -> {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' ai-gateway t2-call-summary

curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3000/healthz

sudo install -m 755 /tmp/baseline-check.sh /opt/t2-call-summary/baseline-check.sh
LOG_WINDOW=15m /opt/t2-call-summary/baseline-check.sh
```

### Expected result
- `docker inspect` показывает `healthy` у обоих контейнеров (после короткого start period)
- health endpoints возвращают OK
- `baseline-check.sh` возвращает `[OK]` или `[ATTENTION]` с понятными log signals

### How to verify
Если есть `[ATTENTION]`/`[FAIL]`, открыть последние логи:
```bash
docker logs --since 15m --tail 200 ai-gateway
docker logs --since 15m --tail 200 t2-call-summary
```

### If the result is different
Сначала восстановить контейнеры и `healthz`, затем разбирать сигналы:
- `main app 5xx / crash`
- `ai-gateway failures`
- `Polza upstream failures`
- `Telegram delivery failures`
- `DB connectivity failures`

Подробный runbook: `MONITORING_BASELINE.md`.
