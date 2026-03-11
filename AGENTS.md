# AGENTS.md

## Project
MVP integration:
t2 АТС -> API t2 -> mini-service -> OpenAI -> Telegram

## Goal
After each completed call:
1. get transcript
2. analyze transcript with OpenAI
3. return structured JSON
4. send summary to Telegram

## Collaboration rule
This project is managed in parallel in:
- ChatGPT
- Codex

That means:
- architecture, logic, API questions, and debugging can be discussed in ChatGPT
- code implementation can be executed in Codex
- every practical response must be easy to continue in either ChatGPT or Codex

## Response format
Before making changes:
1. briefly explain what you are going to do
2. list which files you will create or modify

After making changes:
1. list all changed files
2. explain in simple language what was done
3. provide exact commands to run
4. provide exact commands or steps to test
5. describe the expected result
6. mention likely errors or edge cases

## Implementation style
- prefer the simplest possible implementation
- optimize for a working MVP, not ideal architecture
- avoid unnecessary abstractions
- avoid premature optimization
- keep files small and readable
- use clear variable names
- write full code, never placeholders
- if a detail of an external API is unknown, do not invent it
- mark uncertain integration details explicitly

## Technical preferences
- beginner-friendly code
- simple project structure
- JavaScript first, not TypeScript
- Express for the first MVP
- use environment variables for secrets
- do not refactor unrelated files
- make focused, minimal changes

## Delivery format for every practical task
1. plan
2. files to change
3. code changes
4. run commands
5. test steps
6. expected result
7. risks / common errors

## Business rules
The service must be able to:
- receive new calls from t2
- receive transcript
- send transcript to OpenAI
- receive structured JSON
- send final summary to Telegram

Telegram summary must contain:
- client phone
- date/time
- category
- topic
- brief summary
- outcome
- next step
- urgency
- tags

Allowed categories:
- продажа
- сервис
- запчасти
- аренда
- спам
- прочее

Important filter rule:
- do not analyze employee calls
- do not analyze internal calls
- ignore-list filtering must happen before sending anything to OpenAI

## Work strategy
Implement in small steps:
1. mock version first
2. local test route
3. OpenAI analysis
4. Telegram sending
5. ignored phone filtering
6. processed calls storage
7. real t2 API polling
8. real transcript retrieval

## Parallel workflow rule
Always make explicit:
- what should be discussed in ChatGPT
- what should be executed in Codex
- what the user should run manually
- how to verify the result

When proposing implementation work, always include a ready-to-send Codex prompt.

## Safety against chaos
- do not attempt to build the entire project in one step
- do not introduce database, queue, docker, auth frameworks, or cloud deployment unless explicitly requested
- do not change package choices without explaining why
- do not remove working code unless necessary
