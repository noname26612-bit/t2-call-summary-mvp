# TASKS.md

> Each task should be executed with step-by-step validation instructions because the project is being implemented by the user for the first time.

## Completed workstream (Telegram callback polling via `getUpdates`, `2026-03-15`)

Source of truth for current YC deploy progress and fixed decisions:
`DEPLOY_PROGRESS.md`

Current status:

- [x] Production baseline is closed and stabilized
- [x] Improvement wave #1 is activated
- [x] `Telegram message format v2.1` rollout is completed and live-verified
- [x] Narrow Telegram format pass completed (`Тип звонка` + `Абонент`, plain text, one call = one message, `2026-03-17`)
- [x] Poller runtime payload pass completed (`callType/callerNumber/calleeNumber/destinationNumber` -> `/api/process-call` -> Telegram, `2026-03-17`)
- [x] Post-incident hardening rollout is completed as separate narrow pass
- [x] Transcript storage + `.txt` transcript button pass is completed locally
- [x] Telegram callback polling via `getUpdates` pass is completed

## Completed workstream (Dialog reconstruction + employee phone directory, `2026-03-17`)

Scope and status:

- [x] Added schema-only migration for employee phone directory + summary dialog reconstruction fields (`005_employee_directory_dialog_analysis.sql`)
- [x] Removed business employee seed rows from migration (schema only, production-safe)
- [x] Added admin CLI for employee directory (`upsert`, `deactivate`, `lookup`) with strict phone normalization
- [x] Runtime lookup uses only `is_active = true` employee records
- [x] Added confidence-aware Telegram summary behavior:
  - [x] high confidence -> explicit role interpretation is allowed
  - [x] low confidence -> neutral language, uncertainty markers, no confident role claims
- [x] Added/updated smokes for required cases:
  - [x] incoming known employee
  - [x] incoming unknown employee
  - [x] outgoing known employee
  - [x] short noisy transcript
  - [x] long transcript without speaker labels
  - [x] low confidence role detection
  - [x] inactive employee record is ignored
  - [x] phone normalization (`+7`, `8`, spaces, brackets/dashes)
  - [x] unknown phone does not break flow
- [x] Manual acceptance batch completed on 10 real DB call records (old vs new Telegram summary):
  - [x] analyzed: 10
  - [x] improved: 10
  - [x] risk: 0
  - [x] report: `reports/manual-acceptance-real-calls-2026-03-17.md`

Callback polling checklist (this change set only):

- [x] Sync status docs (`DEPLOY_PROGRESS.md`, `TASKS.md`, `README.md`)
- [x] Keep existing transcript storage/send logic unchanged (no re-transcription on click)
- [x] Keep button UX label `Транскрипт (.txt)` unchanged
- [x] Add Telegram `getUpdates` polling path for callback updates (`callback_query` only)
- [x] Handle only transcript callbacks (`transcript:<call_event_id>`)
- [x] Add persistent offset storage for Telegram updates (offset-based, no duplicate processing after restart)
- [x] Offset advances only after successful callback handling (no batch pre-commit over failed callback)
- [x] Document single-instance polling assumption for main app runtime
- [x] Add safe polling backoff behavior (no tight loop on callback/API failures)
- [x] Keep webhook endpoint as optional fallback (no breaking removal)
- [x] Add/refresh local smoke checks for polling path
- [x] Run production verification with fresh summary + real button click (polling path)
  - [x] summary message delivered
  - [x] inline button `Транскрипт (.txt)` visible in Telegram
  - [x] `.txt` delivered after real button click
  - [x] transcript file format verified (`Кто звонил`, `Когда звонил`, `Категория`, `Транскрипт`)

Explicitly not in this change set:

- [x] ignored numbers changes are out of scope
- [x] owner routing changes are out of scope
- [x] polling interval changes are out of scope
- [x] provider/gateway architecture refactor is out of scope
- [x] topology / production baseline changes are out of scope
- [x] expensive historical transcript backfill is out of scope

## Baseline and Tele2 ops backlog (reference, not active in this change set)

