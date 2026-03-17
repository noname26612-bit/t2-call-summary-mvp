CREATE TABLE IF NOT EXISTS employee_phone_directory (
  id BIGSERIAL PRIMARY KEY,
  phone_normalized TEXT NOT NULL UNIQUE,
  employee_name TEXT NOT NULL,
  employee_title TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_phone_directory_active
  ON employee_phone_directory (is_active);

ALTER TABLE summaries
  ADD COLUMN IF NOT EXISTS transcript_plain TEXT,
  ADD COLUMN IF NOT EXISTS reconstructed_turns JSONB,
  ADD COLUMN IF NOT EXISTS participants_assumption TEXT,
  ADD COLUMN IF NOT EXISTS detected_client_speaker TEXT,
  ADD COLUMN IF NOT EXISTS detected_employee_speaker TEXT,
  ADD COLUMN IF NOT EXISTS speaker_role_confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS client_goal TEXT,
  ADD COLUMN IF NOT EXISTS employee_response TEXT,
  ADD COLUMN IF NOT EXISTS issue_reason TEXT,
  ADD COLUMN IF NOT EXISTS outcome_structured TEXT,
  ADD COLUMN IF NOT EXISTS next_step_structured TEXT,
  ADD COLUMN IF NOT EXISTS analysis_warnings JSONB;
