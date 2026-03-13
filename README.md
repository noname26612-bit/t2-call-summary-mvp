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
- lightweight monitoring baseline выкачен на production VM и production verification успешно пройдена
- production ingest hardening для `POST /api/process-call` выкачен и validated (`401/400/200`, Telegram `sent`, transcript в лог не течёт)
- подготовлен integration-ready Tele2 ingest adapter этап (feature-gated, без full cutover)
- Tele2 adapter выкачен на production VM в safe mode (`TELE2_INGEST_ENABLED=false`) и verified
- production manual E2E для STT bridge подтверждён:
  - Tele2 mp3 -> `ai-gateway /transcribe` -> Polza -> `/api/process-call` -> Telegram
- следующий узкий milestone: scheduled production rollout для `tele2:poll-once` через systemd timer (без webhook/cutover)

## Текущая архитектура

- `src/server.js`: HTTP API, health endpoints, bootstrap
- `src/services/callProcessor.js`: основная бизнес-логика обработки звонка
- `src/services/gatewayAnalyzeCall.js`: интеграция main app -> `ai-gateway`
- `src/storage/postgresStorage.js`: storage abstraction + PostgreSQL реализация
- `migrations/001_init.sql`: минимальная production-схема БД
- `migrations/002_tele2_polled_records.sql`: durable dedup для one-shot Tele2 polling
- `src/scripts/migrate.js`: применение миграций
- `src/scripts/importJsonBootstrap.js`: одноразовый импорт legacy JSON
- `src/scripts/pollTele2RecordsOnce.js`: one-shot Tele2 polling (`npm run tele2:poll-once`)
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

### Manual one-record bridge test (temporary)

Для ручной проверки маршрута `Tele2 file -> ai-gateway transcription (Polza) -> /api/process-call` добавлен временный helper:

```bash
npm run manual:tele2-record -- 2026-03-13/177342115767354776
```

Минимальные env для helper:

- `T2_API_TOKEN` (или `T2_ACCESS_TOKEN`)
- `AI_GATEWAY_SHARED_SECRET`
- `INGEST_SHARED_SECRET` (если включён auth на `/api/process-call`)

По умолчанию helper использует:

- Tele2 base URL: `https://ats2.t2.ru/crm/openapi`
- Auth scheme: `Authorization: <token>` (`plain`)
- ai-gateway URL: `http://127.0.0.1:3001`
- process-call URL: `http://127.0.0.1:3000/api/process-call`

Helper:
- скачивает `mp3` через `GET /call-records/file?filename=...`
- пытается найти metadata звонка через `GET /call-records/info`
- транскрибирует аудио через `ai-gateway /transcribe` (upstream: Polza) через `multipart/form-data` file upload
- отправляет canonical payload в `POST /api/process-call`

По умолчанию используется production-validated STT модель:
- `openai/gpt-4o-mini-transcribe`

Opt-in compare режим для ручного quality-check (без глобального switch):

```bash
npm run manual:tele2-record -- 2026-03-13/177342115767354776 \
  --transcribe-model openai/gpt-4o-mini-transcribe \
  --compare-transcribe-model openai/whisper-1
```

Можно использовать alias `candidate` (берётся из `POLZA_TRANSCRIBE_MODEL_CANDIDATE` в `ai-gateway` env):

```bash
npm run manual:tele2-record -- 2026-03-13/177342115767354776 \
  --compare-transcribe-model candidate
```

### Tele2 poll-once MVP (manual and scheduled command)

Для безопасной ручной обработки новых Tele2 записей добавлена one-shot команда:

```bash
npm run tele2:poll-once
```

Маршрут команды:
- `call-records/info` -> candidate select -> dedup (`recordFileName`) -> `call-records/file`
- `ai-gateway /transcribe` (`multipart/form-data`, без `audioBase64` JSON)
- canonical `POST /api/process-call`

