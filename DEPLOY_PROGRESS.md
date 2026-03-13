# DEPLOY_PROGRESS.md

Operational progress log for the current Yandex Cloud phase after the successful Polza production cutover.

## Goal of current phase

Keep the existing production baseline stable after the confirmed Polza cutover:

- keep main app on the existing Yandex VM
- keep main app and `ai-gateway` as separate Docker containers on the same VM
- keep container-to-container routing on user-defined Docker network `t2-app-net`
- keep PostgreSQL topology unchanged
- keep Telegram integration unchanged
- keep `ai-gateway` as the active runtime boundary
- use Polza as upstream provider
- do not return the main app runtime to a direct OpenAI path
- avoid deploying a separate gateway VM in another region
- keep architecture simple: no Redis / no queue / no worker / no Kubernetes / no load balancer

## Fixed decisions for this phase

These decisions are considered fixed unless explicitly changed:

- region for current main app baseline: `ru-central1`
- main zone for first deploy: `ru-central1-a`
- VPC: `t2-prod-net`
- VM security group: `sg-t2-vm`
- PostgreSQL security group: `sg-t2-postgres`
- service account for image pull: `images-puller`
- PostgreSQL cluster: `t2-prod-pg` (private)
- current deploy style: fully manual, beginner-friendly, one small verified step at a time
- current fixed AI strategy: **Polza as long-term upstream provider**
- `ai-gateway` remains in architecture as thin internal adapter
- current production main app gateway URL: `http://ai-gateway:3001`
- host-level VM health check for gateway: `http://127.0.0.1:3001/healthz`
- `ai-gateway` is not used as a separate public service

## Already completed

- first VM deploy completed
- containerized main app is running on Yandex VM
- `/healthz` externally reachable and returns OK
- PostgreSQL connectivity from main app is OK
- production baseline path is live (`VM + Docker + PostgreSQL + /healthz`)
- direct OpenAI calls from `ru-central1` fail with regional restriction
- thin `ai-gateway` service scaffolded and locally validated (`/healthz`, auth, validation, error handling)
- main app runtime path switched from direct provider call to `AI_GATEWAY_URL/analyze`
- direct OpenAI analyzer removed from current runtime wiring in `src/server.js`
- main app env cutover completed: `AI_GATEWAY_URL`, `AI_GATEWAY_SHARED_SECRET`, `AI_GATEWAY_TIMEOUT_MS`
- local end-to-end confirmed for gateway-based routing:
  - main app -> ai-gateway -> AI provider -> PostgreSQL -> Telegram
- Polza API connectivity confirmed directly via API
- local end-to-end confirmed specifically for Polza-backed routing:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- confirmed local routing value for main app -> ai-gateway:
  - `AI_GATEWAY_URL=http://127.0.0.1:3001`
- `ai-gateway` deployed on the existing Yandex VM
- main app and `ai-gateway` are running as separate Docker containers on the same existing Yandex VM
- production runtime traffic between containers uses Docker network `t2-app-net`
- production main app uses:
  - `AI_GATEWAY_URL=http://ai-gateway:3001`
- host-level health checks confirmed on VM:
  - `curl http://127.0.0.1:3001/healthz` -> ok
  - `curl http://127.0.0.1:3000/healthz` -> ok
- production end-to-end smoke confirmed:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- `POST /api/process-call` on VM returned `processed`
- `ai-gateway` logs confirmed successful `POST /analyze` through Polza
- Telegram delivery status in production smoke: `sent`
- old direct OpenAI path is no longer the active production runtime route
- external EU/VPS gateway host is not used
- PostgreSQL topology unchanged
- Telegram integration unchanged
- product decision fixed:
  - no separate gateway VM in another region
  - Polza is the long-term upstream provider
- minimal post-cutover monitoring baseline added:
  - Docker `HEALTHCHECK` in main app and `ai-gateway` images
  - lightweight script `scripts/monitoring/baseline-check.sh`
  - beginner-friendly runbook `MONITORING_BASELINE.md`
