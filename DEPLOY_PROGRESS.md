# DEPLOY_PROGRESS.md

Operational progress log for the current Yandex Cloud phase and the next AI integration step.

## Goal of current phase

Keep the existing production baseline and move only OpenAI traffic to a thin external gateway:

- keep main app on Yandex VM
- keep PostgreSQL and current deploy unchanged
- replace direct `main app -> api.openai.com` with `main app -> ai-gateway -> OpenAI`
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
- next implementation branch: `feature/ai-gateway`

## Already completed

- first VM deploy completed
- containerized main app is running on Yandex VM
- `/healthz` externally reachable and returns OK
- PostgreSQL connectivity from main app is OK
- production baseline path is live (`VM + Docker + PostgreSQL + /healthz`)
- direct OpenAI calls from `ru-central1` fail with `403 Country, region, or territory not supported`
- thin `ai-gateway` service scaffolded and locally validated (`/healthz`, auth, validation, error handling)
- main app runtime path switched from direct OpenAI to `AI_GATEWAY_URL/analyze`
- direct OpenAI analyzer removed from current runtime wiring in `src/server.js`
- main app env cutover completed: `AI_GATEWAY_URL`, `AI_GATEWAY_SHARED_SECRET`, `AI_GATEWAY_TIMEOUT_MS`

## Current active checkpoint

Deploy gateway in supported region and run first end-to-end smoke with new routing (`main app -> ai-gateway -> OpenAI`).

## Next steps

1. Create branch `feature/ai-gateway`.
2. Deploy gateway in supported region.
3. Apply production env on main app VM:
   - `AI_GATEWAY_URL`
   - `AI_GATEWAY_SHARED_SECRET`
   - `AI_GATEWAY_TIMEOUT_MS`
4. Restart main app container with new env.
5. Run end-to-end smoke:
   - ingest path
   - analysis via gateway
   - PostgreSQL write path
   - Telegram delivery path
6. Confirm old direct OpenAI path remains disabled in runtime.

## Open checks

- verify gateway region truly supports OpenAI traffic in runtime
- verify request timeout and retries are acceptable for real call volume
- rotate shared secret and API key before full production traffic

## Out of scope for this phase

- moving PostgreSQL out of current setup
- moving main app off current Yandex VM
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
