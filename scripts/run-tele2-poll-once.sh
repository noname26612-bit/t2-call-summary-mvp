#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/artem266/t2-call-summary-mvp}"
MAIN_ENV_FILE="${TELE2_POLL_MAIN_ENV_FILE:-/opt/t2-call-summary/main.env}"
POLL_ENV_FILE="${TELE2_POLL_ENV_FILE:-/opt/t2-call-summary/tele2-poll.env}"
LOCK_FILE="${TELE2_POLL_LOCK_FILE:-/tmp/t2-tele2-poll.lock}"
LOG_FILE="${TELE2_POLL_LOG_FILE:-${PROJECT_DIR}/logs/tele2-poll-once.log}"
DOCKER_IMAGE="${TELE2_POLL_NODE_IMAGE:-node:20-alpine}"
DOCKER_NETWORK="${TELE2_POLL_DOCKER_NETWORK:-t2-app-net}"

LOOKBACK_MINUTES="${TELE2_POLL_LOOKBACK_MINUTES:-60}"
FETCH_LIMIT="${TELE2_POLL_FETCH_LIMIT:-30}"
MAX_CANDIDATES="${TELE2_POLL_MAX_CANDIDATES:-10}"
MIN_AUDIO_BYTES="${TELE2_POLL_MIN_AUDIO_BYTES:-4096}"
TIMEOUT_MS="${TELE2_POLL_TIMEOUT_MS:-180000}"
DRY_RUN_RAW="${TELE2_POLL_DRY_RUN:-false}"
RETRY_FAILED_RAW="${TELE2_POLL_RETRY_FAILED:-true}"

T2_AUTH_SCHEME_VALUE="${T2_AUTH_SCHEME:-plain}"
AI_GATEWAY_URL_VALUE="${AI_GATEWAY_URL:-http://ai-gateway:3001}"
AI_GATEWAY_TRANSCRIBE_PATH_VALUE="${AI_GATEWAY_TRANSCRIBE_PATH:-/transcribe}"
PROCESS_CALL_URL_VALUE="${PROCESS_CALL_URL:-http://t2-call-summary:3000/api/process-call}"

EXIT_CONFIG_ERROR=2
RUN_FINISHED=0

normalize_bool() {
  local raw="$1"
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"

  case "$normalized" in
    1|true|yes|on)
      printf 'true'
      ;;
    0|false|no|off)
      printf 'false'
      ;;
    *)
      return 1
      ;;
  esac
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_json "error" "required_command_missing" "command" "$cmd"
    RUN_FINISHED=1
    exit "$EXIT_CONFIG_ERROR"
  fi
}

timestamp() {
  date --iso-8601=seconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z'
}

json_escape() {
  local raw="${1:-}"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/\\n}"
  raw="${raw//$'\r'/\\r}"
  raw="${raw//$'\t'/\\t}"
  printf '%s' "$raw"
}

log_json() {
  local level="$1"
  local message="$2"
  shift 2

  local fields=""
  while [ "$#" -gt 1 ]; do
    local key="$1"
    local value="$2"
    shift 2
    fields="${fields},\"$(json_escape "$key")\":\"$(json_escape "$value")\""
  done

  printf '{"timestamp":"%s","level":"%s","service":"tele2-poll-wrapper","message":"%s"%s}\n' \
    "$(json_escape "$(timestamp)")" \
    "$(json_escape "$level")" \
    "$(json_escape "$message")" \
    "$fields"
}

