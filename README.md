# t2-call-summary-mvp

Node.js/Express сервис для обработки телефонных звонков и доставки короткой сводки в Telegram.
Базовый pipeline: `call event -> transcript -> ai-gateway analysis -> PostgreSQL runtime storage -> Telegram summary`.

## Кратко о проекте

Сервис принимает событие звонка, извлекает/получает транскрипт, прогоняет анализ через `ai-gateway`, сохраняет runtime-данные в PostgreSQL и отправляет итоговую сводку в Telegram.

## Что уже реализовано

- приём и валидация call event
- анализ транскрипта через `ai-gateway`
- реконструкция диалога по plain transcript (без отдельного audio diarization provider)
- confidence-aware summary (осторожный стиль при низкой уверенности в ролях)
- employee phone directory (lookup сотрудника по внутреннему номеру, active-only)
- runtime storage на PostgreSQL
- доставка summary в Telegram
- production deploy на Yandex VM
- baseline health checks и monitoring

## Production architecture

- `main app` (`src/server.js` + application services): ingress, orchestration, Telegram delivery, health endpoints
- `ai-gateway` (`ai-gateway/`): отдельный AI boundary и provider routing
- PostgreSQL: runtime source of truth для call events, служебного состояния и offset'ов
- Telegram Bot API: доставка summary и callback-driven выдача transcript `.txt`
- container-to-container routing: main app и `ai-gateway` работают как отдельные контейнеры в одной Docker network

## Этапы проекта

- Local MVP - завершён
- PostgreSQL runtime migration - завершён
- First Yandex Cloud production baseline - завершён
- ai-gateway / provider routing stabilization - завершён
- Polza cutover - завершён
- Tele2 poller production hardening - завершён
- Telegram message format v2 - в работе (post-baseline improvement)

## Текущий статус

- core production flow стабилен
- дальнейшие изменения идут как точечные post-baseline улучшения

## Repo guide / документы

- `README.md` - high-level карта проекта и текущего статуса
- `TASKS.md` - рабочий список задач и next steps
- `DEPLOY_PROGRESS.md` - operational журнал rollout/проверок
- `.env.example` - переменные окружения и безопасные дефолты
- `ops/*` - infrastructure/operations шаблоны (systemd, logrotate и др.)

## Local run / smoke test

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

Короткий smoke:

- `GET /healthz` возвращает `ok`
- тестовый `POST /api/process-call` приводит к отправке summary в Telegram

Дополнительно:

- `npm run smoke:dialog-reconstruction`
- `npm run smoke:employee-directory`
- `npm run acceptance:real-calls`
- `npm run audit:call-meta -- --hours 24 --source tele2_poll_once`
- `npm run admin:employee-directory -- lookup --phone "+79991234567"`

## Что не входит в текущую архитектуру

- Kubernetes
- Redis
- очереди
- отдельные worker-процессы (worker separation)
