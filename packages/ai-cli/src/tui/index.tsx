import { render as inkRender } from 'ink';
import React from 'react';

import { App } from './app.js';

export { A } from './constants.js';
export {
  tuiEnterRepl,
  tuiEnterTask,
  tuiFinish,
  tuiLog,
  tuiResetTask,
  tuiSetActivity,
  tuiSetHeader,
  tuiSetThinking,
  tuiSetTodos,
  tuiShowBanner,
  tuiShowRecap,
  tuiShowStartLine,
} from './actions.js';
export { askApproval, askReplInput, askUserQuestion, pickSession } from './bridge.js';
export { buildUserQuestionAnswer, toggleQuestionSelection } from './question.js';
export { editReplBuffer, splitReplCursor } from './repl-input.js';
export { tuiStore } from './store.js';
export type * from './types.js';

let inkInstance: ReturnType<typeof inkRender> | null = null;

export function startTui(): void {
  if (inkInstance) return;
  inkInstance = inkRender(<App />);
}

export function stopTui(): void {
  if (!inkInstance) return;
  inkInstance.unmount();
  inkInstance = null;
}
