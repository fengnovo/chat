ALTER TABLE agent_runs
  ADD COLUMN request_fingerprint text,
  ADD COLUMN execution_descriptor jsonb;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_tenant_id_idempotency_key_key;
DROP INDEX IF EXISTS agent_runs_tenant_idempotency_idx;
CREATE UNIQUE INDEX agent_runs_scoped_idempotency_idx
  ON agent_runs (tenant_id, user_id, session_id, idempotency_key);

ALTER TABLE child_executions DROP CONSTRAINT child_executions_status_check;
ALTER TABLE child_executions ADD CONSTRAINT child_executions_status_check
  CHECK (status IN ('pending','running','waiting','completed','failed','cancelled'));

-- 终态转换负责维护这些不变量，包括没有 Worker 租约时的取消和旧版状态更新路径。
-- 所有变更都会一并回滚。
CREATE OR REPLACE FUNCTION apply_run_terminal_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed','failed','cancelled') THEN
    NEW.execution_state := 'terminal';
    NEW.finished_at := COALESCE(NEW.finished_at, clock_timestamp());
  END IF;
  IF NEW.status IN ('completed','failed','cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'completed' THEN
      INSERT INTO memory_jobs (id, tenant_id, user_id, session_id, run_id)
      VALUES (gen_random_uuid(), NEW.tenant_id, NEW.user_id, NEW.session_id, NEW.id)
      ON CONFLICT (tenant_id, run_id) DO NOTHING;
    END IF;
    UPDATE child_executions SET status='cancelled', updated_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND root_run_id=NEW.id
        AND status IN ('pending','running','waiting');
    UPDATE interrupts SET status='cancelled', resolved_at=clock_timestamp()
      WHERE tenant_id=NEW.tenant_id AND run_id=NEW.id AND status='pending';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_terminal_contract BEFORE UPDATE OF status ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION apply_run_terminal_contract();

-- 修复已提交完成状态、但 Redis 入队事件丢失的记录。
INSERT INTO memory_jobs (id, tenant_id, user_id, session_id, run_id)
SELECT gen_random_uuid(), tenant_id, user_id, session_id, id FROM agent_runs WHERE status='completed'
ON CONFLICT (tenant_id, run_id) DO NOTHING;
UPDATE agent_runs SET execution_state='terminal' WHERE status IN ('completed','failed','cancelled');
UPDATE child_executions child SET status='cancelled', updated_at=clock_timestamp()
FROM agent_runs run WHERE run.id=child.root_run_id AND run.tenant_id=child.tenant_id
  AND run.status IN ('completed','failed','cancelled') AND child.status IN ('pending','running','waiting');
