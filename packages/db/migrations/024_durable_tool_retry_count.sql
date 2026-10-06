ALTER TABLE tool_executions
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0
  CHECK (retry_count >= 0);
