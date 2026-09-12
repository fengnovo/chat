import { Icon } from './icon';
import { starterPrompts } from './constants';

function Welcome({ onPrompt }: { onPrompt: (prompt: string) => Promise<void> }) {
  return (
    <section className="welcome">
      <div className="welcome-symbol">
        <span className="symbol-ring ring-one" />
        <span className="symbol-ring ring-two" />
        <span className="symbol-core">
          <Icon name="shield" size={31} />
        </span>
      </div>
      <span className="project-context">
        <Icon name="folder" size={14} />
        空白工作区
      </span>
      <h2>让 Agent 创建你的 Web 应用</h2>
      <p>
        每条会话从独立的空白工作区开始，Worker 在隔离沙箱中调用 coding agent。
        执行命令或改文件前，会在这里等待你的审批。
      </p>

      <div className="prompt-grid">
        {starterPrompts.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => void onPrompt(item.prompt)}
          >
            <span className="prompt-icon">
              <Icon name={item.icon} />
            </span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        ))}
      </div>
    </section>
  );
}

export { Welcome };
