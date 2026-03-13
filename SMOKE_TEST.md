# SMOKE_TEST.md

Beginner-friendly smoke guide for the confirmed local Polza-backed path and the already-passed production baseline on the existing Yandex VM.

## Confirmed local smoke result

Local end-to-end smoke is already confirmed for the target routing:

- main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram

Confirmed locally:
- `GET /healthz` for `ai-gateway` returns OK
- `POST /analyze` returns structured analysis through Polza
- `GET /healthz` for main app returns OK with `database=ok`
- `POST /api/process-call` returns `processed`
- Telegram delivery status is `sent`

## Confirmed production smoke result on the existing Yandex VM

Confirmed in production:
- main app and `ai-gateway` run as separate Docker containers on the same existing Yandex VM
- container-to-container routing uses user-defined Docker network `t2-app-net`
- production main app uses `AI_GATEWAY_URL=http://ai-gateway:3001`
- `GET /healthz` for `ai-gateway` on VM returns OK
- `GET /healthz` for main app on VM returns OK with `database=ok`
- `POST /api/process-call` on VM returned `processed`
- `ai-gateway` logs confirmed successful `POST /analyze` through Polza
- Telegram delivery status in production smoke is `sent`
- current production route:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram

## Important local routing note

For the local main app to gateway connection, use:

```env
AI_GATEWAY_URL=http://127.0.0.1:3001
```

Do not rely on `localhost` here unless it is explicitly re-verified in the current environment, because local resolution can differ and lead to avoidable gateway network errors.

## Important production routing note

For the current production baseline on the existing Yandex VM:

- main app and `ai-gateway` run as separate Docker containers on the same VM
- container-to-container routing uses Docker network `t2-app-net`
- production `AI_GATEWAY_URL` must be `http://ai-gateway:3001`
- `127.0.0.1:3001` is acceptable only for host-level checks from the VM, not as the main app container runtime URL

## Before you start

- Открой терминал.
- Перейди в папку проекта:

```bash
cd /Users/nonamenoname/Documents/Транскрибация/t2-call-summary-mvp
```

- Все команды ниже выполняются в этой папке, если не указано иное.

## Runtime naming status (important)

Canonical runtime names in `ai-gateway` code:

- `AI_GATEWAY_SHARED_SECRET`
- `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TIMEOUT_MS`

## Step 1. Install dependencies and prepare env files

### What we are doing
Устанавливаем зависимости и готовим env для main app и gateway.

### Why we are doing it
Без env и зависимостей сервисы не стартуют.

### Where to run
Терминал, в папке проекта.

### Command
```bash
npm install
cd ai-gateway && npm install && cd ..
cp .env.example .env
cp ai-gateway/.env.example ai-gateway/.env
```

### Expected result
Оба `.env` файла существуют и пакеты установлены.

### How to verify
```bash
ls -la .env ai-gateway/.env
```

### If the result is different
Проверь Node.js (рекомендуется 18+ для main app, 20+ для gateway) и повтори шаг.

## Step 2. Configure local env values

### What we are doing
Заполняем минимальные переменные окружения.

### Why we are doing it
Нужны реальные ключи и URL для end-to-end проверки.

### Where to run
Редактор файлов `.env` и `ai-gateway/.env`.

### Exact values to check
Main app `.env`:
- `AI_GATEWAY_URL=http://127.0.0.1:3001`
- `AI_GATEWAY_SHARED_SECRET=<same_shared_secret_as_gateway>`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `DB_*` или `DATABASE_URL`

Gateway `ai-gateway/.env`:
- `PORT=3001`
- `AI_GATEWAY_SHARED_SECRET=<same_shared_secret_as_main_app>`
- `POLZA_API_KEY=<polza-api-key>`
- `POLZA_BASE_URL=https://polza.ai/api/v1` (или ваш runtime URL)
- `POLZA_MODEL=<polza-model>`
- `POLZA_TIMEOUT_MS=20000`

### Expected result
Оба env файла заполнены согласованными значениями.

### How to verify
Секрет в main app и gateway совпадает.

### If the result is different
Исправь env и перезапусти сервисы перед следующими шагами.

## Step 3. Apply database migrations

### What we are doing
Применяем SQL-миграции к PostgreSQL.

### Why we are doing it
Таблицы должны существовать до старта main app.

### Where to run
Терминал, папка проекта.

### Command
```bash
npm run migrate
```

### Expected result
Команда завершилась без ошибок.

### How to verify
Нет `ECONNREFUSED`, `authentication failed`, `database does not exist`.

### If the result is different
Исправь `DB_*` в `.env` и повтори миграции.

## Step 4. Start ai-gateway

### What we are doing
Запускаем gateway-сервис.

### Why we are doing it
Main app отправляет анализ только через gateway.

### Where to run
Терминал №1.

### Command
```bash
cd ai-gateway
npm run dev
```

### Expected result
В логах есть `server_started` и порт `3001`.

### How to verify
```bash
curl -s http://127.0.0.1:3001/healthz
```
Ожидается: `{"status":"ok"}`.

### If the result is different
Проверь `ai-gateway/.env` и первую ошибку в логах.

## Step 5. Start main app

### What we are doing
Запускаем основной API-сервис.

### Why we are doing it
Он принимает `/api/process-call` и вызывает gateway.

### Where to run
Терминал №2.

### Command
```bash
cd /Users/nonamenoname/Documents/Транскрибация/t2-call-summary-mvp
npm run dev
```

