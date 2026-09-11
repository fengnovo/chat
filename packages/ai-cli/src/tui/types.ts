export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface ApprovalRequest {
  name: string;
  summary: string;
}

export type ApprovalDecision = 'approve' | 'reject' | 'approve-all';

export interface SessionPickerItem {
  title: string;
  subtitle: string;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestionRequest {
  kind: 'ask_user';
  question: string;
  options: UserQuestionOption[];
  multiple: boolean;
  allowCustom: boolean;
}

export interface UserQuestionSelection {
  index: number;
  label: string;
}

export interface UserQuestionAnswer {
  selections: UserQuestionSelection[];
  customText?: string;
}

export interface ReplBuffer {
  value: string;
  /** UTF-16 offset，始终位于一个完整字素的边界。 */
  cursor: number;
}

export interface ReplKey {
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export type InputMode = 'repl' | 'approval' | 'question' | 'session' | 'none';

export interface ApprovalState {
  requests: ApprovalRequest[];
  selected: number;
}

export interface Recap {
  human: string;
  ai: string;
}

export interface Banner {
  mode: string;
  cwd: string;
  skills: string;
  mcp: string;
  langsmith: string;
  memory: string;
}

export interface AgentActivity {
  label: string;
  receivedChars: number;
  updatedAt: number;
}

export interface ThinkingIndicatorProps {
  activity: AgentActivity | null;
}

export interface UserQuestionState {
  request: UserQuestionRequest;
  highlighted: number;
  selectedIndices: number[];
  customInput: string;
  customCursor: number;
  editingCustom: boolean;
  error: string | null;
}

export interface TuiState {
  header: string;
  todos: Todo[];
  logs: string[];
  approval: ApprovalState | null;
  question: UserQuestionState | null;
  finalAnswer: string | null;
  thinking: boolean;
  activity: AgentActivity | null;
  inputMode: InputMode;
  sessionItems: SessionPickerItem[];
  sessionSelected: number;
  banner: Banner | null;
  replInput: string;
  replCursor: number;
  replPrompt: string;
  startLine: string | null;
  recap: Recap | null;
}

export interface NavigationKey {
  ctrl: boolean;
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
}

export interface ReplInputKey extends ReplKey {
  ctrl: boolean;
  meta: boolean;
  return: boolean;
  backspace: boolean;
  delete: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  upArrow: boolean;
  downArrow: boolean;
}

export interface QuestionInputKey extends ReplInputKey {
  escape: boolean;
}

export interface SessionPickerProps {
  items: SessionPickerItem[];
  onPick: (index: number) => void;
}

export interface ApprovalMenuProps {
  requests: ApprovalRequest[];
  selected: number;
  onDecide: (decision: ApprovalDecision) => void;
}

export interface UserQuestionMenuProps {
  onAnswer: (answer: UserQuestionAnswer) => void;
}

export interface ReplInputProps {
  onSubmit: (text: string) => void;
}

export interface IdleInputKey {
  ctrl: boolean;
}

export interface TodoListProps {
  todos: Todo[];
}

export interface LogListProps {
  logs: string[];
}

export interface ReplCursorView {
  before: string;
  cursorText: string;
  after: string;
}
