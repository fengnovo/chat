import { tuiStore } from './store.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  SessionPickerItem,
  UserQuestionAnswer,
  UserQuestionRequest,
} from './types.js';

let pendingApprovalResolver: ((decision: ApprovalDecision) => void) | null = null;
let pendingQuestionResolver: ((answer: UserQuestionAnswer) => void) | null = null;
let pendingSessionResolver: ((index: number) => void) | null = null;
let pendingReplResolver: ((text: string) => void) | null = null;

/** 显示审批菜单，等待用户决定。 */
export function askApproval(requests: ApprovalRequest[]): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    pendingApprovalResolver = resolve;
    tuiStore.setState({
      inputMode: 'approval',
      approval: { requests, selected: 0 },
    });
  });
}

/** 显示模型主动发起的单选、多选或自定义问题，等待用户回答。 */
export function askUserQuestion(request: UserQuestionRequest): Promise<UserQuestionAnswer> {
  return new Promise((resolve) => {
    pendingQuestionResolver = resolve;
    tuiStore.setState({
      inputMode: 'question',
      thinking: false,
      approval: null,
      question: {
        request,
        highlighted: 0,
        selectedIndices: [],
        customInput: '',
        customCursor: 0,
        editingCustom: false,
        error: null,
      },
    });
  });
}

/** 显示会话选择器，等待用户选择。 */
export function pickSession(items: SessionPickerItem[]): Promise<number> {
  return new Promise((resolve) => {
    pendingSessionResolver = resolve;
    tuiStore.setState({
      inputMode: 'session',
      sessionItems: items,
      sessionSelected: 0,
    });
  });
}

/** 进入 REPL 输入模式，等待用户提交一行文本。 */
export function askReplInput(): Promise<string> {
  return new Promise((resolve) => {
    pendingReplResolver = resolve;
    tuiStore.setState({
      inputMode: 'repl',
      replInput: '',
      replCursor: 0,
      thinking: false,
    });
  });
}

export function resolveApproval(decision: ApprovalDecision): void {
  tuiStore.setState({ approval: null });
  const resolve = pendingApprovalResolver;
  pendingApprovalResolver = null;
  resolve?.(decision);
}

export function resolveUserQuestion(answer: UserQuestionAnswer): void {
  tuiStore.setState({ question: null, inputMode: 'none' });
  const resolve = pendingQuestionResolver;
  pendingQuestionResolver = null;
  resolve?.(answer);
}

export function resolveSession(index: number): void {
  tuiStore.setState({ inputMode: 'none', sessionItems: [], sessionSelected: 0 });
  const resolve = pendingSessionResolver;
  pendingSessionResolver = null;
  resolve?.(index);
}

export function resolveReplInput(text: string): void {
  const resolve = pendingReplResolver;
  pendingReplResolver = null;
  resolve?.(text);
}