Что важно на этом этапе:
- one-shot execution path остаётся тем же (`tele2:poll-once`)
- scheduler добавляется только как обёртка запуска (без worker/queue/webhook)
- dedup durable в PostgreSQL (`tele2_polled_records`)
- в dry-run не вызывается `/api/process-call`
- обычный flow без флагов использует default STT модель (`openai/gpt-4o-mini-transcribe`)

Dry-run пример:

```bash
npm run tele2:poll-once -- --dry-run --max-candidates 3
```

Dry-run compare пример (candidate не отправляется в `/api/process-call`):

```bash
npm run tele2:poll-once -- --dry-run --max-candidates 3 \
  --transcribe-model openai/gpt-4o-mini-transcribe \
  --compare-transcribe-model openai/whisper-1
```

Для safety compare mode в `tele2:poll-once` разрешён только при `--dry-run`.

Первый запуск после обновления кода:

```bash
npm run migrate
npm run tele2:poll-once -- --dry-run
```

### Scheduled rollout on VM (systemd timer, safe profile)

В репозитории добавлены минимальные ops-артефакты:

- wrapper: `scripts/run-tele2-poll-once.sh`
- systemd service: `ops/systemd/t2-tele2-poll.service`
- systemd timer: `ops/systemd/t2-tele2-poll.timer`
- env template: `ops/systemd/tele2-poll.env.example`

Safe starter profile (подтверждённый для длинных записей):

- interval: каждые `15` минут (`systemd timer`)
- `--lookback-minutes 60`
- `--max-candidates 10`
- `--timeout-ms 180000`
- `retry-failed=true`
- wrapper пишет JSON-lines в journal и в файл лога
- wrapper требует `docker` и `flock` (обычно пакет `util-linux`)

Wrapper exit codes:

- `0`: poll completed или overlap-skip (второй параллельный запуск не стартует)
- `2`: wrapper/env/infra misconfiguration (например отсутствует env file или docker network)
- другое `!=0`: ошибка самого `tele2:poll-once`

VM install (one-time):

```bash
cd /home/artem266/t2-call-summary-mvp

# If VM checkout path/user differs, edit PROJECT_DIR/ExecStart/User in
# ops/systemd/t2-tele2-poll.service before copying.

sudo cp ops/systemd/t2-tele2-poll.service /etc/systemd/system/
sudo cp ops/systemd/t2-tele2-poll.timer /etc/systemd/system/

# Create tele2-poll.env only once (do not overwrite a live configured file).
if [ ! -f /opt/t2-call-summary/tele2-poll.env ]; then
  sudo install -m 0640 ops/systemd/tele2-poll.env.example /opt/t2-call-summary/tele2-poll.env
fi

sudoedit /opt/t2-call-summary/tele2-poll.env
# Required:
# T2_API_TOKEN=<live_token>

sudo systemctl daemon-reload
sudo systemctl enable --now t2-tele2-poll.timer
```

`t2-tele2-poll.service` использует `TimeoutStartSec=0`, чтобы длинные записи не убивались таймаутом systemd.

Manual run через тот же service:

```bash
sudo systemctl start t2-tele2-poll.service
sudo systemctl status t2-tele2-poll.service --no-pager
```

Logs:

```bash
journalctl -u t2-tele2-poll.service -n 200 --no-pager
tail -n 200 /home/artem266/t2-call-summary-mvp/logs/tele2-poll-once.log
```

Pause/stop:

```bash
sudo systemctl disable --now t2-tele2-poll.timer
```

Rollback к ручному режиму:

```bash
sudo systemctl disable --now t2-tele2-poll.timer
sudo systemctl stop t2-tele2-poll.service || true
# дальше запуск только вручную:
cd /home/artem266/t2-call-summary-mvp
./scripts/run-tele2-poll-once.sh --dry-run
```

### Integration assumptions (до подтверждения Tele2 contract)

- финальная Tele2 webhook/schema **не зафиксирована** в runtime
- adapter не хардкодит "предполагаемые Tele2 поля"; он использует:
  - env path mapping (`TELE2_PHONE_FIELD_PATH`, `TELE2_CALL_DATETIME_FIELD_PATH`, `TELE2_TRANSCRIPT_FIELD_PATH`)
  - fallback только на канонические top-level keys: `phone`, `callDateTime`, `transcript`
