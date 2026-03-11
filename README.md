# t2-call-summary-mvp

Минимальный локальный scaffold для этапа MVP с OpenAI-анализом звонков, отправкой результата в Telegram и локальным хранением уже обработанных звонков.

## Requirements
- Node.js 18+
- npm

## Setup
```bash
npm install
```

Создай локальный `.env`:
```bash
cp .env.example .env
```

Пример `.env`:
```env
PORT=3000
IGNORED_PHONES=+79990000001,+79990000002
OPENAI_API_KEY=your_openai_api_key_here
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
TELEGRAM_API_TIMEOUT_MS=10000
T2_API_BASE_URL=https://example.t2.api
T2_API_TOKEN=your_t2_api_token_here
T2_API_TIMEOUT_MS=10000
```

## Обязательные env
При старте сервиса обязательно должны быть заданы и не быть пустыми:
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

`PORT`, `IGNORED_PHONES`, `TELEGRAM_API_TIMEOUT_MS`, `T2_API_BASE_URL`, `T2_API_TOKEN` и `T2_API_TIMEOUT_MS` на этом этапе не считаются обязательными для старта.

Пример ошибки запуска без обязательных env:
```bash
Runtime environment validation failed: Missing required environment variables: OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

## Telegram setup
1. Создай бота в Telegram через `@BotFather`:
   - отправь команду `/newbot`
   - задай имя и username
   - сохрани выданный токен в `TELEGRAM_BOT_TOKEN`
2. Получи `chat_id`:
   - напиши любое сообщение своему боту
   - выполни запрос:
     ```bash
     curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
     ```
   - возьми `message.chat.id` и сохрани в `TELEGRAM_CHAT_ID`

Параметр таймаута отправки в Telegram:
- `TELEGRAM_API_TIMEOUT_MS` (опционально) — timeout HTTP-запроса к Telegram в миллисекундах
- по умолчанию используется `10000`
- если задан, должен быть положительным целым числом, иначе будет ошибка конфигурации сервера

## Run
```bash
npm run dev
```

Production-like run:
```bash
npm start
```

Сервер поднимается на порту из `.env` (`PORT`), либо на `3000` по умолчанию.

## Endpoints

### GET /health
Проверка, что сервис работает.

Пример:
```bash
curl -X GET http://localhost:3000/health
```

### POST /dev/mock-call
Локальный mock endpoint для приёма звонка.

Тело запроса:
- `phone` (string)
- `callDateTime` (string)
- `transcript` (string, обязателен и не пустой)

Пример:
```bash
curl -X POST http://localhost:3000/dev/mock-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79991234567",
    "callDateTime": "2026-03-11T15:00:00+03:00",
    "transcript": "Клиент уточнил наличие запчасти и сроки доставки"
  }'
```

Если `transcript` пустой или отсутствует, endpoint возвращает `400`.

### POST /api/process-call
Полный локальный сценарий обработки:
- валидация входных данных
- проверка ignore-list внутренних номеров
- проверка дубля по fingerprint (`phone|callDateTime|transcript`) в локальном JSON store
- OpenAI structured JSON-анализ (только для неигнорируемых и не-дублирующихся звонков)
- отправка краткого результата анализа в Telegram (только для неигнорируемых и не-дублирующихся звонков)
- сохранение обработанного звонка в локальный store после попытки отправки в Telegram

Если номер в `IGNORED_PHONES`, ответ:
- `status: "ignored"`
- `reason: "internal_phone"`
- OpenAI не вызывается
- Telegram не вызывается
- локальный store не трогается

Если номер не в ignore-list и звонок уже обрабатывался ранее, ответ:
- `status: "duplicate"`
- `reason: "already_processed"`
- OpenAI не вызывается
- Telegram не вызывается

Если номер не в ignore-list и это новый звонок, ответ:
- `status: "processed"`
- `analysis` со structured JSON
- `telegram.status`:
  - `"sent"` если сообщение ушло
  - `"failed"` если Telegram недоступен/некорректно настроен или превышен timeout `TELEGRAM_API_TIMEOUT_MS` (при этом endpoint всё равно возвращает `200` и `analysis`)
- даже при `telegram.status: "failed"` звонок считается обработанным и сохраняется в store

Пример для игнорируемого номера:
```bash
curl -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79990000001",
    "callDateTime": "2026-03-11T15:00:00+03:00",
    "transcript": "Клиент хочет купить оборудование"
  }'
```

Пример для обычного номера:
```bash
curl -X POST http://localhost:3000/api/process-call \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79991234567",
    "callDateTime": "2026-03-11T15:00:00+03:00",
    "transcript": "Хочу узнать стоимость и купить запчасть"
  }'