- monitoring baseline successfully rolled out on the production VM
- production verification passed after monitoring rollout:
  - container health OK
  - `/healthz` endpoints OK
  - `baseline-check.sh` exit code `0`
  - short production smoke: HTTP 200, `status=processed`, `telegram.status=sent`
- operational lesson confirmed:
  - production VM architecture = `amd64`
  - production image builds must explicitly target `linux/amd64`
- production ingest hardening for `POST /api/process-call` deployed and validated on VM:
  - optional ingress auth via `INGEST_SHARED_SECRET` is active
  - production verification passed for `401 / 400 / 200` scenarios
  - Telegram delivery confirmed for accepted ingest check
  - ingest structured logs (`ingest_auth_rejected`, `ingest_validation_rejected`, `ingest_request_accepted`) are present
  - transcript phrase is not leaked to logs
- `ai-gateway` runtime/container/image remained unchanged during this rollout
- Tele2 integration-ready prep is completed in code (no full production cutover yet):
  - added `POST /api/ingest/tele2` as dedicated adapter entrypoint
  - endpoint is protected by the existing optional ingress secret (`X-Ingest-Secret`)
  - endpoint is feature-gated (`TELE2_INGEST_ENABLED`, default `false`)
  - added dry-run mode (`X-Ingest-Dry-Run: true` or `?dryRun=1`) for safe payload verification
  - payload normalization now uses configurable path mapping:
    - `TELE2_PHONE_FIELD_PATH`
    - `TELE2_CALL_DATETIME_FIELD_PATH`
    - `TELE2_TRANSCRIPT_FIELD_PATH`
  - canonical processing path is unchanged:
    - main app -> ai-gateway -> provider -> PostgreSQL -> Telegram

## Current production image tags (active)

- main app: `t2-call-summary:prod-v4-ingest-hardening-amd64`
- gateway: `ai-gateway:prod-v3-monitoring-amd64`

## Current production routing note

For the current production baseline on the existing Yandex VM:

- main app and `ai-gateway` run as separate Docker containers on the same VM
- container-to-container routing uses Docker network `t2-app-net`
- production `AI_GATEWAY_URL` must be `http://ai-gateway:3001`
- `127.0.0.1:3001` is acceptable only for host-level checks from the VM, not as the main app container runtime URL

## Current active checkpoint

Infrastructure/monitoring baseline phase is completed and validated on the current production VM baseline.
Ingest hardening rollout for `POST /api/process-call` is completed and validated in production.
Tele2 adapter/integration prep is implemented in code with rollback-safe switches.
Next real milestone: confirm Tele2 payload fields and run controlled production cutover checks.

## Runtime naming status

Canonical runtime names in code:

- `ai-gateway` shared secret: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` provider env: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TIMEOUT_MS`

Status:

- naming migration for `ai-gateway` env is complete
- production Polza phase is complete and smoke-verified on the existing Yandex VM
- docs and env examples are synchronized with canonical names

## Next steps

1. Rotate the exposed Polza API key if it has not already been rotated after local testing, then re-run a short production smoke.
2. Confirm Tele2 payload field paths and auth details, then fill `TELE2_*_FIELD_PATH` values.
3. Run controlled dry-run checks through `POST /api/ingest/tele2` before any live traffic switch.
4. Keep lightweight monitoring checks running during ingest wiring and early live traffic.

## Open checks

- verify request timeout and retries are acceptable for real call volume
- rotate exposed Polza API key and any exposed development credentials before full production traffic
- verify final provider/model naming in runtime env and docs
- confirm exact Tele2 payload contract (field locations + datetime format + transcript size)
- confirm Tele2 retry behavior and webhook timeout expectations

## Out of scope for this phase

- moving PostgreSQL out of current setup
- moving main app off current Yandex VM
- deploying a separate gateway VM in another region only to bypass region limits
- Redis / queues / workers
- Kubernetes
- load balancer
- Terraform / Ansible / IaC expansion
- migration of old local historical data

## Update rule

After every meaningful deploy action:
1. update this file first
2. if milestone status changed, sync `TASKS.md`
3. if project-wide status changed, sync `README.md`
