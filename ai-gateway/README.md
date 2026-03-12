# ai-gateway

Тонкий HTTP gateway для вызова OpenAI из поддерживаемого региона.

Схема:

`main app (Yandex VM) -> ai-gateway -> OpenAI API`

## Endpoints

- `GET /healthz` -> `{ "status": "ok" }`
- `POST /analyze` -> возвращает структурированный анализ

## Требования

- Node.js 20+
- `OPENAI_API_KEY`
- общий секрет между main app и gateway (`GATEWAY_SHARED_SECRET`)

## Быстрый локальный запуск

```bash
cd ai-gateway
npm install
cp .env.example .env
npm run dev
```

Продакшен-старт:

```bash
npm start
```

## Docker

Сборка:

```bash
docker build -t ai-gateway:latest .
```

Запуск:

```bash
docker run --rm -p 8080:8080 --env-file .env ai-gateway:latest
```

## Пример `GET /healthz`

```bash
curl -s http://localhost:8080/healthz
```

Ожидаемый ответ:

```json
{"status":"ok"}
```

## Пример `POST /analyze`

```bash
curl -s -X POST http://localhost:8080/analyze \
  -H "Content-Type: application/json" \
  -H "x-gateway-secret: replace_with_strong_shared_secret" \
  -d '{
    "requestId": "req-12345",
    "phone": "+79990001122",
    "callDateTime": "2026-03-12T11:00:00+03:00",
    "transcript": "Здравствуйте, нужен срочный выезд сервисного инженера..."
  }'
```

Ожидаемая форма ответа:

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

## Ошибки API

- `401` если отсутствует или неверный `x-gateway-secret`
- `400` если `transcript` пустой или тело запроса невалидный JSON
- `502` если ошибка запроса к OpenAI
