#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${TELE2_POLL_ENV_FILE:-/opt/t2-call-summary/tele2-poll.env}"
REFRESH_URL_OVERRIDE="${T2_REFRESH_URL:-}"
REFRESH_AUTH_SCHEME_OVERRIDE="${T2_REFRESH_AUTH_SCHEME:-}"
REFRESH_HTTP_METHOD="${T2_REFRESH_HTTP_METHOD:-PUT}"
DEFAULT_T2_BASE_URL="https://ats2.t2.ru/crm/openapi"
HTTP_TIMEOUT_SECONDS="${T2_REFRESH_TIMEOUT_SECONDS:-20}"

EXIT_CONFIG_ERROR=2
EXIT_REFRESH_ERROR=3
EXIT_ENV_WRITE_ERROR=4

json_escape() {
  local raw="${1:-}"
  raw="${raw//\\/\\\\}"
  raw="${raw//\"/\\\"}"
  raw="${raw//$'\n'/\\n}"
  raw="${raw//$'\r'/\\r}"
  raw="${raw//$'\t'/\\t}"
  printf '%s' "$raw"
}

timestamp() {
  date --iso-8601=seconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z'
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

  printf '{"timestamp":"%s","level":"%s","service":"tele2-token-refresh","message":"%s"%s}\n' \
    "$(json_escape "$(timestamp)")" \
    "$(json_escape "$level")" \
    "$(json_escape "$message")" \
    "$fields"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_json "error" "required_command_missing" "command" "$cmd"
    exit "$EXIT_CONFIG_ERROR"
  fi
}

normalize_scheme() {
  local raw="$1"
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"

  case "$normalized" in
    plain|bearer)
      printf '%s' "$normalized"
      ;;
    *)
      return 1
      ;;
  esac
}

build_authorization_header() {
  local token="$1"
  local scheme="$2"

  if [ "$scheme" = "bearer" ]; then
    printf 'Bearer %s' "$token"
    return 0
  fi

  printf '%s' "$token"
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

build_refresh_url() {
  if [ -n "$REFRESH_URL_OVERRIDE" ]; then
    printf '%s' "$REFRESH_URL_OVERRIDE"
    return 0
  fi

  local base_url
  base_url="${T2_API_BASE_URL:-}"
  if [ -z "$base_url" ]; then
    base_url="$(read_env_value "$ENV_FILE" "T2_API_BASE_URL")"
  fi
  if [ -z "$base_url" ]; then
    base_url="$DEFAULT_T2_BASE_URL"
  fi

  printf '%s/authorization/refresh/token' "${base_url%/}"
}

write_tokens_atomically() {
  local file_path="$1"
  local new_access_token="$2"
  local new_refresh_token="$3"

  local backup_path
  backup_path="${file_path}.bak.$(date +%Y%m%d-%H%M%S)"

  local tmp_path
  tmp_path="$(mktemp "${file_path}.tmp.XXXXXX")"

  cp "$file_path" "$backup_path"

  awk -v accessToken="$new_access_token" -v refreshToken="$new_refresh_token" '
    BEGIN {
      wroteAccess = 0;
      wroteRefresh = 0;
    }
    {
      if ($0 ~ /^T2_API_TOKEN=/) {
        print "T2_API_TOKEN=" accessToken;
        wroteAccess = 1;
        next;
      }
      if ($0 ~ /^T2_REFRESH_TOKEN=/) {
        print "T2_REFRESH_TOKEN=" refreshToken;
        wroteRefresh = 1;
        next;
      }
      print $0;
    }
    END {
      if (wroteAccess == 0) {
        print "T2_API_TOKEN=" accessToken;
      }
      if (wroteRefresh == 0) {
        print "T2_REFRESH_TOKEN=" refreshToken;
      }
    }
  ' "$file_path" > "$tmp_path"

  chmod --reference="$file_path" "$tmp_path" 2>/dev/null || chmod 600 "$tmp_path"
  chown --reference="$file_path" "$tmp_path" 2>/dev/null || true

  mv "$tmp_path" "$file_path"

  log_json "info" "env_tokens_updated" \
    "envFile" "$file_path" \
    "backupPath" "$backup_path" \
    "accessTokenLength" "${#new_access_token}" \
    "refreshTokenLength" "${#new_refresh_token}"
}

print_help() {
  cat <<'HELP'
Usage:
  scripts/refresh-tele2-token.sh [options]

Options:
  --env-file <path>       Tele2 poll env file path (default: /opt/t2-call-summary/tele2-poll.env)
  --refresh-url <url>     Full refresh endpoint URL (default: <T2_API_BASE_URL>/authorization/refresh/token)
  --auth-scheme <value>   Refresh auth scheme: plain|bearer (default: T2_REFRESH_AUTH_SCHEME or T2_AUTH_SCHEME or plain)
  --help                  Show this help
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      shift
      ENV_FILE="${1:-}"
      ;;
    --refresh-url)
      shift
      REFRESH_URL_OVERRIDE="${1:-}"
      ;;
    --auth-scheme)
      shift
      REFRESH_AUTH_SCHEME_OVERRIDE="${1:-}"
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      log_json "error" "unknown_argument" "arg" "$1"
      exit "$EXIT_CONFIG_ERROR"
      ;;
  esac
  shift || true
