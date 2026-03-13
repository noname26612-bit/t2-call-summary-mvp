# AGENTS.md

## Project stage

Current stage: post-cutover hardening for the confirmed production baseline (lightweight monitoring baseline added).

Target runtime:

- one Node.js/Express main app
- one thin `ai-gateway` service
- one VM in Yandex Compute Cloud for production runtime
- one managed PostgreSQL in Yandex Managed Service for PostgreSQL
- containerized deployment via Docker image(s)

## Priority right now

Primary priority is **stable production routing**, not feature expansion:

1. preserve the working PostgreSQL-based runtime storage
2. preserve Telegram delivery path
3. keep the confirmed production route stable via `ai-gateway` and Polza
4. sync docs with the confirmed production baseline on the existing Yandex VM
5. complete monitoring rollout/verification on VM, then return to deepening t2 production ingest

## Polza integration discipline

For the current phase, the target is:

- keep main app on current Yandex VM
- keep PostgreSQL topology unchanged
- keep Telegram integration unchanged
- keep `ai-gateway` as the application boundary for AI analysis
- use **Polza** as the fixed upstream AI provider for `ai-gateway`
- do **not** deploy an extra gateway VM in another region

Rules:

- do not introduce Redis, queues, workers, Kubernetes, load balancers, Terraform, or extra platform complexity
- do not re-open the old direct OpenAI runtime path
- use the simplest production-ready shape:
  - existing Yandex VM
  - Docker
  - env file(s)
  - simple restart policy or systemd if needed
- rotate any shared secret that was exposed during local testing before production use
- treat `DEPLOY_PROGRESS.md` as the operational source of truth for this phase
- after each meaningful deploy action:
  1. update `DEPLOY_PROGRESS.md`
  2. sync `TASKS.md` if milestone state changed
  3. sync `README.md` only if project-wide runtime status changed

## Current production routing note

For the current production baseline on the existing Yandex VM:

- main app and `ai-gateway` run as separate Docker containers on the same VM
- canonical container names:
  - main app: `t2-call-summary`
  - gateway: `ai-gateway`
- container-to-container routing uses Docker network `t2-app-net`
- production `AI_GATEWAY_URL` must be `http://ai-gateway:3001`
- `127.0.0.1:3001` is acceptable only for host-level checks from the VM, not as the main app container runtime URL

Success criteria for this phase:

- `ai-gateway` successfully calls Polza in runtime
- main app uses `AI_GATEWAY_URL` only
- production smoke passes for:
  - main app health
  - gateway health
  - `POST /api/process-call`
  - PostgreSQL write path
  - Telegram delivery path
- production runtime no longer depends on direct OpenAI access from Yandex region

Current status:

- these criteria are now confirmed for the existing Yandex VM baseline
- runtime naming cleanup is complete (`AI_GATEWAY_SHARED_SECRET`, `POLZA_*`)
- lightweight monitoring baseline is added (Docker `HEALTHCHECK` + log-based baseline checks)

## Runtime naming discipline (canonical, implemented)

Canonical runtime names in code:

- main app secret var: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` secret var: `AI_GATEWAY_SHARED_SECRET`
- provider vars in `ai-gateway`: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TIMEOUT_MS`

## t2 integration scope

- `/dev/t2-ingest` is still scaffold/debug
- after monitoring rollout is verified on VM, next major step is deepening real t2 production ingest

## Storage rule

- PostgreSQL is runtime source of truth
- `data/*.json` is legacy import source only
- do not reintroduce runtime dependency on JSON stores

## Collaboration rule

This project is managed in parallel in:

- ChatGPT
- Codex

Practical responses should stay easy to continue in either tool.

## Parallel workflow rule

This project is developed in parallel between ChatGPT and Codex.

So every practical response must help transfer work between environments.

Always make explicit:
- what should be discussed in ChatGPT
- what should be executed in Codex
- what the user should run manually
- how to verify the result

When proposing implementation work, always include a ready-to-send Codex prompt.

## User execution mode: beginner-friendly

Important: the project is being implemented by the user for the first time.

This means practical guidance must be written in a beginner-friendly execution style.

For any task that requires manual action, always include:

1. what we are doing
2. why we are doing it
3. exact command / exact click path / exact file to open
4. what result is expected
5. how to verify it
6. what to do if the result is different

Do not assume the user already knows:

- terminal workflow
- Docker workflow
- PostgreSQL CLI usage
- Yandex Cloud setup steps
- environment variable setup
- deployment sequence
- validation flow after changes

When suggesting checks in terminal or external services, always explain:

- where to run the command
- whether the service must already be running
- whether restart is required after config changes
- what successful output looks like
- what typical failure looks like

For manual infrastructure steps, prefer this structure:

- Step
- Action
- Command / UI path
- Expected result
- If something went wrong

If a step is potentially destructive or risky, explicitly warn before it.

Do not give shorthand instructions like:

- "just run migrations"
- "check postgres"
- "deploy to VM"

without explaining how.

## Manual instruction template (mandatory)

For every manual step, use this exact structure:

1. Step
2. What we are doing
3. Why we are doing it
4. Where to run (project folder / terminal / cloud UI)
5. Exact command or exact UI path
6. Expected result
7. How to verify
8. If the result is different

## Delivery rule for practical tasks

Before edits:

1. short plan
2. files to modify

After edits:

1. changed files
2. what changed and why
3. exact run commands
4. exact verification steps
5. expected results
6. known risks/edge cases

## Implementation style

- keep implementation simple and readable
- no unnecessary abstractions
- no architecture overengineering
- no Kubernetes/microservices/queues/serverless unless explicitly requested
- keep changes focused to requested scope
- prefer step-by-step, verifiable increments

## Business categories (target)

- продажа
- сервис
- запчасти
- аренда
- спам
- прочее

If code uses a different category set, document the mismatch and create a follow-up task to align runtime behavior.

## Safety

- do not invent external API details
- mark uncertain integration details explicitly
- do not refactor unrelated code
