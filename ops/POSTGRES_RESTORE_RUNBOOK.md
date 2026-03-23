# Self-hosted PostgreSQL restore runbook

This runbook is for restoring `ats_call_summary` from backups created by
`scripts/backupSelfHostedPostgres.sh`.

## 1. Preconditions

- SSH access to production VM
- Docker access (`docker ps` works)
- Backup file exists in `/opt/t2-call-summary/backups/self_hosted`
- Main app maintenance window accepted

## 2. Stop write traffic

```bash
sudo systemctl stop t2-tele2-poll.timer
docker stop t2-call-summary
```

## 3. Pick backup file

```bash
ls -lh /opt/t2-call-summary/backups/self_hosted | tail -n 20
export RESTORE_DUMP="/opt/t2-call-summary/backups/self_hosted/self_hosted_ats_call_summary_<timestamp>.dump"
```

## 4. Restore into self-hosted postgres

```bash
export DB_NAME="ats_call_summary"
export DB_USER="app_user"

docker exec -i t2-postgres psql -U "${DB_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";"

docker exec -i t2-postgres psql -U "${DB_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";"

docker exec -i t2-postgres pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  -U "${DB_USER}" \
  -d "${DB_NAME}" < "${RESTORE_DUMP}"
```

## 5. Sanity checks

```bash
docker exec -i t2-postgres psql -U app_user -d ats_call_summary -Atc \
  "select count(*) from schema_migrations;"

docker exec -i t2-call-summary npm run -s migrate
```

## 6. Start services back

```bash
docker start t2-call-summary
curl -fsS http://127.0.0.1:3000/healthz
sudo systemctl start t2-tele2-poll.timer
```

## 7. Rollback to managed DB (if needed)

1. Restore old `/opt/t2-call-summary/main.env` backup (managed `DB_HOST`/`DB_PORT`)
2. Restart `t2-call-summary`
3. Verify `/healthz`
4. Keep self-hosted dump for postmortem
