import { Icon } from './icon';
import type { PipelineEvent } from './types';

function TracePanel({
  inactive,
  open,
  onClose,
  trace,
}: {
  inactive: boolean;
  open: boolean;
  onClose: () => void;
  trace: PipelineEvent[];
}) {
  return (
    <>
      {open && !inactive && (
        <button
          className="trace-scrim"
          type="button"
          aria-label="关闭可靠性轨迹"
          onClick={onClose}
        />
      )}
      <aside
        aria-hidden={!open}
        className={`trace-panel ${open ? 'is-open' : ''}`}
        inert={!open || inactive}
      >
        <div className="trace-head">
          <div>
            <span className="eyebrow">LIVE OBSERVABILITY</span>
            <h2>Agent 运行轨迹</h2>
          </div>
          <button
            className="icon-button trace-close-button"
            type="button"
            aria-label="关闭可靠性轨迹"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="trace-summary">
          <div>
            <span>事件流</span>
            <strong>DURABLE SSE</strong>
          </div>
          <div>
            <span>任务执行</span>
            <strong>QUEUED</strong>
          </div>
        </div>

        <ol className="trace-list">
          {trace.map((item, index) => (
            <li className={`trace-item is-${item.status}`} key={item.id}>
              <div className="trace-line">
                <span className="trace-node">
                  {item.status === 'success' ? (
                    <Icon name="check" size={12} />
                  ) : item.status === 'error' || item.status === 'warning' ? (
                    <Icon name="triangle" size={12} />
                  ) : (
                    <span className="pulse-dot" />
                  )}
                </span>
                {index < trace.length - 1 && <span className="trace-rail" />}
              </div>
              <div>
                <div className="trace-title">
                  <strong>{item.title}</strong>
                  <time>{item.timestamp}</time>
                </div>
                <p>{item.detail}</p>
                <code>{item.stage.toUpperCase()}</code>
              </div>
            </li>
          ))}
        </ol>

        <div className="model-chain">
          <span className="nav-label">模型降级链</span>
          {['primary model', 'fallback 1', 'fallback 2', 'fallback 3'].map(
            (model, index) => (
              <div key={model}>
                <span>{index + 1}</span>
                <code>{model}</code>
                {index === 0 && <small>PRIMARY</small>}
              </div>
            ),
          )}
        </div>
      </aside>
    </>
  );
}

export { TracePanel };