- если обязательные поля не найдены: ответ `400` + `status=invalid_t2_payload`, без падения сервиса
- transcript текст не пишется в structured logs (только метаданные)

### Exact fields to confirm with Tele2 before cutover

- путь до номера клиента в payload (`phone`)
- путь до даты/времени звонка (`callDateTime`) и точный формат/таймзона
- путь до транскрипта (`transcript`) и максимальный размер
- event id/call id для трассировки в логах (если есть в payload)
- retry policy со стороны Tele2 (повторы при 4xx/5xx, таймаут запроса)
- expected auth header/value format со стороны Tele2
- допустимый SLA по времени ответа webhook

### Where adapter plugs into current app

- HTTP route: `src/server.js` -> `POST /api/ingest/tele2`
- adapter normalization: `src/services/t2Mapper.js`
- ingest orchestration: `src/services/t2IngestService.js`
- canonical processing path (unchanged):
  - `/api/ingest/tele2` -> `processCall` -> `ai-gateway` -> provider -> PostgreSQL -> Telegram

### Safe testing before full cutover

1. Включить endpoint на staging/production VM только для теста:
   - `TELE2_INGEST_ENABLED=true`
2. Запустить dry-run запросы с реальным/полуреальным Tele2 payload:
   - `X-Ingest-Dry-Run: true`
3. Проверить нормализацию и ошибки по missing fields без запуска анализа/Telegram.
4. После подтверждения field paths заполнить `TELE2_*_FIELD_PATH` и повторить dry-run.
5. Выполнить ограниченный smoke без dry-run (1-2 тестовых звонка), затем вернуть dry-run при необходимости.

### Tele2 cutover checklists (safe rollout)

Preflight checklist:
- `POST /api/process-call` остаётся рабочим (не трогаем контракт)
- `TELE2_INGEST_ENABLED` включается осознанно (по умолчанию `false`)
- `INGEST_SHARED_SECRET` задан и синхронизирован с upstream
- `TELE2_*_FIELD_PATH` заполнены только после подтверждения с Tele2
- текущий runtime route подтверждён: main app -> ai-gateway -> provider
- monitoring baseline (`healthz`, baseline-check, logs) зелёный

Smoke test checklist:
- `POST /api/ingest/tele2` c `X-Ingest-Dry-Run: true` возвращает `normalized_preview`
- dry-run на неполном payload возвращает `400 invalid_t2_payload` с понятными полями
- 1 валидный запрос без dry-run возвращает `status=processed`
- Telegram delivery = `sent`
- в логах нет утечки transcript текста

Rollback checklist:
- выставить `TELE2_INGEST_ENABLED=false`
- вернуть traffic на уже рабочий ingest path (если временно переключали источник)
- перезапустить контейнер main app
- проверить `GET /healthz` и короткий smoke через `POST /api/process-call`

Production verification checklist:
- `GET /healthz` main app = `ok`, `database=ok`
- `baseline-check.sh` exit code `0`
- 4xx по Tele2 adapter ожидаемы только для неполных payload и отслеживаются
- 5xx rate по main app/gateway без регрессии
- успешные Tele2 ingest запросы доходят до Telegram с `status=sent`

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
- active production image tags:
  - `t2-call-summary:prod-v5-tele2-adapter-amd64`
  - `ai-gateway:prod-v6-stt-compare-amd64`
- during Tele2 adapter rollout `ai-gateway` runtime/image was not changed
- production env safety state:
  - `TELE2_INGEST_ENABLED=false`
  - `INGEST_SHARED_SECRET` is set (non-empty)
  - `AI_GATEWAY_URL=http://ai-gateway:3001`

Current next follow-ups:
- install and verify `t2-tele2-poll.service` + timer on VM (`dry-run` then `live`)
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
