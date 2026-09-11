import type { TuiState } from './types.js';

const initialState: TuiState = {
  header: '',
  todos: [],
  logs: [],
  approval: null,
  question: null,
  finalAnswer: null,
  thinking: false,
  activity: null,
  inputMode: 'none',
  sessionItems: [],
  sessionSelected: 0,
  banner: null,
  replInput: '',
  replCursor: 0,
  replPrompt: '❯ ',
  startLine: null,
  recap: null,
};

class TuiStore {
  private state: TuiState = initialState;
  private readonly listeners = new Set<() => void>();

  getState = (): TuiState => this.state;

  setState = (partial: Partial<TuiState>): void => {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const tuiStore = new TuiStore();
