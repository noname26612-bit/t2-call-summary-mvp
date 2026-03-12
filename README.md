# t2-call-summary-mvp

Node.js/Express сервис для обработки звонков:
`t2 call event -> transcript analysis (AI gateway) -> Telegram summary`.

## Текущий этап

Проект переведён с локального JSON MVP на production foundation:

- runtime storage работает через PostgreSQL
- миграции добавлены и обязательны
- `/healthz` проверяет доступность БД
- Dockerfile готов для контейнерного деплоя
- structured logging включён (JSON logs)
- graceful shutdown добавлен

## Текущая архитектура

- `src/server.js`: HTTP API, health endpoints, bootstrap
- `src/services/callProcessor.js`: основная бизнес-логика обработки звонка
- `src/services/gatewayAnalyzeCall.js`: интеграция main app -> external ai-gateway
- `src/storage/postgresStorage.js`: storage abstraction + PostgreSQL реализация
- `migrations/001_init.sql`: минимальная production-схема БД
- `src/scripts/migrate.js`: применение миграций
- `src/scripts/importJsonBootstrap.js`: одноразовый импорт legacy JSON

## Storage source of truth

`data/*.json` больше **не** source of truth для runtime.

JSON-файлы используются только как legacy-источник для одноразового импорта в PostgreSQL:

```bash
npm run import:json
```

## Production target

Текущий целевой контур:

- 1 VM в Yandex Compute Cloud
- 1 контейнер с этим сервисом
- Yandex Managed Service for PostgreSQL
- Yandex Container Registry для образа
- env variables сейчас, Lockbox позже
- регион: `ru-central1`
- бизнес-таймзона: `Europe/Moscow`


## Expected load / Current load baseline

- total calls: `100-200/day`
- analyzed calls: `100-150/day`

Для текущего этапа этот объём считается покрываемым текущей архитектурой:

- 1 VM (Yandex Compute Cloud)
- 1 Node.js/Express сервис
- 1 managed PostgreSQL

Topology changes (worker/queue/extra services) не требуются на этом этапе и должны рассматриваться только после first deploy на основе реальных метрик нагрузки, latency и ошибок.

## t2 ingest статус

`POST /dev/t2-ingest` остаётся scaffold/debug-маршрутом.

На текущем этапе приоритет: production foundation (стабильный runtime + deploy),
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

Local PostgreSQL-based smoke baseline has already passed.

Canonical operational progress log:
- `DEPLOY_PROGRESS.md`

Current active next step:
- deploy `ai-gateway` in supported region
- set `AI_GATEWAY_*` env on main app VM
- restart main app container
- run first end-to-end smoke for `main app -> ai-gateway -> OpenAI`

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

## Docker flow

Сборка:

```bash
docker build -t t2-call-summary-mvp:latest .
```

Запуск:

```bash
docker run --rm -p 3000:3000 --env-file .env t2-call-summary-mvp:latest
```

`docker-entrypoint.sh` сначала запускает миграции, затем стартует сервис.

## Yandex Cloud deploy notes

Короткий пошаговый deploy guide: `DEPLOYMENT_YC.md`.
Локальный проверочный сценарий: `SMOKE_TEST.md`.
