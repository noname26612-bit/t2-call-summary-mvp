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
- [ ] 5. Вынести вызов OpenAI в `feature/ai-gateway` (активный этап)
  - [x] зафиксировать baseline status в `DEPLOY_PROGRESS.md`
  - [x] создать каркас сервиса `ai-gateway/`
  - [x] переключить main app runtime wiring на `AI_GATEWAY_URL`
  - [x] отключить прямой OpenAI path в runtime (`src/server.js`)
  - [x] обновить env main app (`AI_GATEWAY_URL`, `AI_GATEWAY_SHARED_SECRET`, `AI_GATEWAY_TIMEOUT_MS`)
  - [ ] задеплоить gateway в поддерживаемом регионе
  - [ ] сделать end-to-end smoke (gateway + PostgreSQL + Telegram)
- [ ] 6. После стабилизации gateway вернуться к t2 production ingest

## Контрольные follow-up задачи

- [x] Синхронизировать category enum в коде с бизнес-категориями (продажа/сервис/запчасти/аренда/спам/прочее)
- [ ] После first deploy: мониторить реальный peak load / latency / failures до любых topology changes
- [ ] Повысить приоритет monitoring/alerts (healthz, 5xx, OpenAI/Telegram failures, DB connectivity)
- [ ] Добавить monitoring по gateway (401/400/502 rate, latency, timeout rate)
- [ ] Повысить приоритет retention policy для исторических таблиц PostgreSQL
- [ ] Подготовить интеграцию Lockbox для секретов (вместо env-only)
