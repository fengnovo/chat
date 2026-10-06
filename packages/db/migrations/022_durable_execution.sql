ALTER TABLE agent_runs
  ADD COLUMN execution_state text NOT NULL DEFAULT 'pending'
    CHECK (execution_state IN ('pending', 'running', 'recovering', 'waiting', 'terminal')),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN worker_id text,
  ADD COLUMN execution_input jsonb,
  ADD COLUMN checkpoint_id text,
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;

UPDATE agent_runs SET execution_state = CASE
  WHEN status IN ('completed', 'failed', 'cancelled') THEN 'terminal'
  WHEN status IN ('waiting_approval', 'waiting_question') THEN 'waiting'
  WHEN status = 'running' THEN 'running'
  ELSE 'pending' END;

CREATE INDEX agent_runs_execution_recovery_idx ON agent_runs (lease_expires_at, updated_at)
  WHERE execution_state IN ('running', 'recovering');

ALTER TABLE run_dispatch_outbox DROP CONSTRAINT run_dispatch_outbox_job_kind_check;
ALTER TABLE run_dispatch_outbox ADD CONSTRAINT run_dispatch_outbox_job_kind_check
  CHECK (job_kind IN ('start', 'resume-approval', 'resume-question', 'recover'));

ALTER TABLE run_events ADD COLUMN event_key text;
CREATE UNIQUE INDEX run_events_identity_idx ON run_events (run_id, event_key)
  WHERE event_key IS NOT NULL;

CREATE TABLE tool_executions (
  execution_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  scope_id text NOT NULL,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  replay_policy text NOT NULL CHECK (replay_policy IN ('safe', 'unsafe')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'succeeded', 'uncertain')),
  result jsonb,
  lease_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, scope_id, tool_call_id)
);

CREATE TABLE child_executions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  root_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  parent_tool_call_id text NOT NULL,
  thread_id text NOT NULL UNIQUE,
  input jsonb NOT NULL,
  background boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting','completed','failed')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  feedback text,
  attempt_result jsonb,
  summary text,
  review jsonb,
  lease_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_run_id, parent_tool_call_id)
);
CREATE INDEX child_executions_background_idx ON child_executions (root_run_id, created_at) WHERE background;
