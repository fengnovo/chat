import { tuiStore } from './store.js';
import type { AgentActivity, Banner, Recap, Todo } from './types.js';

export function tuiSetHeader(header: string): void {
  tuiStore.setState({ header });
}

export function tuiSetTodos(todos: Todo[]): void {
  tuiStore.setState({ todos });
}

export function tuiLog(line: string): void {
  const logs = [...tuiStore.getState().logs, line];
  if (logs.length > 50) logs.splice(0, logs.length - 50);
  tuiStore.setState({ logs });
}

export function tuiFinish(answer: string): void {
  tuiStore.setState({ thinking: false, activity: null, finalAnswer: answer });
}

export function tuiSetThinking(on: boolean): void {
  tuiStore.setState({
    thinking: on,
    activity: on
      ? { label: '等待模型响应', receivedChars: 0, updatedAt: Date.now() }
      : null,
  });
}

export function tuiSetActivity(activity: AgentActivity): void {
  tuiStore.setState({ thinking: true, activity });
}

export function tuiResetTask(): void {
  tuiStore.setState({
    todos: [],
    finalAnswer: null,
    thinking: false,
    activity: null,
    logs: [],
    approval: null,
    question: null,
  });
}

export function tuiShowBanner(banner: Banner | null): void {
  tuiStore.setState({ banner });
}

export function tuiShowStartLine(startLine: string | null): void {
  tuiStore.setState({ startLine });
}

export function tuiShowRecap(recap: Recap | null): void {
  tuiStore.setState({ recap });
}

export function tuiEnterRepl(): void {
  tuiStore.setState({
    inputMode: 'repl',
    replInput: '',
    replCursor: 0,
    thinking: false,
    activity: null,
  });
}

export function tuiEnterTask(): void {
  tuiStore.setState({ inputMode: 'none' });
}
