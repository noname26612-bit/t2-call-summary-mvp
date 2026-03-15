# DEPLOY_PROGRESS.md

Operational progress log for post-baseline work after the successful Polza production cutover.

## Goal of current phase (post-baseline improvements, wave #1)

Keep the existing production baseline stable after the confirmed Polza cutover:

- keep main app on the existing Yandex VM
- keep main app and `ai-gateway` as separate Docker containers on the same VM
- keep container-to-container routing on user-defined Docker network `t2-app-net`
- keep PostgreSQL topology unchanged
- keep Telegram transport/integration unchanged (same bot/chat delivery path + add transcript button flow)
- keep `Telegram message format v2.1` as completed wave #1 baseline result
- run a narrow pass for Telegram callback polling via `getUpdates` (no public webhook dependency)
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

## Active workstream (Telegram callback polling via `getUpdates`)

Baseline status:

- production baseline is closed and considered stable
- topology and production routing are fixed
- `Telegram message format v2.1` rollout is completed and live-verified
- production incident on `2026-03-14` is manually mitigated
- post-incident hardening for Tele2 poller auth/env is deployed as separate narrow pass

Active scope in this change set:

- keep transcript storage + transcript `.txt` send logic as-is (already implemented)
- keep inline button `Транскрипт (.txt)` UX unchanged
- receive callback updates through Telegram `getUpdates` polling (primary production path)
- process only `callback_query` updates with `transcript:<call_event_id>` callback data
- use persistent offset state to prevent repeated callback processing after restart
- keep webhook route as optional fallback (do not hard-remove it)
- remove operational requirement on `PUBLIC_APP_URL`/public HTTPS webhook for transcript button flow
- keep polling consumer model single-instance for main app in this phase (no multi-instance election in scope)
- sync docs/status and smoke examples for polling-first behavior

Explicitly out of scope in this change set:

- ignored numbers behavior changes
- owner routing
- polling interval
- provider/gateway refactor
- topology / infrastructure / production baseline changes
- historical transcript backfill with expensive re-transcription
- wide sampling/backfill of old calls
- Tele2 token regeneration proposals as a "fix first" action

Acceptance criteria for this workstream:

- summary message still includes inline button `Транскрипт (.txt)`
- callback updates are received through `getUpdates` without public webhook URL
- transcript `.txt` is sent from stored `transcript_text` without AI/STT re-run
- callback polling advances/saves offset and does not re-process already handled updates
- webhook endpoint remains optional fallback and does not block production use case
- docs/status and smoke checks are synchronized with this narrow pass

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
- Telegram transport path preserved (active pass adds transcript button/callback only)
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
- Tele2 adapter production rollout completed in safe mode (flag off):
  - main app deployed with image `t2-call-summary:prod-v5-tele2-adapter-amd64`
  - production env confirmed:
    - `TELE2_INGEST_ENABLED=false`
    - `INGEST_SHARED_SECRET` is non-empty
    - `AI_GATEWAY_URL=http://ai-gateway:3001`
  - production verification passed after rollout:
    - `GET /healthz` main app = ok
    - `GET /healthz` ai-gateway = ok
    - baseline check passed (`LOG_WINDOW=15m`)
    - `POST /api/process-call` returned HTTP 200 (`status=processed`)
    - `POST /api/ingest/tele2` returned HTTP 503 with `TELE2_INGEST_DISABLED`
  - `ai-gateway` runtime/container/image remained unchanged
- production STT bridge validated via manual E2E:
  - Tele2 `call-records/file` -> `ai-gateway /transcribe` -> Polza -> `/api/process-call` -> Telegram
  - `openai/whisper-1` tested and not suitable for current recordings
  - active validated STT model: `openai/gpt-4o-mini-transcribe`
  - `ai-gateway` updated to image `ai-gateway:prod-v4-transcribe-amd64`
- Tele2 one-shot polling MVP validated on VM:
  - `tele2:poll-once` dry-run passed
  - `tele2:poll-once` live-run passed
  - durable dedup by `recordFileName` verified on repeated run
- multipart large-audio STT path validated on production:
  - `ai-gateway /transcribe` switched to multipart upload in image `ai-gateway:prod-v5-transcribe-multipart-amd64`
  - `POST /transcribe` checks verified: `401` without secret, `400` with bad mime
  - long Tele2 record `2026-03-13/177341088205035848` (3.6 MB) now transcribed and processed successfully:
    - `processCall.statusCode=200`
    - Telegram delivery `sent`
  - previous JSON/base64 `413 PAYLOAD_TOO_LARGE` limitation for this long record is removed
  - operational fact: default timeout `20000 ms` can be insufficient for long records; successful long-record test used `--timeout-ms 180000`
- safe STT candidate compare mode validated in production without changing default:
  - `ai-gateway` updated to `ai-gateway:prod-v6-stt-compare-amd64`
  - default model remains `openai/gpt-4o-mini-transcribe`
  - candidate `openai/whisper-1` tested on sample and rejected for production switch (`success=0 / empty=8 / failed=2`)
