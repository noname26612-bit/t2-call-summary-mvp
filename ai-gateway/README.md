# ai-gateway

Тонкий HTTP integration layer между main app и AI provider.

## Current strategy

- `ai-gateway` остаётся обязательным boundary
- fixed long-term upstream strategy: **Polza**
- production Polza cutover on the existing Yandex VM: **confirmed**

Текущая production схема:

`main app (same Yandex VM) -> ai-gateway -> Polza`

- main app и `ai-gateway` работают как отдельные Docker containers на одной existing Yandex VM
- container-to-container routing uses Docker network `t2-app-net`
- production main app uses `AI_GATEWAY_URL=http://ai-gateway:3001`
- `127.0.0.1:3001` подходит только для host-level checks с VM
- gateway не используется как отдельный публичный сервис

## Status update

`ai-gateway` подтверждён и локально, и в production smoke как рабочий Polza-backed gateway.

Confirmed locally:
- `GET /healthz` returns `{ "status": "ok" }`
- `POST /analyze` returns structured analysis through Polza
- auth via shared secret works
- the service is successfully used by the main app in local end-to-end flow

Confirmed in production on the existing Yandex VM:
- `GET /healthz` returns OK
- main app successfully reaches gateway via `http://ai-gateway:3001`
- `POST /analyze` is confirmed in gateway logs through Polza
- current production route is:
  - main app -> ai-gateway -> Polza -> PostgreSQL -> Telegram
- Telegram delivery status in production smoke is `sent`

Current follow-ups:
- docs sync
- Polza API key rotation if it has not already been completed after local testing

## Endpoints

- `GET /healthz` -> `{ "status": "ok" }`
- `POST /analyze` -> возвращает структурированный анализ (optional request override via `analyzeModel` or legacy `model`, only when `ALLOW_REQUEST_MODEL_OVERRIDES=true`)
- `POST /transcribe` -> возвращает транскрипт аудио через Polza (preferred: `multipart/form-data` upload field `audio`, optional `transcribeModel` override only when `ALLOW_REQUEST_MODEL_OVERRIDES=true`)

## Runtime naming (canonical)

- shared secret: `AI_GATEWAY_SHARED_SECRET`
- provider vars: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TRANSCRIPTION_MODEL`, `POLZA_TRANSCRIBE_MODEL_CANDIDATE`, `POLZA_TIMEOUT_MS`, `POLZA_MAX_RETRIES`, `ALLOW_REQUEST_MODEL_OVERRIDES`
- legacy-compatible alias for STT model is still supported: `POLZA_TRANSCRIBE_MODEL`
- upload guard var: `TRANSCRIBE_FILE_MAX_BYTES` (default `20971520`)
- legacy names `GATEWAY_SHARED_SECRET` and `OPENAI_*` are no longer used by `ai-gateway` runtime code

## Requirements

- Node.js 20+
- shared secret between main app and gateway
- provider credentials: `POLZA_API_KEY` (optional overrides: `POLZA_BASE_URL`, `POLZA_MODEL`, `POLZA_TRANSCRIPTION_MODEL`, `POLZA_TRANSCRIBE_MODEL`, `POLZA_TRANSCRIBE_MODEL_CANDIDATE`, `POLZA_TIMEOUT_MS`, `POLZA_MAX_RETRIES`, `ALLOW_REQUEST_MODEL_OVERRIDES`)

## Model defaults and compatibility

- default text analysis model: `POLZA_MODEL=openai/gpt-5-mini`
- recommended STT model env: `POLZA_TRANSCRIPTION_MODEL=openai/gpt-4o-mini-transcribe`
- safe fallback when STT env is not set: `openai/gpt-4o-transcribe`
- default retry policy: `POLZA_MAX_RETRIES=0` (disable hidden automatic SDK retries)
- request-level model overrides are blocked by default: `ALLOW_REQUEST_MODEL_OVERRIDES=false`
- set `ALLOW_REQUEST_MODEL_OVERRIDES=true` only for controlled debug/experiment windows
- compatibility mapping is centralized in `src/config.js`: `openai/gpt-5-mini -> gpt-5-mini` for analyze, `openai/gpt-4o-mini-transcribe -> gpt-4o-mini-transcribe` (and legacy `openai/gpt-4o-transcribe -> gpt-4o-transcribe`) for transcribe
- cheaper model testing is opt-in only via request override (`transcribeModel`) or script flags
- do not do blind full switch to `openai/whisper-1` without validation on real recordings

## Quick rollback / switch

- rollback to previous model: set `POLZA_TRANSCRIPTION_MODEL=openai/gpt-4o-transcribe` and restart `ai-gateway`
- switch to whisper experiment: set `POLZA_TRANSCRIPTION_MODEL=openai/whisper-1` and restart `ai-gateway`
- for backward compatibility you can set legacy alias `POLZA_TRANSCRIBE_MODEL` with the same values

## Quick local start

```bash
cd ai-gateway
npm install
cp .env.example .env
npm run dev
```

Production start:

```bash
npm start
```

## Docker

Build:

```bash
docker build -t ai-gateway:latest .
```

Run:

```bash
docker run --rm -p 3001:3001 --env-file .env ai-gateway:latest
```

## Example `GET /healthz`

```bash
curl -s http://localhost:3001/healthz
```

Expected response:

```json
{"status":"ok"}
```

Production host-level verification on the current VM:

```bash
curl -s http://127.0.0.1:3001/healthz
```

Main app container runtime should still use `http://ai-gateway:3001` on `t2-app-net`.

