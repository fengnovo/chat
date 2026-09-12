import type { FormEvent } from 'react';

import { Icon } from './icon';

function Composer({
  activity,
  disabled,
  disabledPlaceholder,
  input,
  isBusy,
  onChange,
  onStop,
  onSubmit,
  onSuggestion,
  suggestions,
}: {
  activity: string | null;
  disabled: boolean;
  disabledPlaceholder: string;
  input: string;
  isBusy: boolean;
  onChange: (value: string) => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSuggestion: (suggestion: string) => Promise<void>;
  suggestions: string[];
}) {
  return (
    <div className="composer-wrap">
      {activity && (
        <div className="composer-activity" role="status" aria-live="polite">
          <span className="activity-spinner" aria-hidden="true" />
          <span>{activity}</span>
        </div>
      )}
      {suggestions.length > 0 && !isBusy && !disabled && (
        <div className="suggestions" aria-label="推荐问题">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void onSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="chat-input">
          输入消息
        </label>
        <textarea
          id="chat-input"
          rows={1}
          value={input}
          disabled={disabled || isBusy}
          placeholder={disabled ? disabledPlaceholder : '描述要在项目中完成的任务…'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {isBusy ? (
          <button
            className="send-button is-stop"
            type="button"
            aria-label="停止生成"
            onClick={onStop}
          >
            <Icon name="square" size={17} />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="发送消息"
            disabled={disabled || !input.trim()}
          >
            <Icon name="arrow" size={18} />
          </button>
        )}
      </form>
    </div>
  );
}

export { Composer };
