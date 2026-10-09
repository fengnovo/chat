ALTER TABLE agent_runs ADD COLUMN legacy_execution boolean NOT NULL DEFAULT false;

-- 在此协议启用前已处于活动状态的执行，没有所有权栅栏或工具流水记录。
-- 重放其原始输入无法安全地还原先前产生的副作用。
UPDATE agent_runs SET legacy_execution = true
WHERE status = 'running'
  AND lease_epoch = 0 AND execution_input IS NULL;