```

Пример ответа:
```json
{
  "status": "processed",
  "phone": "+79991234567",
  "callDateTime": "2026-03-11T15:00:00+03:00",
  "analysis": {
    "category": "прочее",
    "topic": "Короткое название темы",
    "summary": "Краткая суть разговора",
    "result": "Чем закончился разговор",
    "nextStep": "Что делать дальше",
    "urgency": "низкая",
    "tags": ["звонок"],
    "confidence": 0.5
  },
  "telegram": {
    "status": "sent"
  }
}
```

Если отправка в Telegram не удалась, пример ответа:
```json
{
  "status": "processed",
  "phone": "+79991234567",
  "callDateTime": "2026-03-11T15:00:00+03:00",
  "analysis": {
    "category": "прочее",
    "topic": "Короткое название темы",
    "summary": "Краткая суть разговора",
    "result": "Чем закончился разговор",
    "nextStep": "Что делать дальше",
    "urgency": "низкая",
    "tags": ["звонок"],
    "confidence": 0.5
  },
  "telegram": {
    "status": "failed"
  }
}
```

### Формат Telegram-уведомления
Для каждого звонка со `status: "processed"` отправляется компактное сообщение в едином формате:

```text
Обработанный звонок
Категория: ...
Тема: ...
Телефон: ...
Дата и время: ...
Сводка: ...
Результат: ...
Следующий шаг: ...
Срочность: ...
Теги: ...
```

Правила форматирования:
- единая структура для всех `processed`-звонков
- если поле отсутствует или пустое, подставляется `—`
- `Теги` всегда в одной строке через запятую; если тегов нет, выводится `—`
- сообщение отправляется как plain text без markdown-разметки

### Финальная схема `analysis`
- `category`: enum из фиксированного списка
  - `запчасти`
  - `ремонт`
  - `покупка_станка`
  - `аренда`
  - `сервис`
  - `доставка`
  - `прочее`
- `topic`: непустая строка, до `80` символов после `trim`
- `summary`: непустая строка, до `220` символов после `trim`
- `result`: непустая строка, до `160` символов после `trim`
- `nextStep`: непустая строка, до `160` символов после `trim`
- `urgency`: enum
  - `низкая`
  - `средняя`
  - `высокая`
- `tags`: массив строк, от `1` до `5` элементов, каждый тег непустой после `trim`, без дублей
- `confidence`: number от `0` до `1`

### Невалидный ответ модели
- Сначала применяется нормализация/постобработка:
  - trim строковых полей
  - ограничение длины полей `topic/summary/result/nextStep`
  - нормализация `category` и `urgency` к допустимым enum
  - очистка `tags`: удаление пустых значений и дублей, ограничение до `1..5`
  - нормализация `confidence` в диапазон `0..1`
- Если после нормализации привести ответ к допустимой схеме нельзя, сервис возвращает понятную ошибку `502 OpenAI error`.

Пример ответа для дубля:
```json
{
  "status": "duplicate",
  "reason": "already_processed",
  "phone": "+79991234567",
  "callDateTime": "2026-03-11T15:00:00+03:00"
}
```

## T2 integration scaffold

Текущая интеграция t2 сделана только как безопасный каркас. Реальное подключение возможно только после получения официальной документации t2 API.

Сейчас добавлено:
- `src/services/t2Client.js`
- `src/services/t2Mapper.js`
- `src/services/t2IngestService.js`
- `POST /dev/t2-ingest`

`/dev/t2-ingest` нужен как локальный мост для теста будущего payload от t2 до подключения реального контракта.

Реальные `endpoint/pathname`, webhook/polling contract и детали auth для t2 не реализованы без документации.

Пример локального теста:
```bash
curl -X POST http://localhost:3000/dev/t2-ingest \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+79991234567",
    "callDateTime": "2026-03-11T20:00:00+03:00",
    "transcript": "Клиент уточняет цену и наличие ролика"
  }'
```

Пример альтернативного payload:
```bash
curl -X POST http://localhost:3000/dev/t2-ingest \
  -H "Content-Type: application/json" \
  -d '{
    "caller": "+79991234567",
    "createdAt": "2026-03-11T20:05:00+03:00",
    "text": "Клиент уточняет цену и наличие ролика"
  }'
```

## Локальное хранилище обработанных звонков

- Файл store: `data/processed-calls.json`
- Формат: JSON-массив записей с полями `fingerprint`, `phone`, `callDateTime`, `createdAt`
- Файл и папка `data` создаются автоматически при первой проверке/записи

Это dedup-store, который используется только для определения дублей.

Сценарий проверки duplicate:
1. Отправь обычный запрос в `/api/process-call` (номер не из ignore-list) -> ожидается `status: "processed"`.
2. Повтори точно такой же запрос (`phone`, `callDateTime`, `transcript` те же) -> ожидается `status: "duplicate"`.

## Локальная история обработки звонков (audit/debug)

- Файл истории: `data/call-history.json`
- Формат: JSON-массив записей по каждому сценарию обработки (`ignored`, `duplicate`, `processed`)
- История не участвует в dedup-логике и не влияет на решение о дублях
- Запись (`append`) сериализуется внутри одного процесса Node.js, чтобы одновременные append-вызовы не теряли записи из-за гонки `read/write`
- Это не межпроцессная блокировка и не полноценная БД (при нескольких процессах/инстансах гарантии не даются)

Поля записи истории:
- `status`
- `reason` (если есть)
- `phone`
- `callDateTime`
- `createdAt`
- `source` (`api_process_call`, `t2_ingest`, `unknown`)
- `transcriptPreview` (первые `200` символов transcript после `trim`)
- `analysis` (только для `status: "processed"`)
- `telegramStatus` (только если есть `telegram.status`)

Если запись истории не удалась, основной endpoint не ломается: ошибка логируется в консоль, а клиент получает обычный ответ по текущему сценарию.

## Ошибки

- `400 Validation error`:
  - отсутствует или пустой `phone`, `callDateTime` или `transcript`
  - невалидный JSON в теле запроса
- `500 Server configuration error`:
  - отсутствует `OPENAI_API_KEY` для неигнорируемого звонка
- `502 OpenAI error`:
  - ошибка запроса к OpenAI
  - модель вернула невалидный JSON/структуру анализа, которую не удалось нормализовать до допустимой схемы
- Ошибка Telegram:
  - endpoint не падает и остаётся `200`
  - в ответе возвращается `telegram.status: "failed"`
  - при timeout Telegram-запрос отменяется через `AbortController`, чтобы endpoint не зависал дольше заданного лимита
