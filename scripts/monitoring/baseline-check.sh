#!/usr/bin/env bash
set -u

APP_CONTAINER="${APP_CONTAINER:-t2-call-summary}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-ai-gateway}"
APP_HEALTH_URL="${APP_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
GATEWAY_HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:3001/healthz}"
LOG_WINDOW="${LOG_WINDOW:-15m}"

hard_fail=0
signal_fail=0

print_section() {
  printf '\n%s\n' "$1"
}

print_result() {
  printf '%s\n' "$1"
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

check_container() {
  local container_name="$1"

  if ! container_exists "$container_name"; then
    print_result "[FAIL] container not found: ${container_name}"
    hard_fail=1
    return
  fi

  local state
  local health
  state="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || printf 'unknown')"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null || printf 'unknown')"

  if [ "$state" != "running" ]; then
    print_result "[FAIL] ${container_name}: state=${state}"
    hard_fail=1
    return
  fi

  if [ "$health" = "unhealthy" ]; then
    print_result "[FAIL] ${container_name}: health=${health}"
    hard_fail=1
    return
  fi

  if [ "$health" = "starting" ]; then
    print_result "[WARN] ${container_name}: health=${health} (usually right after restart)"
    signal_fail=1
    return
  fi

  print_result "[OK] ${container_name}: state=${state}, health=${health}"
}

check_health_endpoint() {
  local label="$1"
  local url="$2"
  local require_database_ok="$3"
  local body

  if ! body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
    print_result "[FAIL] ${label} health check failed: ${url}"
    hard_fail=1
    return
  fi

  if ! printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    print_result "[FAIL] ${label} health response has no status=ok: ${body}"
    hard_fail=1
    return
  fi

  if [ "$require_database_ok" = "yes" ] && ! printf '%s' "$body" | grep -Eq '"database"[[:space:]]*:[[:space:]]*"ok"'; then
    print_result "[FAIL] ${label} health response has no database=ok: ${body}"
    hard_fail=1
    return
  fi

  print_result "[OK] ${label} health: ${body}"
}

count_matches() {
  local container_name="$1"
  local pattern="$2"
  local count

  count="$(
    docker logs --since "$LOG_WINDOW" "$container_name" 2>&1 \
      | grep -E "$pattern" \
      | wc -l \
      | tr -d ' '
  )"

  printf '%s' "${count:-0}"
}

print_recent_matches() {
  local container_name="$1"
  local pattern="$2"
  docker logs --since "$LOG_WINDOW" "$container_name" 2>&1 | grep -E "$pattern" | tail -n 3
}

scan_signal() {
  local label="$1"
  local container_name="$2"
  local pattern="$3"

  if ! container_exists "$container_name"; then
    print_result "[WARN] ${label}: container ${container_name} not found, skip log scan"
    signal_fail=1
    return
  fi

  local count
  count="$(count_matches "$container_name" "$pattern")"

  if [ "$count" -gt 0 ]; then
    print_result "[WARN] ${label}: ${count} event(s) in last ${LOG_WINDOW}"
    print_recent_matches "$container_name" "$pattern"
    signal_fail=1
  else
    print_result "[OK] ${label}: 0 event(s) in last ${LOG_WINDOW}"
  fi
}

print_section "1) Container state and Docker health"
check_container "$APP_CONTAINER"
check_container "$GATEWAY_CONTAINER"

print_section "2) Health endpoints"
check_health_endpoint "main-app" "$APP_HEALTH_URL" "yes"
check_health_endpoint "ai-gateway" "$GATEWAY_HEALTH_URL" "no"

print_section "3) Log signals (${LOG_WINDOW})"
scan_signal "main-app http 5xx" "$APP_CONTAINER" '"message":"http_request".*"statusCode":5[0-9][0-9]'
scan_signal "main-app crash/fatal" "$APP_CONTAINER" '"message":"uncaught_exception"|"message":"unhandled_rejection"|"message":"request_failed_unhandled_error"|"message":"express_unhandled_error"|"message":"bootstrap_failed"'
scan_signal "ai-gateway failures" "$GATEWAY_CONTAINER" '"message":"analyze_failed_known_error"|"message":"analyze_failed_unhandled_error"|"message":"gateway_auth_failed"|"message":"express_unhandled_error"'
scan_signal "Polza upstream failures" "$GATEWAY_CONTAINER" '"message":"analyze_failed_known_error".*"code":"POLZA_[A-Z_]+"|"message":"analyze_failed_known_error".*"message":"Polza '
scan_signal "Telegram delivery failures" "$APP_CONTAINER" '"message":"telegram_send_failed"|"message":"telegram_send_timeout"|"message":"telegram_send_error"'
scan_signal "DB connectivity failures" "$APP_CONTAINER" '"message":"healthz_failed"|"message":"healthcheck_failed"|"message":"bootstrap_failed"|"ECONNREFUSED"|"ENOTFOUND"|"ETIMEDOUT"'

print_section "4) Final status"
if [ "$hard_fail" -eq 1 ]; then
  print_result "[FAIL] hard failure detected (container or health endpoint)."
  exit 1
fi

if [ "$signal_fail" -eq 1 ]; then
  print_result "[ATTENTION] health is up, but warning signals were found in logs."
  exit 2
fi

print_result "[OK] baseline monitoring checks passed."
exit 0