- scheduled poll-once ops assets prepared in repository (no webhook/cutover changes):
  - VM wrapper with overlap lock: `scripts/run-tele2-poll-once.sh`
  - VM token refresh helper: `scripts/refresh-tele2-token.sh`
  - systemd unit templates: `ops/systemd/t2-tele2-poll.service`, `ops/systemd/t2-tele2-poll.timer`
  - optional VM env template: `ops/systemd/tele2-poll.env.example`
  - safe starter profile fixed for timer rollout: interval 15m, lookback 60m, max candidates 10, timeout 180000 ms
  - service timeout guard set (`TimeoutStartSec=0`) to avoid systemd killing long polling runs
  - wrapper logs are JSON-lines with explicit exit code semantics (`0`, `2`, `3`, `4`, propagated poll exit code)
- scheduled poll-once rollout on VM is enabled and validated:
  - timer enabled and trigger confirmed
  - overlap protection confirmed
  - dry-run/live/dedup behavior confirmed under scheduled profile
- Tele2 token refresh hardening prepared for scheduler wrapper:
  - preflight refresh based on access token expiry window
  - one controlled refresh + one controlled retry on Tele2 auth `403`
  - atomic env update for `T2_API_TOKEN` and `T2_REFRESH_TOKEN` with backup
  - refresh helper does not log token values
- post-incident poller env/auth hardening implemented in repository:
  - fail-fast validation for required `T2_API_TOKEN`/`T2_REFRESH_TOKEN`
  - explicit auth-env error signatures before docker poll run
  - early guard for unreadable poll env file (`/opt/t2-call-summary/tele2-poll.env`)
  - dedicated auth-env misconfiguration exit code (`4`)
- poller file-log growth hardening prepared:
  - added logrotate config template `ops/logrotate/t2-tele2-poll`
  - keeps journal logging unchanged
  - rotates/compresses `/home/artem266/t2-call-summary-mvp/logs/tele2-poll-once.log` with limited retention

## Incident note (`2026-03-14`)

Symptom observed:

- `t2-tele2-poll.timer` remained active and triggering
- `t2-tele2-poll.service` repeatedly failed
- logs contained repeated auth failures (`403`, `poll_once_failed`, `token_refresh_skipped_missing_refresh_token`)
- Telegram summaries stopped because poller could not pass Tele2 auth

Root cause:

- missing/invalid token pair in `/opt/t2-call-summary/tele2-poll.env`:
  - `T2_API_TOKEN`
  - `T2_REFRESH_TOKEN`

Parallel ops issue:

- SSH ingress in `sg-t2-vm` allowed only a different operator IP, which delayed direct access for recovery

Mitigation (already done manually):

- restored valid Tele2 token pair in production env
- corrected env-file ownership/permissions so wrapper user can read it
- reran poller and confirmed successful pass
- restored normal SSH access path for current operator IP

Current state after mitigation:

- `t2-tele2-poll.timer` is `active (waiting)`
- poller has successful run: `2026-03-14 20:06:38 UTC` (`exitCode=0`)
- no new `403`/`missing_refresh_token` signatures after fix window

## Current production image tags (active)

- main app: `t2-call-summary:local-main-9241a3949f02-20260314223942`
- gateway: `ai-gateway:prod-v6-stt-compare-amd64`

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
Tele2 adapter is deployed to production with flag off and validated.
Tele2 pull route (`call-records/info`, `call-records/file`) and manual STT bridge E2E are validated.
Tele2 one-shot polling MVP is validated on VM (`dry-run`, `live-run`, `dedup`).
Multipart transcription path for long audio is validated in production.
Scheduled `tele2:poll-once` rollout via systemd service/timer is enabled and validated on VM.
Current narrow milestone in post-baseline improvements wave #1:

- keep `Telegram message format v2.1` as completed baseline milestone
- keep transcript storage + `.txt` delivery as completed baseline for transcript feature
- execute a narrow polling pass for Telegram callback updates via `getUpdates`
- keep all topology/provider/routing changes out of scope

## Operational warning (Tele2 tokens)

Tele2 ATS API keys behavior is strict:

- if tokens are regenerated, the previous access/refresh pair becomes invalid immediately
- do not regenerate tokens "for future use"
- perform regeneration only inside one controlled ops step:
  1. update env/secret right away
  2. restart affected service right away
  3. run verification right away

## Runtime naming status

Canonical runtime names in code:

- `ai-gateway` shared secret: `AI_GATEWAY_SHARED_SECRET`
- `ai-gateway` provider env: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TIMEOUT_MS`

Status:

- naming migration for `ai-gateway` env is complete
- production Polza phase is complete and smoke-verified on the existing Yandex VM
- docs and env examples are synchronized with canonical names

## Next steps

1. Roll out callback polling pass to production main app (main app only).
2. Run one controlled live verification (`/api/process-call`) and confirm button click works through `getUpdates` + `.txt` delivery.
3. Keep SSH baseline stable (`sg-t2-vm` ingress policy + known-good operator access path).
4. Keep baseline protections unchanged: no topology changes, no routing changes, no polling interval/ignored numbers/owner routing changes.

## Open checks

- verify request timeout and retries are acceptable for real call volume
- confirm and document timeout policy for long records (`--timeout-ms 180000` validated for manual long-record run)
- verify systemd timer overlap guard behavior (`flock`) under delayed/long runs
- verify token refresh behavior under expired/invalid access token scenario on VM after hardening deploy
- verify poller hardening exit codes and log signatures on VM (`2/3/4` paths)
- confirm SG allowlist policy for SSH and document operator fallback path (serial console)
- define operational cadence for Tele2 refresh token rotation
- verify logrotate execution cadence and retention on VM
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
