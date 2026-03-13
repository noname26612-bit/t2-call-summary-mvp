# t2-call-summary-mvp

Node.js/Express сервис для обработки звонков:
`t2 call event -> transcript analysis (AI gateway) -> Telegram summary`.

## Текущий этап

Production Polza cutover на existing Yandex VM завершён и подтверждён production smoke:

- runtime storage работает через PostgreSQL
- `/healthz` проверяет доступность БД
- `ai-gateway` выделен как отдельный слой AI-интеграции
- fixed provider strategy: **Polza as upstream AI provider**
- подтверждён текущий production route:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- main app и `ai-gateway` работают как отдельные Docker containers на одной existing Yandex VM
- container-to-container routing uses user-defined Docker network `t2-app-net`
- production main app uses `AI_GATEWAY_URL=http://ai-gateway:3001`
- `127.0.0.1:3001` используется только для host-level checks с VM, а не как production container runtime URL
- direct OpenAI runtime path больше не является активным production route
- external EU/VPS gateway host не используется
- naming cleanup for `ai-gateway` env completed (`AI_GATEWAY_SHARED_SECRET`, `POLZA_*`)

## Текущая архитектура

- `src/server.js`: HTTP API, health endpoints, bootstrap
- `src/services/callProcessor.js`: основная бизнес-логика обработки звонка
- `src/services/gatewayAnalyzeCall.js`: интеграция main app -> `ai-gateway`
- `src/storage/postgresStorage.js`: storage abstraction + PostgreSQL реализация
- `migrations/001_init.sql`: минимальная production-схема БД
- `src/scripts/migrate.js`: применение миграций
- `src/scripts/importJsonBootstrap.js`: одноразовый импорт legacy JSON
- `ai-gateway/`: thin AI integration service between main app and provider

## Storage source of truth

`data/*.json` больше **не** source of truth для runtime.

JSON-файлы используются только как legacy-источник для одноразового импорта в PostgreSQL:

```bash
npm run import:json
```

## Current production baseline

Текущий подтверждённый production contour:

- 1 existing VM в Yandex Compute Cloud
- 1 контейнер с main app
- 1 контейнер с `ai-gateway`
- user-defined Docker network `t2-app-net` для container-to-container routing
- Yandex Managed Service for PostgreSQL
- Yandex Container Registry для образа(ов)
- env variables сейчас, Lockbox позже
- регион: `ru-central1`
- бизнес-таймзона: `Europe/Moscow`

## AI provider strategy

Фиксированное решение на текущем этапе:

- `ai-gateway` остаётся boundary для анализа звонков
- production upstream provider: **Polza**
- production cutover на existing Yandex VM уже подтверждён
- current production route:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- main app container runtime uses `http://ai-gateway:3001`
- `curl http://127.0.0.1:3001/healthz` подходит только для host-level checks с VM
- main app direct OpenAI runtime path больше не является активным production route
- внешний EU/VPS gateway host не используется
- отдельная gateway VM в другом регионе не требуется

## Runtime naming status

Canonical runtime naming:

- main app: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` secret: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` provider vars: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TIMEOUT_MS`

Status:

- стратегия Polza зафиксирована
- production smoke уже подтверждён
- naming cleanup для `ai-gateway` runtime и env/docs выполнен

## Expected load / Current load baseline

- total calls: `100-200/day`
- analyzed calls: `100-150/day`

Для текущего этапа этот объём считается покрываемым текущей архитектурой:

- 1 VM (Yandex Compute Cloud)
- 1 main app service
- 1 `ai-gateway` service
- 1 managed PostgreSQL

Topology changes (worker/queue/extra services) не требуются на этом этапе и должны рассматриваться только после реальных production metrics по нагрузке, latency и ошибкам.

## t2 ingest статус

`POST /dev/t2-ingest` остаётся scaffold/debug-маршрутом.

На текущем этапе приоритет: stable production routing (runtime + provider cutover + deploy),
а не углубление реального t2 production ingest.

## Business categories (документированная целевая модель)

Целевые категории:

- продажа
- сервис
- запчасти
- аренда
- спам
- прочее

Runtime и документация синхронизированы с этим enum.
Для legacy-значений (например `ремонт`, `покупка_станка`, `доставка`) в normalizer есть явный mapping в новый enum.

## Минимальные env

### Main app

Обязательные:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (или `DATABASE_URL`)
- `AI_GATEWAY_URL`
- `AI_GATEWAY_SHARED_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Рекомендуемые:

