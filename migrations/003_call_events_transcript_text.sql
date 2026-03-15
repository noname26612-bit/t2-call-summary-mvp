ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS transcript_text TEXT;
