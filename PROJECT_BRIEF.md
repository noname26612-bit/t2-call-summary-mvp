# PROJECT_BRIEF.md

## Project
`t2 АТС -> API t2 -> main app -> ai-gateway -> AI provider -> Telegram`

## Strategy status

- fixed long-term upstream strategy: **Polza**
- `ai-gateway` is mandatory integration layer
- provider cutover in runtime: **in progress**

## Goal
После каждого завершенного звонка:
1. получить транскрипт
2. проанализировать его через `ai-gateway` (target upstream: Polza)
3. получить структурированный JSON
4. отправить краткую сводку в Telegram

## MVP requirements
Сервис должен:
- получать новые звонки из t2
- получать транскрипт
- отправлять текст в `ai-gateway`
- получать структурированный JSON-ответ
- отправлять итог в Telegram

## Telegram output
В Telegram должно приходить:
- телефон клиента
- дата/время
- категория звонка
- тема звонка
- краткая суть
- итог разговора
- следующий шаг
- срочность
- теги

## Categories
- продажа
- сервис
- запчасти
- аренда
- спам
- прочее

## Important business rule
Не анализировать:
- звонки сотрудников
- внутренние звонки

Такие звонки должны отфильтровываться до отправки в `ai-gateway`.

## Technical direction
Первый этап:
- локальный MVP
- mock-версия без реального API t2
- Node.js + Express + JavaScript
- AI analysis через `ai-gateway`
- Telegram Bot API

Второй этап:
- подключение реального API t2
- polling новых звонков
- получение транскрипта
- исключение уже обработанных звонков

## Main principle
Сначала делаем рабочий MVP.
Только потом улучшаем архитектуру.