## Example `POST /analyze`

```bash
curl -s -X POST http://localhost:3001/analyze \
  -H "Content-Type: application/json" \
  -H "x-gateway-secret: replace_with_strong_shared_secret" \
  -d '{
    "requestId": "req-12345",
    "phone": "+79990001122",
    "callDateTime": "2026-03-13T11:00:00+03:00",
    "transcript": "Здравствуйте, нужен срочный выезд сервисного инженера..."
  }'
```

Expected response shape:

```json
{
  "category": "сервис",
  "topic": "Срочный выезд инженера",
  "summary": "Клиент запросил срочный сервисный выезд.",
  "outcome": "Запрос принят в работу.",
  "nextStep": "Связаться с клиентом и согласовать время выезда.",
  "priority": "high",
  "tags": ["сервис", "срочно", "выезд"]
}
```

## Example `POST /transcribe`

```bash
curl -s -X POST http://localhost:3001/transcribe \
  -H "x-gateway-secret: replace_with_strong_shared_secret" \
  -F "requestId=req-stt-1" \
  -F "fileName=sample.mp3" \
  -F "mimeType=audio/mpeg" \
  -F "transcribeModel=openai/gpt-4o-mini-transcribe" \
  -F "audio=@./sample.mp3;type=audio/mpeg"
```

For candidate model test without full switch:

```bash
curl -s -X POST http://localhost:3001/transcribe \
  -H "x-gateway-secret: replace_with_strong_shared_secret" \
  -F "transcribeModel=candidate" \
  -F "audio=@./sample.mp3;type=audio/mpeg"
```

Expected response shape:

```json
{
  "transcript": "Здравствуйте, подскажите цену и срок поставки.",
  "model": "gpt-4o-mini-transcribe",
  "audioBytes": 98304
}
```

## API errors

- `401` если отсутствует или неверный `x-gateway-secret`
- `400` если `transcript`/`audio` пустой, multipart невалиден или JSON невалиден
- `400` если передан `transcribeModel=candidate`, но `POLZA_TRANSCRIBE_MODEL_CANDIDATE` не задан
- `413` если файл больше `TRANSCRIBE_FILE_MAX_BYTES` или JSON body превышает `BODY_LIMIT`
- `502` если ошибка обращения к upstream provider
