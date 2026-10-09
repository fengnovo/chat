import type { AgentEvent } from './index.js';

export interface RunMessageProjection {
  text: string;
  reasoning: string;
  citations: Extract<AgentEvent, { type: 'retrieval.completed' }>['citations'];
  lastSeq: number;
}

export function emptyMessageProjection(): RunMessageProjection {
  return { text: '', reasoning: '', citations: [], lastSeq: 0 };
}

export function applyMessageEvent(projection: RunMessageProjection, event: AgentEvent & { seq?: number }): RunMessageProjection {
  if (event.seq !== undefined && event.seq <= projection.lastSeq) return projection;
  const next = { ...projection, lastSeq: event.seq ?? projection.lastSeq };
  switch (event.type) {
    case 'assistant.delta': return { ...next, text: projection.text + event.text };
    case 'assistant.snapshot': return { ...next, text: event.text };
    case 'assistant.reasoning': return { ...next, reasoning: projection.reasoning + event.text };
    case 'retrieval.completed': return { ...next, citations: [...projection.citations, ...event.citations] };
    default: return next;
  }
}
