# DEPLOY_PROGRESS.md

Operational progress log for the current Yandex Cloud phase and the Polza production cutover.

## Goal of current phase

Keep the existing production baseline and stabilize production routing around Polza:

- keep main app on Yandex VM
- keep PostgreSQL and current deploy unchanged
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
- product decision fixed:
  - no separate gateway VM in another region
  - Polza is the long-term upstream provider

## Current active checkpoint

Production cutover of `ai-gateway` to the existing Yandex VM using Polza as upstream provider, followed by first production end-to-end smoke for:

- main app
- ai-gateway
- Polza upstream path
- PostgreSQL write path
- Telegram delivery path

## Runtime naming status (current vs target)

Current runtime names in code (before separate code cutover):

- `ai-gateway` shared secret: `GATEWAY_SHARED_SECRET`
- `ai-gateway` provider env: `OPENAI_*`

Target runtime names (after separate technical pass):

- `GATEWAY_SHARED_SECRET -> AI_GATEWAY_SHARED_SECRET`
- `OPENAI_* -> POLZA_*`

Status:

- naming migration is **not complete yet**
- do not mark the production Polza phase as complete until VM smoke is done

## Next steps

1. Rotate the exposed Polza API key if not already rotated after local testing.
2. Prepare production `gateway.env` on the existing Yandex VM.
3. Build and push the `ai-gateway` production image.
4. Run `ai-gateway` on the existing Yandex VM.
5. Set production main app `AI_GATEWAY_URL` to local VM routing for gateway.
6. Verify `GET /healthz` for both main app and ai-gateway on VM.
7. Run production end-to-end smoke:
   - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
8. Confirm production no longer depends on direct OpenAI runtime access from Yandex region.
9. Only after stable production smoke, perform naming cleanup:
   - `GATEWAY_SHARED_SECRET -> AI_GATEWAY_SHARED_SECRET`
   - `OPENAI_* -> POLZA_*`

## Open checks

- verify VM routing details for production `main app -> ai-gateway` traffic
- verify request timeout and retries are acceptable for real call volume
- rotate exposed Polza API key and any exposed development credentials before full production traffic
- verify final provider/model naming in runtime env and docs

## Out of scope for this phase

- moving PostgreSQL out of current setup
- moving main app off current Yandex VM
- deploying a separate gateway VM in another region only to bypass region limits
- t2 production ingest deepening
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
