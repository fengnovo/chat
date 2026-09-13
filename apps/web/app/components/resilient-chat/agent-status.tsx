import { useState } from 'react';

import { Icon } from './icon';
import type { AgentActivityEntry, AgentStatus } from './types';
import { formatDuration, toolCallSummary, toolDetailText } from './utils';

/** 过程区固定高度，超出滚动；避免长任务的旁白把页面撑爆。 */
const BODY_MAX_HEIGHT = 200;
const VISIBLE_ENTRIES = 40;
/** 单条工具输出在面板里的展示上限。 */
const MAX_OUTPUT_CHARS = 1_200;

function ToolEntryBody({ entry }: { entry: Extract<AgentActivityEntry, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const summary = toolCallSummary(entry.tool, entry.input);
  const output = toolDetailText(entry.output).trim();
  const detail = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}…` : output;
  const expandable = Boolean(summary || detail);

  return (
    <div className={`process-tool is-${entry.phase}`}>
      <button
        aria-expanded={open}
        className="process-tool-head"
        disabled={!expandable}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={entry.phase === 'start' ? 'wrench' : 'check'} size={13} />
        <span className="process-tool-name">{entry.tool}</span>
        <span className="process-tool-state">
          {entry.phase === 'start' ? '请求调用' : '完成'}
        </span>
        {expandable && <Icon name="chevron" size={13} />}
      </button>
      {open && expandable && (
        <div className="process-tool-detail">
          {summary && <code className="process-tool-cmd">{summary}</code>}
          {detail && <pre className="process-tool-output">{detail}</pre>}
        </div>
      )}
    </div>
  );
}

function ProcessEntry({ entry }: { entry: AgentActivityEntry }) {
  if (entry.kind === 'narration') {
    return <p className="process-narration">{entry.text}</p>;
  }
  return <ToolEntryBody entry={entry} />;
}

function AgentStatusPanel({
  busy,
  status,
}: {
  busy: boolean;
  status: AgentStatus;
}) {
  const [open, setOpen] = useState(false);
  const visible = status.entries.slice(-VISIBLE_ENTRIES);
  // 只有真的产生了过程记录（工具调用或旁白）才显示，避免一上来就挂个空面板。
  if (visible.length === 0) return null;

  // 有工具调用才算「执行日志」；只有思考旁白时就是「正在思考」。
  const hasToolCalls = status.entries.some((entry) => entry.kind === 'tool');
  const title = busy
    ? status.runningTool
      ? `正在执行 ${status.runningTool}`
      : hasToolCalls
        ? '正在执行'
        : '正在思考'
    : hasToolCalls
      ? '执行日志'
      : '思考过程';

  // 标题栏中间固定展示最新一条日志内容（单行省略）：
  // 工具行与展开列表里的文案保持一致，旁白则直接显示原文。
  const latestEntry = status.entries[status.entries.length - 1];
  let latestLine: string | null = null;
  if (latestEntry) {
    if (latestEntry.kind === 'narration') {
      latestLine = latestEntry.text;
    } else {
      const stateText = latestEntry.phase === 'start' ? '请求调用' : '完成';
      const summary = toolCallSummary(latestEntry.tool, latestEntry.input);
      latestLine = summary
        ? `${latestEntry.tool} ${stateText} · ${summary}`
        : `${latestEntry.tool} ${stateText}`;
    }
  }

  return (
    <section className="agent-process" aria-label="Agent 执行过程">
      <button
        aria-expanded={open}
        className="agent-process-head"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? (
          <span className="activity-spinner" aria-hidden="true" />
        ) : (
          <Icon name={hasToolCalls ? 'wrench' : 'check'} size={15} />
        )}
        <span className="agent-process-title">{title}</span>
        {/* 运行中：中间实时显示最新一条日志；结束后状态字消失，
            用等宽占位把时间/收起始终顶在最右，标题栏不发生跳动 */}
        {busy && latestLine ? (
          <span className="agent-process-live" title={latestLine}>
            {latestLine}
          </span>
        ) : (
          <span className="agent-process-spacer" aria-hidden="true" />
        )}
        {status.elapsedSeconds > 0 && (
          <span className="agent-process-time">· 本轮 {formatDuration(status.elapsedSeconds)}</span>
        )}
        <span className="agent-process-toggle">
          {open ? '收起' : '展开'}
          <Icon name="chevron" size={13} />
        </span>
      </button>
      {open && (
        <div className="agent-process-body" style={{ maxHeight: BODY_MAX_HEIGHT }}>
          {visible.map((entry) => (
            <ProcessEntry entry={entry} key={entry.id} />
          ))}
        </div>
      )}
    </section>
  );
}

export { AgentStatusPanel };