- [x] 1. PostgreSQL refactor verification (schema, migrations, storage behavior, dedup)
- [x] 2. local smoke test (process-call, healthz, telegram delivery path)
- [x] 3. prepare Yandex Cloud deploy
  - [x] rotate secrets before deploy
  - [x] create Container Registry
  - [x] create service account `images-puller`
  - [x] grant `container-registry.images.puller` on registry for `images-puller`
  - [x] create VPC network/subnet plan
  - [x] create custom security groups:
    - [x] `sg-t2-vm`
    - [x] `sg-t2-postgres`
  - [x] create private Managed PostgreSQL in same VPC
  - [x] enable WebSQL access
  - [x] attach `sg-t2-postgres` to PostgreSQL cluster
  - [x] create VM with attached service account `images-puller`
  - [x] install Docker on VM
  - [x] prepare env on VM
  - [x] build and push Docker image
  - [x] docker login on VM via metadata token
  - [x] run container on VM
  - [x] verify `/healthz` in cloud
  - [x] run first production smoke test
- [x] 4. Сделать первый production deploy
- [x] 5. Перевести AI upstream на Polza и стабилизировать production routing
  - [x] зафиксировать baseline status в `DEPLOY_PROGRESS.md`
  - [x] создать каркас сервиса `ai-gateway/`
  - [x] переключить main app runtime wiring на `AI_GATEWAY_URL`
  - [x] отключить прямой OpenAI path в runtime (`src/server.js`)
  - [x] обновить env main app (`AI_GATEWAY_URL`, `AI_GATEWAY_SHARED_SECRET`, `AI_GATEWAY_TIMEOUT_MS`)
  - [x] доказать локальный end-to-end через gateway:
    - main app -> ai-gateway -> upstream AI -> PostgreSQL -> Telegram
  - [x] подтвердить прямую API-доступность Polza
  - [x] подтвердить локальный end-to-end именно через Polza:
    - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
  - [x] зафиксировать Polza как основной upstream provider в runtime code path
  - [x] адаптировать production env на существующей Yandex VM:
    - `main.env`
    - `gateway.env`
  - [x] production container-to-container routing uses:
    - Docker network `t2-app-net`
    - `AI_GATEWAY_URL=http://ai-gateway:3001`
  - [x] собрать и запушить production image для `ai-gateway`
  - [x] задеплоить `ai-gateway` на existing Yandex VM без отдельной gateway VM в другом регионе
  - [x] проверить `GET /healthz` main app на VM
  - [x] проверить `GET /healthz` ai-gateway на VM
  - [x] сделать production end-to-end smoke:
    - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
  - [x] подтвердить, что old direct OpenAI path remains disabled in production runtime
  - [x] синхронизировать docs после успешного production cutover
- [x] 6. Завершить infrastructure/monitoring baseline phase на production VM
  - [x] добавить Docker `HEALTHCHECK` для main app и `ai-gateway`
  - [x] добавить `scripts/monitoring/baseline-check.sh`
  - [x] выкатить monitoring baseline на production VM
  - [x] пройти production verification (`healthz`, container health, baseline-check, short smoke)
- [x] 7. Выполнить production ingest hardening для `POST /api/process-call`
  - [x] optional ingress auth через `INGEST_SHARED_SECRET`
  - [x] production verification: `401 / 400 / 200`
  - [x] Telegram delivery подтверждена на accepted ingest проверке
  - [x] ingest structured logs подтверждены, transcript в лог не течёт
  - [x] main app image обновлён до `t2-call-summary:prod-v4-ingest-hardening-amd64`
  - [x] `ai-gateway` не менялся (`ai-gateway:prod-v3-monitoring-amd64`)
