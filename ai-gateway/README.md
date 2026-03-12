# ai-gateway

Тонкий HTTP integration layer между main app и AI provider.

## Current strategy

- `ai-gateway` остаётся обязательным boundary
- fixed long-term upstream strategy: **Polza**
- local Polza validation: **confirmed**

Целевая схема после code cutover:

`main app (Yandex VM) -> ai-gateway -> Polza`

## Status update

`ai-gateway` is now locally validated against Polza as upstream provider.

Confirmed locally:
- `GET /healthz` returns `{ "status": "ok" }`
- `POST /analyze` returns structured analysis through Polza
- auth via shared secret works
- the service is successfully used by the main app in local end-to-end flow

Current next step:
- deploy the same gateway runtime on the existing Yandex VM
- run first production smoke through the full Polza-backed path

## Endpoints

- `GET /healthz` -> `{ "status": "ok" }`
- `POST /analyze` -> возвращает структурированный анализ

## Runtime naming status (current vs target)

Current runtime names in code:

- shared secret: `GATEWAY_SHARED_SECRET`
- provider vars: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS`

Target names after separate code cutover:

- shared secret: `AI_GATEWAY_SHARED_SECRET`
- provider vars: `POLZA_API_KEY`, `POLZA_BASE_URL`, `POLZA_MODEL`

Не отмечайте production cutover как complete до VM smoke.

## Requirements

- Node.js 20+
- shared secret between main app and gateway
- provider credentials (current names or target names after code cutover)

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

## API errors

- `401` если отсутствует или неверный `x-gateway-secret`
- `400` если `transcript` пустой или тело запроса невалидный JSON
- `502` если ошибка обращения к upstream provider
