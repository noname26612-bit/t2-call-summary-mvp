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

TOKEN_REFRESH_ENABLED_RAW="${TELE2_POLL_TOKEN_REFRESH_ENABLED:-true}"
TOKEN_REFRESH_ON_403_RAW="${TELE2_POLL_TOKEN_REFRESH_ON_403:-true}"
TOKEN_REFRESH_LEEWAY_SECONDS="${TELE2_POLL_TOKEN_REFRESH_LEEWAY_SECONDS:-900}"
TOKEN_REFRESH_HELPER="${TELE2_POLL_TOKEN_REFRESH_HELPER:-${PROJECT_DIR}/scripts/refresh-tele2-token.sh}"

EXIT_CONFIG_ERROR=2
EXIT_REFRESH_ERROR=3
RUN_FINISHED=0
LAST_RUN_OUTPUT_FILE=""

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

read_env_value() {
  local file_path="$1"
  local key="$2"

  if [ ! -f "$file_path" ]; then
    printf ''
    return 0
  fi

  local line
  line="$(grep -E "^${key}=" "$file_path" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    printf ''
    return 0
  fi

  printf '%s' "${line#*=}"
}

resolve_env_value() {
  local key="$1"
  local fallback="${2:-}"
  local value="${!key-}"

  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  value="$(read_env_value "$POLL_ENV_FILE" "$key")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  value="$(read_env_value "$MAIN_ENV_FILE" "$key")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi

  printf '%s' "$fallback"
}

access_token_exp_epoch() {
  local token="$1"
  python3 - "$token" <<'PY'
import base64
import json
import sys

token = (sys.argv[1] or '').strip()
parts = token.split('.')
if len(parts) < 2:
    raise SystemExit(2)

payload = parts[1]
payload += '=' * (-len(payload) % 4)

try:
    decoded = base64.urlsafe_b64decode(payload.encode('ascii')).decode('utf-8')
    body = json.loads(decoded)
except Exception:
    raise SystemExit(2)

exp = body.get('exp')
if not isinstance(exp, (int, float)):
    raise SystemExit(2)

print(int(exp))
PY
}

is_access_token_expiring_soon() {
  local leeway_seconds="$1"
  local access_token
  access_token="$(resolve_env_value "T2_API_TOKEN" "")"

  if [ -z "$access_token" ]; then
    access_token="$(resolve_env_value "T2_ACCESS_TOKEN" "")"
  fi

  if [ -z "$access_token" ]; then
    return 2
  fi

  local expires_at
  if ! expires_at="$(access_token_exp_epoch "$access_token" 2>/dev/null)"; then
    return 2
  fi

  if ! [[ "$expires_at" =~ ^[0-9]+$ ]]; then
    return 2
  fi

  local now
  now="$(date +%s)"

  if [ "$expires_at" -le $((now + leeway_seconds)) ]; then
    return 0
  fi

  return 1
}

run_refresh_helper() {
  local reason="$1"

  if [ ! -x "$TOKEN_REFRESH_HELPER" ]; then
    log_json "error" "token_refresh_helper_missing" "path" "$TOKEN_REFRESH_HELPER"
    return "$EXIT_CONFIG_ERROR"
  fi

  if [ ! -f "$POLL_ENV_FILE" ]; then
    log_json "error" "token_refresh_env_missing" "envFile" "$POLL_ENV_FILE"
    return "$EXIT_CONFIG_ERROR"
  fi

  if [ ! -r "$POLL_ENV_FILE" ] || [ ! -w "$POLL_ENV_FILE" ]; then
    log_json "error" "token_refresh_env_not_read_write" "envFile" "$POLL_ENV_FILE"
    return "$EXIT_CONFIG_ERROR"
  fi

  local refresh_token
  refresh_token="$(resolve_env_value "T2_REFRESH_TOKEN" "")"
  if [ -z "$refresh_token" ]; then
    log_json "warn" "token_refresh_skipped_missing_refresh_token" "envFile" "$POLL_ENV_FILE"
    return 1
  fi

  log_json "info" "token_refresh_started" "reason" "$reason" "envFile" "$POLL_ENV_FILE"

  set +e
  "$TOKEN_REFRESH_HELPER" --env-file "$POLL_ENV_FILE"
  local refresh_exit_code=$?
  set -e

  if [ "$refresh_exit_code" -eq 0 ]; then
    log_json "info" "token_refresh_finished" "reason" "$reason" "status" "success"
    return 0
  fi

  log_json "error" "token_refresh_failed" "reason" "$reason" "exitCode" "$refresh_exit_code"
  return "$EXIT_REFRESH_ERROR"
}

run_output_has_t2_auth_403() {
  local output_file="$1"
  python3 - "$output_file" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
    text = fh.read()

if not re.search(r'"statusCode"\s*:\s*403', text):
    raise SystemExit(1)

codes = re.findall(r'"code"\s*:\s*"([^"]+)"', text)
if any(code.startswith('T2_') for code in codes) or 'Tele2' in text:
    raise SystemExit(0)

raise SystemExit(1)
PY
}

