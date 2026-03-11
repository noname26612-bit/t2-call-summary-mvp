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

## Current project status (fixed baseline)
- current state is a **local MVP**
- real t2 API is **not connected yet**
- `/dev/t2-ingest` is a **scaffold/debug route**, not a production endpoint
- production-grade storage is **not implemented yet**

## Storage rule
- `data/processed-calls.json` and `data/call-history.json` are allowed only for local MVP / single-instance mode
- for production or multi-instance mode, use another storage layer (shared persistent storage)

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

Codex practical response must always include:
1. list of changed files
2. full code of new/changed files
3. commands for manual verification
4. expected verification result

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

## Do not touch extra scope
- do not change endpoint contracts unless explicitly requested
- do not add new dependencies unless truly necessary for the requested task
- do not do "beauty refactors" when the task is local and focused

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
- do not create a new project unless explicitly requested
- do not rewrite system-level instructions
- keep project rules compact; do not turn them into a long "constitutional" document
