ALTER TABLE agent_runs ADD COLUMN legacy_execution boolean NOT NULL DEFAULT false;

-- Executions already active before the protocol have no fenced ownership or tool
-- ledger. Replaying their original input cannot safely reconstruct past effects.
UPDATE agent_runs SET legacy_execution = true
WHERE status = 'running'
  AND lease_epoch = 0 AND execution_input IS NULL;
