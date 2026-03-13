# TASKS.md

> Each task should be executed with step-by-step validation instructions because the project is being implemented by the user for the first time.

## Ближайшие этапы (актуальный порядок)

Source of truth for current YC deploy progress and fixed decisions:
`DEPLOY_PROGRESS.md`

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

## Контрольные follow-up задачи

- [x] Синхронизировать category enum в коде с бизнес-категориями (продажа/сервис/запчасти/аренда/спам/прочее)
- [ ] Если Polza API key после локального теста ещё не ротирован, сделать rotation и повторить короткий production smoke
- [x] После успешного production Polza cutover выполнить naming cleanup:
  - `GATEWAY_SHARED_SECRET -> AI_GATEWAY_SHARED_SECRET`
  - `OPENAI_* -> POLZA_*`
- [x] После Polza cutover: выполнить и подтвердить минимальный monitoring baseline для production VM
- [x] Добавить минимальный monitoring/alerts (healthz, 5xx, Polza/Telegram failures, DB connectivity)
- [ ] Добавить monitoring по gateway (401/400/502 rate, latency, timeout rate)
- [ ] Повысить приоритет retention policy для исторических таблиц PostgreSQL
- [ ] Подготовить интеграцию Lockbox для секретов (вместо env-only)
