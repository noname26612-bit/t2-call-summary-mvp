CREATE TABLE IF NOT EXISTS telegram_update_offsets (
  bot_key TEXT PRIMARY KEY,
  last_update_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