### Expected result
В логах есть `server_started`.

### How to verify
```bash
curl -s http://127.0.0.1:3000/healthz
```
Ответ содержит `"status":"ok"` и `"database":"ok"`.

### If the result is different
Проверь `DB_*` и доступность gateway URL.

## Step 6. Validate processed scenario

### What we are doing
Отправляем валидный звонок в main app.

### Why we are doing it
Проверяем основной успешный pipeline.

### Where to run
Терминал №3.

### Command
```bash
curl -s -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+7 (999) 123-45-67",
    "callDateTime": "2026-03-13T15:30:00+03:00",
    "transcript": "Клиент хочет купить оборудование, просит коммерческое предложение и срок поставки."
  }'
```

### Expected result
- HTTP 200
- `status = "processed"`
- `analysis.category` в целевом enum

### How to verify
Проверь JSON-ответ и логи в терминалах №1 и №2.

### If the result is different
Если 5xx, проверь shared secret, gateway URL и provider credentials.

## Step 7. Validate ignored scenario

### What we are doing
Отправляем номер из ignore-list.

### Why we are doing it
Проверяем фильтрацию внутренних звонков.

### Where to run
Терминал №3.

### Command
```bash
curl -s -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79990000001",
    "callDateTime": "2026-03-13T15:35:00+03:00",
    "transcript": "Тестовый внутренний звонок"
  }'
```

### Expected result
- HTTP 200
- `status = "ignored"`
- `reason = "internal_phone"`

### How to verify
Проверь JSON-ответ.

### If the result is different
Проверь `IGNORED_PHONES` и перезапусти main app.

## Step 8. Validate duplicate scenario

### What we are doing
Дважды отправляем одинаковый payload.

### Why we are doing it
Проверяем dedup логику.

### Where to run
Терминал №3.

### Command
```bash
curl -s -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79995554433",
    "callDateTime": "2026-03-13T16:00:00+03:00",
    "transcript": "Клиент интересуется арендой оборудования на неделю."
  }'

curl -s -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79995554433",
    "callDateTime": "2026-03-13T16:00:00+03:00",
    "transcript": "Клиент интересуется арендой оборудования на неделю."
  }'
```

### Expected result
- 1-й вызов: `processed`
- 2-й вызов: `duplicate`

### How to verify
Сравни ответы первого и второго запроса.

### If the result is different
Проверь, что payload полностью идентичен в обоих запросах.

## Step 9. Verify DB writes

### What we are doing
Проверяем, что записи появились в PostgreSQL.

### Why we are doing it
Smoke должен подтверждать не только HTTP, но и данные в БД.

### Where to run
SQL-клиент, подключённый к БД из `.env`.

### SQL commands
```sql
SELECT id, status, reason, telegram_status, created_at
FROM call_events
ORDER BY id DESC
LIMIT 10;

SELECT id, dedup_key, call_event_id, status, phone_normalized, call_datetime_raw, created_at, updated_at
FROM processed_calls
ORDER BY id DESC
LIMIT 20;

SELECT s.id, s.category, s.topic, s.confidence, s.created_at
FROM summaries s
ORDER BY s.id DESC
LIMIT 10;

SELECT id, call_event_id, event_type, created_at
FROM audit_events
ORDER BY id DESC
LIMIT 20;

SELECT id, call_event_id, status, http_status, error_code, created_at
FROM telegram_deliveries
ORDER BY id DESC
LIMIT 20;
```

### Expected result
Записи соответствуют выполненным HTTP-вызовам.

### How to verify
Сопоставь последние записи с шагами 6-8.

### If the result is different
Проверь логи main app и gateway, затем повтори тест.

## Step 10. Validate upstream failure handling

### What we are doing
Искусственно вызываем ошибку у upstream provider.

### Why we are doing it
Проверяем корректную обработку ошибок внешнего AI-провайдера.

### Where to run
Редактор `ai-gateway/.env`, затем терминалы №1/№2/№3.

### Action
1. Укажи невалидный Polza API key в `ai-gateway/.env`.
2. Перезапусти gateway и main app.
3. Повтори запрос `POST /api/process-call`.

### Expected result
- HTTP 502
- в main app появляется статус `failed`
- в audit trail есть событие failure

### How to verify
Проверь HTTP-ответ, логи сервисов и таблицы `call_events`/`audit_events`.

### If the result is different
Проверь, что сервисы точно перезапущены после изменения env.

## Step 11. Smoke pass criteria

Smoke-тест можно считать успешным, если:

- `GET /healthz` стабильно возвращает `status=ok` и `database=ok`
- сценарии `processed`, `ignored`, `duplicate` работают как ожидается
- при upstream failure сервис возвращает управляемую ошибку
- в БД корректно заполняются `call_events`, `processed_calls`, `summaries`, `audit_events`, `telegram_deliveries`
- категории в runtime-ответах только из целевого enum

Current status note:

- локальный smoke для маршрута `main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram` уже подтверждён
- production smoke на existing Yandex VM уже подтверждён для маршрута `main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram`
- production main app container uses `AI_GATEWAY_URL=http://ai-gateway:3001` через `t2-app-net`
- `127.0.0.1:3001` и `127.0.0.1:3000` используются только для host-level checks с VM
- runtime naming cleanup для `ai-gateway` уже применён (`AI_GATEWAY_SHARED_SECRET`, `POLZA_*`)
