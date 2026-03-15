# t2-call-summary-mvp

Node.js/Express сервис для обработки звонков:
`t2 call event -> transcript analysis (AI gateway) -> Telegram plain-text summary`.

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
- lightweight monitoring baseline выкачен на production VM и production verification успешно пройдена
- production ingest hardening для `POST /api/process-call` выкачен и validated (`401/400/200`, Telegram `sent`, transcript в лог не течёт)
- подготовлен integration-ready Tele2 ingest adapter этап (feature-gated, без full cutover)
- Tele2 adapter выкачен на production VM в safe mode (`TELE2_INGEST_ENABLED=false`) и verified
- production manual E2E для STT bridge подтверждён:
  - Tele2 mp3 -> `ai-gateway /transcribe` -> Polza -> `/api/process-call` -> Telegram
- production STT default model: `openai/gpt-4o-mini-transcribe`
- `openai/whisper-1` протестирован как candidate и отклонён для production switch
- scheduled production rollout для `tele2:poll-once` через systemd timer подтверждён
- baseline phase закрыта; активирована post-baseline improvement wave #1
- `Telegram message format v2.1` завершён как отдельный узкий workstream
- post-incident hardening (`Tele2 poller auth/env + ops access baseline`) выкачен как отдельный узкий workstream
- последний завершённый узкий pass: Telegram callback polling via `getUpdates` for transcript button flow (без public webhook requirement)
- анализ идёт только для calls с conversation duration `> 5 sec`; missed/short calls пропускаются до этапа транскрибации

## Telegram message format v2.1 (completed workstream)

Что меняется в этой волне:

- только текст Telegram-уведомления
- формат только plain text (без Markdown/HTML)
- один звонок -> один primary scenario

Canonical message shape:

```text
Кто звонил: +79999999999
Когда звонил: 15:13, 14.03

Что хотели: Клиент из компании ООО "Станок 77" запросил запчасти и указал номер заказа №100.

Категория: Запчасти

Компания: ООО "Станок 77"
Номер заказа: 100
```

Правила v2.1:

- обязательные поля: `Кто звонил`, `Когда звонил`, `Что хотели`, `Категория`
- поддерживаемые primary scenario: `Запчасти`, `Аренда`, `Ремонт`, `Доставка` (безопасный fallback сохранён)
- secondary details остаются внутри `Что хотели` и не выводятся отдельными `Просили ...` строками
- при явном упоминании `Компания` и `Номер заказа` встраиваются в `Что хотели` и дополнительно печатаются отдельными строками внизу
- если компания/номер заказа не были явно названы, эти строки не выводятся
- служебные status-like хвосты (`запрос принят`, `зарегистрирован`, `взято в работу`, `обработано`) в `Что хотели` не выводятся
- old fields/blocks (`Следующий шаг`, internal line metadata, transcript excerpts) не выводятся
- для fuzzy relative дат не придумывается точная календарная дата

## Transcript storage + Telegram `.txt` button (completed baseline)

Цель:

- сохранять полный transcript один раз в pipeline для анализируемых звонков
- отдавать transcript из storage по Telegram inline button без повторной транскрибации

Runtime behavior:

- после успешной обработки звонка summary отправляется как раньше
- под summary добавляется inline button `Транскрипт (.txt)`
- callback содержит `call_event_id`, по которому app читает сохранённый transcript из БД
- app отправляет `.txt` документ в тот же Telegram chat
- если transcript отсутствует (исторический/edge-case), отправляется fallback:
  - `Транскрипт для этого звонка не сохранён.`

## Telegram callback updates via `getUpdates` (completed narrow pass)

Цель:

- сделать callback flow рабочим в production без `PUBLIC_APP_URL` и без публичного HTTPS webhook ingress

Runtime behavior:

- main app запускает polling цикла Telegram updates (`getUpdates`)
- обрабатываются только `callback_query` updates
- обрабатываются только callback data вида `transcript:<call_event_id>`
- для callback используется существующая transcript `.txt` логика из storage (без повторной транскрибации)
- offset updates сохраняется в БД и восстанавливается после restart
- webhook endpoint (`/api/telegram/webhook`) сохраняется как optional fallback
- polling offset двигается только после успешной обработки callback update (failed callback не теряется)
- текущая operational модель предполагает один active instance main app для polling-consumer
- live verification confirmed on `2026-03-15`:
  - summary message delivered
  - inline button `Транскрипт (.txt)` visible in Telegram
  - real button click delivers transcript `.txt` file