done

require_cmd curl
require_cmd python3
require_cmd awk
require_cmd grep
require_cmd sed
require_cmd tr
require_cmd mktemp

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  log_json "error" "env_file_missing" "envFile" "$ENV_FILE"
  exit "$EXIT_CONFIG_ERROR"
fi

if [ ! -r "$ENV_FILE" ] || [ ! -w "$ENV_FILE" ]; then
  log_json "error" "env_file_not_read_write" "envFile" "$ENV_FILE"
  exit "$EXIT_CONFIG_ERROR"
fi

refresh_token="${T2_REFRESH_TOKEN:-}"
if [ -z "$refresh_token" ]; then
  refresh_token="$(read_env_value "$ENV_FILE" "T2_REFRESH_TOKEN")"
fi
if [ -z "$refresh_token" ]; then
  log_json "error" "refresh_token_missing" "envFile" "$ENV_FILE"
  exit "$EXIT_CONFIG_ERROR"
fi

refresh_url="$(build_refresh_url)"
if [ -z "$refresh_url" ]; then
  log_json "error" "refresh_url_missing" "envFile" "$ENV_FILE"
  exit "$EXIT_CONFIG_ERROR"
fi

auth_scheme_raw="$REFRESH_AUTH_SCHEME_OVERRIDE"
if [ -z "$auth_scheme_raw" ]; then
  auth_scheme_raw="${T2_AUTH_SCHEME:-}"
fi
if [ -z "$auth_scheme_raw" ]; then
  auth_scheme_raw="$(read_env_value "$ENV_FILE" "T2_AUTH_SCHEME")"
fi
if [ -z "$auth_scheme_raw" ]; then
  auth_scheme_raw="plain"
fi

if ! auth_scheme="$(normalize_scheme "$auth_scheme_raw")"; then
  log_json "error" "invalid_auth_scheme" "value" "$auth_scheme_raw"
  exit "$EXIT_CONFIG_ERROR"
fi

http_method="$(printf '%s' "$REFRESH_HTTP_METHOD" | tr '[:lower:]' '[:upper:]')"
case "$http_method" in
  PUT|POST)
    ;;
  *)
    log_json "error" "invalid_http_method" "value" "$http_method"
    exit "$EXIT_CONFIG_ERROR"
    ;;
esac

if ! [[ "$HTTP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$HTTP_TIMEOUT_SECONDS" -le 0 ]; then
  log_json "error" "invalid_timeout_seconds" "value" "$HTTP_TIMEOUT_SECONDS"
  exit "$EXIT_CONFIG_ERROR"
fi

authorization_header="$(build_authorization_header "$refresh_token" "$auth_scheme")"
response_file="$(mktemp /tmp/t2-refresh-response.XXXXXX)"

cleanup() {
  rm -f "$response_file"
}
trap cleanup EXIT

log_json "info" "refresh_request_started" \
  "refreshUrl" "$refresh_url" \
  "httpMethod" "$http_method" \
  "authScheme" "$auth_scheme" \
  "envFile" "$ENV_FILE"

http_status=""
if ! http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
  --max-time "$HTTP_TIMEOUT_SECONDS" \
  -X "$http_method" \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: ${authorization_header}" \
  "$refresh_url")"; then
  log_json "error" "refresh_http_request_failed" "refreshUrl" "$refresh_url"
  exit "$EXIT_REFRESH_ERROR"
fi

if [ "$http_status" != "200" ]; then
  log_json "error" "refresh_http_status_not_ok" \
    "statusCode" "$http_status"
  exit "$EXIT_REFRESH_ERROR"
fi

parsed_tokens="$(
  python3 - "$response_file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)

access = str(payload.get('accessToken') or '').strip()
refresh = str(payload.get('refreshToken') or '').strip()

if not access or not refresh:
    raise SystemExit(2)

print(access)
print(refresh)
PY
)"

new_access_token="$(printf '%s\n' "$parsed_tokens" | sed -n '1p')"
new_refresh_token="$(printf '%s\n' "$parsed_tokens" | sed -n '2p')"

if [ -z "$new_access_token" ] || [ -z "$new_refresh_token" ]; then
  log_json "error" "refresh_response_invalid" "reason" "missing_access_or_refresh"
  exit "$EXIT_REFRESH_ERROR"
fi

if ! write_tokens_atomically "$ENV_FILE" "$new_access_token" "$new_refresh_token"; then
  log_json "error" "env_tokens_update_failed" "envFile" "$ENV_FILE"
  exit "$EXIT_ENV_WRITE_ERROR"
fi

log_json "info" "refresh_request_finished" "status" "success"
exit 0
