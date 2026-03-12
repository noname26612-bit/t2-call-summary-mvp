CREATE TABLE IF NOT EXISTS call_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  phone_raw TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  call_datetime_raw TEXT NOT NULL,
  call_datetime_utc TIMESTAMPTZ,
  transcript_hash CHAR(64) NOT NULL,
  transcript_preview TEXT NOT NULL,
  transcript_length INTEGER NOT NULL,
  dedup_key CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'ignored', 'duplicate', 'processed', 'failed')),
  reason TEXT,
  telegram_status TEXT CHECK (telegram_status IN ('sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_created_at ON call_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_events_dedup_key ON call_events (dedup_key);
CREATE INDEX IF NOT EXISTS idx_call_events_phone_normalized ON call_events (phone_normalized);

CREATE TABLE IF NOT EXISTS processed_calls (
  id BIGSERIAL PRIMARY KEY,
  dedup_key CHAR(64) NOT NULL UNIQUE,
  call_event_id BIGINT REFERENCES call_events(id) ON DELETE SET NULL,
  phone_normalized TEXT NOT NULL,
  call_datetime_raw TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_calls_status ON processed_calls (status);

CREATE TABLE IF NOT EXISTS ignore_list (
  id BIGSERIAL PRIMARY KEY,
  phone_normalized TEXT NOT NULL UNIQUE,
  label TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ignore_list_active ON ignore_list (is_active);

CREATE TABLE IF NOT EXISTS summaries (
  id BIGSERIAL PRIMARY KEY,
  call_event_id BIGINT NOT NULL UNIQUE REFERENCES call_events(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL,
  next_step TEXT NOT NULL,
  urgency TEXT NOT NULL,
  tags JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  call_event_id BIGINT REFERENCES call_events(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_call_event_id ON audit_events (call_event_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  id BIGSERIAL PRIMARY KEY,
  call_event_id BIGINT NOT NULL REFERENCES call_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_call_event_id ON telegram_deliveries (call_event_id);