Skip-policy for Tele2 poll runtime:

- missed calls не анализируются
- calls с conversation duration `<= 5 sec` не анализируются
- только calls с conversation duration `> 5 sec` идут в download/transcribe/analyze pipeline
- skip применяется до дорогих шагов (транскрибация/AI)

## Текущая архитектура

- `src/server.js`: HTTP API, health endpoints, bootstrap
- `src/services/callProcessor.js`: основная бизнес-логика обработки звонка
- `src/services/gatewayAnalyzeCall.js`: интеграция main app -> `ai-gateway`
- `src/storage/postgresStorage.js`: storage abstraction + PostgreSQL реализация
- `migrations/001_init.sql`: минимальная production-схема БД
- `migrations/002_tele2_polled_records.sql`: durable dedup для one-shot Tele2 polling
- `migrations/003_call_events_transcript_text.sql`: full transcript storage в `call_events`
- `migrations/004_telegram_update_offsets.sql`: persistent offset state для Telegram `getUpdates`
- `src/scripts/migrate.js`: применение миграций
- `src/scripts/importJsonBootstrap.js`: одноразовый импорт legacy JSON
- `src/scripts/pollTele2RecordsOnce.js`: one-shot Tele2 polling (`npm run tele2:poll-once`)
- `src/services/telegramTranscriptService.js`: callback handler для выдачи transcript `.txt`
- `src/services/telegramUpdatePollingService.js`: polling handler для Telegram `getUpdates` callback flow
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

Подтверждённый production ingest endpoint не менялся:

- `POST /api/process-call` (strict validation + optional `INGEST_SHARED_SECRET`)

Подготовлен отдельный Tele2 integration entrypoint:

- `POST /api/ingest/tele2`
- использует тот же ingress auth header `X-Ingest-Secret`
- по умолчанию выключен (`TELE2_INGEST_ENABLED=false`)
- fail-safe rule: если `TELE2_INGEST_ENABLED=true` и `INGEST_SHARED_SECRET` пустой, endpoint возвращает `503 TELE2_INGEST_MISCONFIGURED`
- поддерживает безопасный dry-run (`X-Ingest-Dry-Run: true` или `?dryRun=1`)
- после нормализации идёт в тот же канонический pipeline `processCall` (без обхода `ai-gateway`)
- в текущем production state (flag off) endpoint ожидаемо отвечает:
  - HTTP `503`
  - `code=TELE2_INGEST_DISABLED`

`POST /dev/t2-ingest` остаётся scaffold/debug-маршрутом.

### Tele2 status (high-level)

Что важно зафиксировать без двусмысленности:

- Tele2 ingest adapter (`POST /api/ingest/tele2`) **implemented, но feature-gated**
  - production safe state: `TELE2_INGEST_ENABLED=false`
  - это **не** primary production ingest path на текущем этапе
- STT bridge через Tele2 mp3 -> `ai-gateway /transcribe` -> Polza -> `/api/process-call` **validated manually**
- scheduled `tele2:poll-once` через systemd timer **enabled/validated**
- production STT default остаётся `openai/gpt-4o-mini-transcribe`
- `openai/whisper-1` проверен как candidate и отклонён для production switch

Подробные runbook/checklists и status details:

- `DEPLOY_PROGRESS.md` — operational status и текущий milestone
- `TASKS.md` — execution checklist и next actions
- `ops/systemd/` и `ops/logrotate/` — VM ops templates

### Tele2 token regeneration warning (strict)

В Tele2 ATS API keys действует жёсткое правило:

- при повторной генерации предыдущие токены становятся недействительными

Следствие для операций:

- **не** регенерировать access/refresh pair заранее «на всякий случай»
- регенерацию делать только как controlled step, когда одновременно готовы:
  1. сразу обновить env/secret
  2. сразу перезапустить сервис
  3. сразу выполнить verification
  4. при необходимости сразу откатить/повторить шаг
- правило одинаково для `.env`, `/opt/t2-call-summary/main.env` и `/opt/t2-call-summary/tele2-poll.env`

### Tele2 poller incident hardening (`2026-03-14`)

Что зафиксировано:

- incident date: `2026-03-14`
- root cause: missing/invalid `T2_API_TOKEN` / `T2_REFRESH_TOKEN` in `/opt/t2-call-summary/tele2-poll.env`
- symptom chain: `403` -> `poll_once_failed` -> `token_refresh_skipped_missing_refresh_token` -> Telegram silence
- current runtime hardening in wrapper:
  - fail-fast env validation before poll run
  - explicit structured error logs for missing/invalid/expired auth state
  - explicit non-zero exit for auth-env misconfiguration (`exitCode=4`)

Required poller auth env:

- `T2_API_TOKEN` (fallback `T2_ACCESS_TOKEN` is still accepted)
- `T2_REFRESH_TOKEN`

Post-fix production verification (run on VM):

```bash
sudo awk -F= '
/^T2_API_TOKEN=/{print "T2_API_TOKEN length=" length($2)}
/^T2_REFRESH_TOKEN=/{print "T2_REFRESH_TOKEN length=" length($2)}
' /opt/t2-call-summary/tele2-poll.env

START_TS="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"; echo "START_TS=$START_TS"
sudo systemctl daemon-reload
sudo systemctl restart t2-tele2-poll.service
sudo systemctl status t2-tele2-poll.service --no-pager
sudo systemctl status t2-tele2-poll.timer --no-pager
sudo systemctl list-timers | grep t2-tele2-poll

sudo journalctl -u t2-tele2-poll.service --since "$START_TS" --no-pager \
| grep -En 'status 403|T2_INFO_HTTP_ERROR|token_refresh_skipped_missing_refresh_token|poll_once_failed|status=3/NOTIMPLEMENTED' || true

sudo journalctl -u t2-tele2-poll.service --since "$START_TS" --no-pager \
| grep -En 'poll_once_start|poll_once_finished|tele2_poll_once_started|tele2_poll_once_finished|"exitCode":"0"|"exitCode":0' || true
```

Success looks like:

- token lengths are non-zero
- timer is `active (waiting)`
- no new `403` / `missing_refresh_token` signatures after `START_TS`
- `poll_once_finished` with `exitCode=0`
- `fetched: 0` is acceptable if there were no new calls in the window

Ops access baseline (to avoid SSH lockout during incidents):

- keep `sg-t2-vm` SSH ingress aligned with the current operator IP allowlist
- keep at least one known-good recovery path documented (`yc compute connect-to-serial-port ...`)
- do not mix SSH/SG access issues with app runtime diagnosis; treat them as separate ops incidents

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
- `TELEGRAM_WEBHOOK_SECRET` (optional, для валидации `X-Telegram-Bot-Api-Secret-Token`)
- `TELEGRAM_UPDATES_POLLING_ENABLED=true` (primary callback path, no public webhook required)
- `TELEGRAM_UPDATES_POLL_TIMEOUT_SEC=8`
- `TELEGRAM_UPDATES_POLL_IDLE_DELAY_MS=400`
- `TELEGRAM_UPDATES_POLL_ERROR_DELAY_MS=3000`
- `TELEGRAM_UPDATES_POLL_MAX_BATCH_SIZE=25`
- `TELEGRAM_UPDATES_OFFSET_KEY=transcript_callback`
- `TELEGRAM_UPDATES_CLEAR_WEBHOOK_ON_START=true`
- `TELEGRAM_UPDATES_SKIP_BACKLOG_ON_FIRST_START=false`

Пояснение по polling flags:

- `TELEGRAM_UPDATES_CLEAR_WEBHOOK_ON_START=true`: на старте main app удаляет активный webhook, чтобы исключить конфликт webhook/getUpdates режимов
- `TELEGRAM_UPDATES_SKIP_BACKLOG_ON_FIRST_START=false`: не пропускает pending callback updates на первом старте (без потери нажатий)
- `TELEGRAM_UPDATES_POLL_TIMEOUT_SEC` должен быть меньше `TELEGRAM_API_TIMEOUT_MS` (runtime дополнительно ограничивает timeout автоматически)
- `INGEST_SHARED_SECRET` (опционально для `POST /api/process-call`, но обязателен если `TELE2_INGEST_ENABLED=true`)
- `TELE2_INGEST_ENABLED=false` (включать только на controlled rollout)
- `TELE2_PHONE_FIELD_PATH`, `TELE2_CALL_DATETIME_FIELD_PATH`, `TELE2_TRANSCRIPT_FIELD_PATH` (заполнять только после подтверждения Tele2 payload)
- `T2_AUTH_SCHEME=plain`
- `T2_TIMEZONE_OFFSET=+03:00`
- `TELE2_POLL_LOOKBACK_MINUTES=60`
- `TELE2_POLL_FETCH_LIMIT=30`
- `TELE2_POLL_MAX_CANDIDATES=10`
- `TELE2_POLL_MIN_AUDIO_BYTES=4096`
- `TELE2_POLL_DRY_RUN=false`
- `TELE2_POLL_RETRY_FAILED=true`
- `TELE2_POLL_TIMEOUT_MS=180000` (wrapper env for scheduled runs)
- `T2_API_TOKEN` (required for Tele2 polling wrapper run)
- `T2_REFRESH_TOKEN` (required for Tele2 polling wrapper run)
- `T2_API_TOKEN`/`T2_REFRESH_TOKEN` регенерировать только в controlled rollout window (старые токены сразу инвалидируются)
- `T2_REFRESH_AUTH_SCHEME=plain`
- `TELE2_POLL_TOKEN_REFRESH_ENABLED=true`
- `TELE2_POLL_TOKEN_REFRESH_ON_403=true`
- `TELE2_POLL_TOKEN_REFRESH_LEEWAY_SECONDS=900`
- `TELE2_POLL_TRANSCRIBE_MODEL` (optional primary override for `tele2:poll-once`)
- `TELE2_POLL_COMPARE_TRANSCRIBE_MODEL` (optional compare model for `tele2:poll-once`, dry-run only)
- `PROCESS_CALL_URL=http://127.0.0.1:3000/api/process-call`
- `AI_GATEWAY_TRANSCRIBE_PATH=/transcribe`

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
- `POLZA_TRANSCRIBE_MODEL` (default: `openai/gpt-4o-mini-transcribe`)
- `POLZA_TRANSCRIBE_MODEL_CANDIDATE` (optional, for opt-in compare tests, e.g. `openai/whisper-1`)
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

Проверка нового формата Telegram v2 локально (без отправки в Telegram API):

```bash
npm run smoke:telegram-v2
```

Smoke script проверяет:
- сценарии `Запчасти` / `Аренда` / `Ремонт` / `Доставка`
- exact relative date и fuzzy relative date поведение
- optional-поля (`Компания`, `Номер заказа`) в режимах present/absent
- fallback safety для legacy payload

Проверка transcript button flow локально (mocked Telegram API, без реальной отправки):

```bash
npm run smoke:transcript-button
```

Проверка callback polling path локально (`getUpdates` + offset, mocked Telegram API):

```bash
npm run smoke:telegram-callback-polling
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
- during Tele2 adapter rollout `ai-gateway` runtime/image was not changed
- production env safety state:
  - `TELE2_INGEST_ENABLED=false`
  - `INGEST_SHARED_SECRET` is set (non-empty)
  - `AI_GATEWAY_URL=http://ai-gateway:3001`

Current next follow-ups:
- keep `Telegram message format v2.1` as completed baseline
- keep transcript storage + `.txt` button flow as completed baseline
- keep callback polling (`getUpdates`) behavior stable after deploy updates
- run post-fix poller verification after each token/env update
- keep SSH/SG access baseline documented and verified
- keep topology and production routing unchanged
- keep ignored numbers / owner routing / poll interval unchanged in this wave
- keep STT default unchanged (`openai/gpt-4o-mini-transcribe`)
- keep `TELE2_INGEST_ENABLED=false` until explicit webhook/cutover phase

Important:
- production Polza cutover на existing Yandex VM уже подтверждён
- production runtime naming в `ai-gateway` использует `AI_GATEWAY_SHARED_SECRET` и `POLZA_*`

## Minimal monitoring baseline

For the current single-VM + Docker production baseline, lightweight monitoring is implemented, deployed, and validated:

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
- Telegram callback primary path: `getUpdates` polling from main app runtime
- `POST /api/telegram/webhook` — optional fallback callback endpoint
  - если задан `TELEGRAM_WEBHOOK_SECRET`, endpoint ожидает заголовок `X-Telegram-Bot-Api-Secret-Token`

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