on_exit() {
  local exit_code=$?
  if [ "$RUN_FINISHED" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
    log_json "error" "wrapper_failed" "exitCode" "$exit_code"
  fi
}

trap on_exit EXIT

require_cmd docker
require_cmd flock
require_cmd tee
require_cmd date

if ! DRY_RUN="$(normalize_bool "$DRY_RUN_RAW")"; then
  log_json "error" "invalid_boolean_value" "name" "TELE2_POLL_DRY_RUN" "value" "$DRY_RUN_RAW"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if ! RETRY_FAILED="$(normalize_bool "$RETRY_FAILED_RAW")"; then
  log_json "error" "invalid_boolean_value" "name" "TELE2_POLL_RETRY_FAILED" "value" "$RETRY_FAILED_RAW"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if [ ! -f "$PROJECT_DIR/src/scripts/pollTele2RecordsOnce.js" ]; then
  log_json "error" "poll_script_not_found" "projectDir" "$PROJECT_DIR"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if [ ! -f "$MAIN_ENV_FILE" ]; then
  log_json "error" "required_env_missing" "path" "$MAIN_ENV_FILE"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if ! docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
  log_json "error" "docker_network_missing" "network" "$DOCKER_NETWORK"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

mkdir -p "$(dirname "$LOCK_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

exec > >(tee -a "$LOG_FILE") 2>&1

log_json "info" "wrapper_started" \
  "projectDir" "$PROJECT_DIR" \
  "dockerNetwork" "$DOCKER_NETWORK" \
  "dryRun" "$DRY_RUN" \
  "lookbackMinutes" "$LOOKBACK_MINUTES" \
  "maxCandidates" "$MAX_CANDIDATES" \
  "timeoutMs" "$TIMEOUT_MS" \
  "retryFailed" "$RETRY_FAILED"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log_json "info" "overlap_detected_skip" "lockFile" "$LOCK_FILE"
  RUN_FINISHED=1
  exit 0
fi

env_file_args=(--env-file "$MAIN_ENV_FILE")
if [ -f "$POLL_ENV_FILE" ]; then
  env_file_args+=(--env-file "$POLL_ENV_FILE")
else
  log_json "info" "optional_env_missing_continue" "path" "$POLL_ENV_FILE"
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  log_json "info" "node_modules_missing_install" "projectDir" "$PROJECT_DIR"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --network "$DOCKER_NETWORK" \
    -v "$PROJECT_DIR:/app" \
    -w /app \
    "$DOCKER_IMAGE" \
    npm ci --omit=dev
fi

poll_args=(
  src/scripts/pollTele2RecordsOnce.js
  --lookback-minutes "$LOOKBACK_MINUTES"
  --fetch-limit "$FETCH_LIMIT"
  --max-candidates "$MAX_CANDIDATES"
  --min-audio-bytes "$MIN_AUDIO_BYTES"
  --timeout-ms "$TIMEOUT_MS"
  --t2-auth-scheme "$T2_AUTH_SCHEME_VALUE"
  --ai-gateway-url "$AI_GATEWAY_URL_VALUE"
  --ai-gateway-transcribe-path "$AI_GATEWAY_TRANSCRIBE_PATH_VALUE"
  --process-url "$PROCESS_CALL_URL_VALUE"
)

if [ "$DRY_RUN" = 'true' ]; then
  poll_args+=(--dry-run)
else
  poll_args+=(--no-dry-run)
fi

if [ "$RETRY_FAILED" = 'true' ]; then
  poll_args+=(--retry-failed)
else
  poll_args+=(--no-retry-failed)
fi

if [ "$#" -gt 0 ]; then
  poll_args+=("$@")
fi

run_name="t2-tele2-poll-once-$(date +%s)-$$"
log_json "info" "poll_once_start" "containerName" "$run_name"

set +e
docker run --rm \
  --name "$run_name" \
  --user "$(id -u):$(id -g)" \
  --network "$DOCKER_NETWORK" \
  "${env_file_args[@]}" \
  -v "$PROJECT_DIR:/app" \
  -w /app \
  "$DOCKER_IMAGE" \
  node "${poll_args[@]}"
run_exit_code=$?
set -e

if [ "$run_exit_code" -eq 0 ]; then
  log_json "info" "poll_once_finished" "exitCode" "$run_exit_code"
else
  log_json "error" "poll_once_failed" "exitCode" "$run_exit_code"
fi
RUN_FINISHED=1
exit "$run_exit_code"
