import { Icon } from './icon';
import type { AgentStatus } from './types';
import { formatDuration } from './utils';

const VISIBLE_ENTRIES = 6;

function AgentStatusPanel({
  busy,
  status,
}: {
  busy: boolean;
  status: AgentStatus;
}) {
  const visible = status.entries.slice(-VISIBLE_ENTRIES);
  if (visible.length === 0 && !busy) return null;

  const headline = busy
    ? status.runningTool
      ? `正在执行 ${status.runningTool}`
      : '正在思考下一步'
    : '本轮运行已结束';

  return (
    <section className="agent-status" aria-label="Agent 当前活动">
      <div className="agent-status-head">
        <span className="agent-status-title">
          <Icon name="wrench" size={14} />
          执行日志
        </span>
      </div>
      {visible.length > 0 && (
        <ol className="agent-status-log">
          {visible.map((entry) => (
            <li className={`is-${entry.phase}`} key={entry.id}>
              <Icon name={entry.phase === 'start' ? 'wrench' : 'check'} size={13} />
              <span>
                {entry.phase === 'start'
                  ? `请求调用 ${entry.tool}`
                  : `${entry.tool} 完成`}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="agent-status-now" role="status" aria-live="polite">
        {busy ? (
          <span className="activity-spinner" aria-hidden="true" />
        ) : (
          <span className="status-dot" aria-hidden="true" />
        )}
        {headline}
        {status.elapsedSeconds > 0 && (
          <> · 本轮 {formatDuration(status.elapsedSeconds)}</>
        )}
        {busy && status.idleSeconds > 0 && (
          <> · 最近活动 {status.idleSeconds}秒前</>
        )}
      </p>
    </section>
  );
}

export { AgentStatusPanel };