run_poll_once() {
  local attempt="$1"
  local run_name
  run_name="t2-tele2-poll-once-$(date +%s)-$$-${attempt}"

  LAST_RUN_OUTPUT_FILE="$(mktemp /tmp/t2-tele2-poll-output.XXXXXX)"

  log_json "info" "poll_once_start" "containerName" "$run_name" "attempt" "$attempt"

  set +e
  docker run --rm \
    --name "$run_name" \
    --user "$(id -u):$(id -g)" \
    --network "$DOCKER_NETWORK" \
    "${env_file_args[@]}" \
    -v "$PROJECT_DIR:/app" \
    -w /app \
    "$DOCKER_IMAGE" \
    node "${poll_args[@]}" > "$LAST_RUN_OUTPUT_FILE" 2>&1
  local run_exit_code=$?
  set -e

  cat "$LAST_RUN_OUTPUT_FILE"

  if [ "$run_exit_code" -eq 0 ]; then
    log_json "info" "poll_once_finished" "exitCode" "$run_exit_code" "attempt" "$attempt"
  else
    log_json "error" "poll_once_failed" "exitCode" "$run_exit_code" "attempt" "$attempt"
  fi

  return "$run_exit_code"
}

on_exit() {
  local exit_code=$?

  if [ -n "$LAST_RUN_OUTPUT_FILE" ] && [ -f "$LAST_RUN_OUTPUT_FILE" ]; then
    rm -f "$LAST_RUN_OUTPUT_FILE" || true
  fi

  if [ "$RUN_FINISHED" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
    log_json "error" "wrapper_failed" "exitCode" "$exit_code"
  fi
}

trap on_exit EXIT

require_cmd docker
require_cmd flock
require_cmd tee
require_cmd date
require_cmd grep
require_cmd mktemp
require_cmd python3

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

if ! TOKEN_REFRESH_ENABLED="$(normalize_bool "$TOKEN_REFRESH_ENABLED_RAW")"; then
  log_json "error" "invalid_boolean_value" "name" "TELE2_POLL_TOKEN_REFRESH_ENABLED" "value" "$TOKEN_REFRESH_ENABLED_RAW"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if ! TOKEN_REFRESH_ON_403="$(normalize_bool "$TOKEN_REFRESH_ON_403_RAW")"; then
  log_json "error" "invalid_boolean_value" "name" "TELE2_POLL_TOKEN_REFRESH_ON_403" "value" "$TOKEN_REFRESH_ON_403_RAW"
  RUN_FINISHED=1
  exit "$EXIT_CONFIG_ERROR"
fi

if ! [[ "$TOKEN_REFRESH_LEEWAY_SECONDS" =~ ^[0-9]+$ ]]; then
  log_json "error" "invalid_integer_value" "name" "TELE2_POLL_TOKEN_REFRESH_LEEWAY_SECONDS" "value" "$TOKEN_REFRESH_LEEWAY_SECONDS"
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
  "retryFailed" "$RETRY_FAILED" \
  "tokenRefreshEnabled" "$TOKEN_REFRESH_ENABLED" \
  "tokenRefreshOn403" "$TOKEN_REFRESH_ON_403" \
  "tokenRefreshLeewaySeconds" "$TOKEN_REFRESH_LEEWAY_SECONDS"

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

if [ "$TOKEN_REFRESH_ENABLED" = 'true' ]; then
  if is_access_token_expiring_soon "$TOKEN_REFRESH_LEEWAY_SECONDS"; then
    log_json "info" "token_refresh_preflight_needed" "reason" "access_token_expiring"
    if ! run_refresh_helper "preflight_expiring_token"; then
      log_json "warn" "token_refresh_preflight_failed_continue" "reason" "access_token_expiring"
    fi
  else
    expiry_check_status=$?
    if [ "$expiry_check_status" -eq 2 ]; then
      log_json "warn" "token_refresh_preflight_skipped" "reason" "access_token_expiry_unknown"
    else
      log_json "info" "token_refresh_preflight_not_needed"
    fi
  fi
fi

run_exit_code=0
if run_poll_once "initial"; then
  run_exit_code=0
else
  run_exit_code=$?

  if [ "$TOKEN_REFRESH_ENABLED" = 'true' ] && [ "$TOKEN_REFRESH_ON_403" = 'true' ] && run_output_has_t2_auth_403 "$LAST_RUN_OUTPUT_FILE"; then
    log_json "warn" "poll_once_auth_403_detected" "action" "refresh_and_retry_once"

    if run_refresh_helper "retry_after_auth_403"; then
      if run_poll_once "retry_after_refresh"; then
        run_exit_code=0
      else
        run_exit_code=$?
      fi
    else
      run_exit_code="$EXIT_REFRESH_ERROR"
    fi
  fi
fi

RUN_FINISHED=1
exit "$run_exit_code"