- [ ] 8. Next milestone: `t2` production ingest wiring / cutover preparation (текущий активный этап)
  - [x] 8.1 Синхронизировать docs по факту завершённого ingest hardening rollout
  - [x] 8.2 Выделить Tele2 adapter entrypoint `POST /api/ingest/tele2` без изменения `/api/process-call`
  - [x] 8.3 Сохранить канонический processing flow (`/api/ingest/tele2 -> processCall -> ai-gateway -> provider`)
  - [x] 8.4 Добавить safe handling missing/partial Tele2 fields (`400 invalid_t2_payload`, без transcript в логах)
  - [x] 8.5 Добавить controlled rollout switches (`TELE2_INGEST_ENABLED`, dry-run mode)
  - [ ] 8.6 Подтвердить с Tele2 точные field paths и auth details
  - [ ] 8.7 Заполнить `TELE2_*_FIELD_PATH` в production env после подтверждения payload contract
  - [x] 8.8 Выполнить preflight checklist для production rollout с `TELE2_INGEST_ENABLED=false`
  - [ ] 8.9 Выполнить smoke checklist (dry-run + 1-2 реальных запроса)
  - [x] 8.10 Выполнить production verification checklist и зафиксировать результат в `DEPLOY_PROGRESS.md`
  - [ ] 8.11 Проверить rollback checklist в боевом runbook перед full cutover
  - [x] 8.12 Добавить one-shot Tele2 polling command (`tele2:poll-once`) с durable dedup по `recordFileName` (без scheduler/worker)
  - [x] 8.13 Выкатить poll-once на VM и выполнить ручной dry-run + live run для новых записей
  - [x] 8.14 Перевести `ai-gateway /transcribe` на multipart upload и подтвердить long-audio E2E на production (бывший `413` кейс)
  - [x] 8.15 Выполнить операционный manual rollout `tele2:poll-once` (регулярный dry-run/live/dedup без cron/scheduler)
  - [x] 8.16 Подготовить production-safe scheduler assets для `tele2:poll-once`:
    - [x] VM wrapper script с защитой от overlap (`flock`)
    - [x] `systemd` one-shot service + timer templates
    - [x] минимальный ops runbook (install/run/status/logs/stop/rollback)
    - [x] safe starter defaults: `15m`, `lookback=60`, `maxCandidates=10`, `timeoutMs=180000`
  - [x] 8.17 Выполнить controlled VM rollout scheduler:
    - [x] установить `t2-tele2-poll.service` и `t2-tele2-poll.timer`
    - [x] проверить первый ручной service run
    - [x] проверить timer trigger и отсутствие overlap
    - [x] зафиксировать dry-run/live результат и dedup стабильность
  - [ ] 8.18 Добавить token refresh lifecycle для scheduled polling:
    - [x] добавить helper `scripts/refresh-tele2-token.sh` (Tele2 refresh endpoint + response validation)
    - [x] добавить atomic update + backup для `/opt/t2-call-summary/tele2-poll.env` (`T2_API_TOKEN`, `T2_REFRESH_TOKEN`)
    - [x] встроить preflight refresh в `scripts/run-tele2-poll-once.sh` по expiry window
    - [x] встроить controlled `403 -> refresh -> one retry` в wrapper
    - [x] зафиксировать strict warning в docs/env: при Tele2 token regeneration предыдущие токены сразу инвалидируются
    - [ ] выкатить обновлённый wrapper/helper на VM
    - [ ] подтвердить refresh flow на VM и зафиксировать результат в `DEPLOY_PROGRESS.md`
  - [ ] 8.19 Закрыть operational риск роста poller file log:
    - [x] добавить `ops/logrotate/t2-tele2-poll` template
    - [x] описать install/verify шаги в README
    - [ ] установить logrotate config на VM
    - [ ] подтвердить forced rotation + retention
  - [ ] 8.20 Post-incident hardening pass (`2026-03-14`):
    - [x] добавить fail-fast env validation для poller wrapper (`T2_API_TOKEN` / `T2_REFRESH_TOKEN`)
    - [x] добавить явные structured error signatures (missing token / invalid token / expired + refresh disabled)
    - [x] добавить early guard для unreadable `/opt/t2-call-summary/tele2-poll.env`
    - [x] синхронизировать docs/runbook (incident summary, recovery, healthcheck workflow, SSH/SG baseline)
    - [ ] выкатить hardening-обновления на VM и зафиксировать post-fix verification

## Контрольные follow-up задачи

- [x] Синхронизировать category enum в коде с бизнес-категориями (продажа/сервис/запчасти/аренда/спам/прочее)
- [ ] Если Polza API key после локального теста ещё не ротирован, сделать rotation и повторить короткий production smoke
- [x] После успешного production Polza cutover выполнить naming cleanup:
  - `GATEWAY_SHARED_SECRET -> AI_GATEWAY_SHARED_SECRET`
  - `OPENAI_* -> POLZA_*`
- [x] После Polza cutover: выполнить и подтвердить минимальный monitoring baseline для production VM
- [x] Добавить минимальный monitoring/alerts (healthz, 5xx, Polza/Telegram failures, DB connectivity)
- [ ] Добавить monitoring по gateway (401/400/502 rate, latency, timeout rate)
- [ ] Зафиксировать рабочую timeout-политику для длинных записей (`--timeout-ms 180000` validated) и при необходимости обновить default values
- [ ] Повысить приоритет retention policy для исторических таблиц PostgreSQL
- [ ] Подготовить интеграцию Lockbox для секретов (вместо env-only)
- [ ] Production control point after feature release: проверить live coverage `callType/employeePhone` на новых `call_received` событиях (`npm run audit:call-meta -- --hours 24 --source tele2_poll_once`)
