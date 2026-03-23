CREATE TABLE IF NOT EXISTS ai_usage_audit (
  id BIGSERIAL PRIMARY KEY,
  x_request_id TEXT,
  call_event_id BIGINT REFERENCES call_events(id) ON DELETE SET NULL,
  call_id TEXT,
  operation TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  transcript_chars_raw INTEGER,
  transcript_chars_sent INTEGER,
  duration_ms INTEGER,
  response_status TEXT NOT NULL CHECK (response_status IN ('success', 'failed', 'skipped')),
  skip_reason TEXT,
  estimated_cost_rub NUMERIC(14, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_audit_created_at ON ai_usage_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_audit_call_event_id ON ai_usage_audit (call_event_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_audit_x_request_id ON ai_usage_audit (x_request_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_audit_response_status ON ai_usage_audit (response_status);
