CREATE TABLE IF NOT EXISTS tele2_polled_records (
  id BIGSERIAL PRIMARY KEY,
  record_file_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'processed', 'duplicate', 'ignored', 'skipped', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 1,
  phone_raw TEXT,
  call_datetime_raw TEXT,
  transcript_length INTEGER,
  last_process_status TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tele2_polled_records_status
  ON tele2_polled_records (status);

CREATE INDEX IF NOT EXISTS idx_tele2_polled_records_updated_at
  ON tele2_polled_records (updated_at DESC);