- `APP_TIMEZONE=Europe/Moscow`
- `LOG_LEVEL=info`
- `IGNORE_LIST_BOOTSTRAP_FROM_ENV=true`
- `AI_GATEWAY_TIMEOUT_MS=20000`

Локальное значение для main app -> gateway routing:

- `AI_GATEWAY_URL=http://127.0.0.1:3001`

Текущее production значение на existing Yandex VM:

- `AI_GATEWAY_URL=http://ai-gateway:3001`
- Docker network: `t2-app-net`

Важно:

- `127.0.0.1:3001` допустим только для host-level checks с VM, но не как main app container runtime URL в production

### AI gateway

- `POLZA_API_KEY`
- `POLZA_BASE_URL`
- `POLZA_MODEL`
- `POLZA_TIMEOUT_MS`
- `AI_GATEWAY_SHARED_SECRET`

DB SSL modes (no ambiguity):

- basic first deploy path: `DB_SSL=false`
- advanced path later: `DB_SSL=true` + `DB_SSL_REJECT_UNAUTHORIZED=true` + CA/root cert

Шаблон: `.env.example`

## Local flow: migrate / import / run

```bash
npm install
cp .env.example .env
npm run migrate
npm run import:json   # опционально, если нужен перенос старых данных
npm run dev
```

## Current deployment status

Canonical operational progress log:
- `DEPLOY_PROGRESS.md`

Current stable local proof:
- main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram works locally
- gateway auth works
- Polza upstream path works
- Telegram delivery works

Current confirmed production baseline:
- main app и `ai-gateway` работают как отдельные Docker containers на одной existing Yandex VM
- canonical production container names:
  - main app: `t2-call-summary`
  - gateway: `ai-gateway`
- runtime container-to-container routing uses `t2-app-net`
- production main app uses `AI_GATEWAY_URL=http://ai-gateway:3001`
- `ai-gateway /healthz` на VM = ok
- `main app /healthz` на VM = ok
- `POST /api/process-call` на VM returned `processed`
- `ai-gateway` logs confirmed successful `POST /analyze` through Polza
- Telegram delivery status in production smoke = `sent`
- PostgreSQL topology unchanged
- Telegram integration unchanged
- old direct OpenAI path is not the active production runtime route
- external EU/VPS gateway host is not used

Current next follow-ups:
- rotate the exposed Polza API key if it has not already been rotated after local testing
- monitor real peak load / latency / failures before any topology changes

Important:
- production Polza cutover на existing Yandex VM уже подтверждён
- production runtime naming в `ai-gateway` использует `AI_GATEWAY_SHARED_SECRET` и `POLZA_*`

## Minimal monitoring baseline

For the current single-VM + Docker production baseline, lightweight monitoring is now documented and ready:

- Docker image-level `HEALTHCHECK` for main app and `ai-gateway`
- `/healthz` checks from VM
- log-based failure visibility for:
  - main app 5xx/crash
  - ai-gateway failures
  - Polza upstream failures
  - Telegram delivery failures
  - DB connectivity failures
- one command script: `scripts/monitoring/baseline-check.sh`

Runbook: `MONITORING_BASELINE.md`

## Execution note

This project is being developed in a beginner-friendly workflow.
Practical steps should be followed sequentially:

- run command
- verify output
- only then move to next step

If you change `.env`, restart the service before re-checking behavior.
If you change DB schema, run migrations before starting the app.
If you test duplicate/ignored flows, verify both HTTP response and PostgreSQL records.

## Health и smoke

- `GET /health` — базовая liveness проверка
- `GET /healthz` — проверка процесса + PostgreSQL

Пример:

```bash
curl -s http://localhost:3000/healthz
```

Host-level checks on the current Yandex VM:

```bash
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3000/healthz
```

## Docker flow

Сборка:

```bash
docker build -t t2-call-summary:latest .
```

Запуск:

```bash
docker run --rm -p 3000:3000 --env-file .env t2-call-summary:latest
```

`docker-entrypoint.sh` сначала запускает миграции, затем стартует сервис.

## Yandex Cloud deploy notes

Короткий пошаговый deploy guide: `DEPLOYMENT_YC.md`.
Monitoring/hardening runbook for the same baseline: `MONITORING_BASELINE.md`.
Локальный проверочный сценарий: `SMOKE_TEST.md`.
