# t2-call-summary-mvp

Node.js/Express сервис для обработки звонков:
`t2 call event -> transcript analysis (AI gateway) -> Telegram summary`.

## Текущий этап

Проект переведён на gateway-based AI routing и локально подтверждён end-to-end маршрут через Polza:

- runtime storage работает через PostgreSQL
- `/healthz` проверяет доступность БД
- `ai-gateway` выделен как отдельный слой AI-интеграции
- fixed provider strategy: **Polza as upstream AI provider**
- локально подтверждён полный маршрут:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- production Polza cutover на existing Yandex VM: **next active step**
- direct OpenAI runtime path не используется как target strategy

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

## Production target

Текущий целевой контур:

- 1 VM в Yandex Compute Cloud
- 1 контейнер с main app
- 1 контейнер с `ai-gateway`
- Yandex Managed Service for PostgreSQL
- Yandex Container Registry для образа(ов)
- env variables сейчас, Lockbox позже
- регион: `ru-central1`
- бизнес-таймзона: `Europe/Moscow`

## AI provider strategy

Фиксированное решение на текущем этапе:

- `ai-gateway` остаётся boundary для анализа звонков
- upstream provider target: **Polza**
- локальный end-to-end через `ai-gateway` и Polza уже доказан
- main app direct OpenAI runtime path не нужен для текущей стратегии
- отдельная gateway VM в другом регионе не требуется

Следующий production шаг:

- cutover `ai-gateway` на existing Yandex VM
- первый production smoke для полного маршрута через Polza

Целевой production path после production smoke:

- main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram

## Runtime naming status (current vs target)

Current runtime names in code (до отдельного code cutover):

- main app: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` secret: `GATEWAY_SHARED_SECRET`
- `ai-gateway` provider vars: `OPENAI_*`

Target naming after code cutover:

- `GATEWAY_SHARED_SECRET -> AI_GATEWAY_SHARED_SECRET`
- `OPENAI_* -> POLZA_*`

Status:

- стратегия Polza зафиксирована
- naming/code cutover ещё выполняется и не должен считаться завершённым до отдельного smoke

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

Локально подтверждённое значение для main app -> gateway routing:

- `AI_GATEWAY_URL=http://127.0.0.1:3001`

### AI gateway

Target provider env after code cutover:

- `POLZA_API_KEY`
- `POLZA_BASE_URL`
- `POLZA_MODEL`
- `AI_GATEWAY_SHARED_SECRET`

Current runtime names in gateway code (temporary transitional state):

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TIMEOUT_MS`
- `GATEWAY_SHARED_SECRET`

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

Current active next step:
- deploy `ai-gateway` to the existing Yandex VM
- set production `AI_GATEWAY_URL` for local VM routing
- prepare production `gateway.env`
- run production end-to-end smoke for the Polza-backed path

Important:
- do not mark the Polza production cutover as complete until VM smoke passes
- naming cleanup is still a separate follow-up step

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
