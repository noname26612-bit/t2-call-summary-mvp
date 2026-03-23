#!/usr/bin/env bash
set -euo pipefail

MAIN_ENV_FILE="${T2_MAIN_ENV_FILE:-/opt/t2-call-summary/main.env}"
BACKUP_DIR="${T2_PG_BACKUP_DIR:-/opt/t2-call-summary/backups/self_hosted}"
RETENTION_DAYS="${T2_PG_BACKUP_RETENTION_DAYS:-14}"
POSTGRES_DOCKER_IMAGE="${T2_PG_BACKUP_IMAGE:-postgres:17-alpine}"
POSTGRES_DOCKER_NETWORK="${T2_PG_BACKUP_NETWORK:-t2-app-net}"
POSTGRES_HOST_OVERRIDE="${T2_PG_BACKUP_HOST:-}"
POSTGRES_PORT_OVERRIDE="${T2_PG_BACKUP_PORT:-}"

timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if [ ! -f "$MAIN_ENV_FILE" ]; then
  log "ERROR main env file not found: $MAIN_ENV_FILE"
  exit 1
fi

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$MAIN_ENV_FILE" | tail -n 1
}

DB_HOST="${POSTGRES_HOST_OVERRIDE:-$(get_env_value DB_HOST)}"
DB_PORT="${POSTGRES_PORT_OVERRIDE:-$(get_env_value DB_PORT)}"
DB_NAME="$(get_env_value DB_NAME)"
DB_USER="$(get_env_value DB_USER)"
DB_PASSWORD="$(get_env_value DB_PASSWORD)"

if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
  log 'ERROR database variables are incomplete in main env'
  exit 1
fi

mkdir -p "$BACKUP_DIR"

FILE_BASENAME="self_hosted_${DB_NAME}_$(timestamp).dump"
FILE_PATH="${BACKUP_DIR}/${FILE_BASENAME}"

log "Starting PostgreSQL backup to ${FILE_PATH}"

export PGPASSWORD="$DB_PASSWORD"

docker run --rm \
  --network "$POSTGRES_DOCKER_NETWORK" \
  -e PGPASSWORD \
  -v "${BACKUP_DIR}:/backups" \
  "$POSTGRES_DOCKER_IMAGE" \
  pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -F c \
    -f "/backups/${FILE_BASENAME}"

if [ ! -s "$FILE_PATH" ]; then
  log "ERROR backup file is missing or empty: ${FILE_PATH}"
  exit 1
fi

log "Backup completed: ${FILE_PATH} ($(du -h "$FILE_PATH" | awk '{print $1}'))"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  DELETED_COUNT="$(
    find "$BACKUP_DIR" -type f -name 'self_hosted_*.dump' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' '
  )"
  log "Retention cleanup finished: deleted ${DELETED_COUNT} file(s) older than ${RETENTION_DAYS} day(s)"
else
  log "Retention cleanup skipped: invalid RETENTION_DAYS=${RETENTION_DAYS}"
fi

LATEST_COUNT="$(find "$BACKUP_DIR" -type f -name 'self_hosted_*.dump' | wc -l | tr -d ' ')"
log "Backup inventory: ${LATEST_COUNT} file(s) currently stored"
