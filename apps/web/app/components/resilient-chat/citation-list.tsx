import type { Citation } from './types';

export function CitationList({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return <section className="citation-list" aria-label="引用来源"><h4>引用来源</h4><ul>{citations.map((citation) => <li key={citation.chunkId}><strong>{citation.documentName}</strong><span>#{citation.ordinal}{citation.heading ? ` · ${citation.heading}` : ''}</span><span>score {citation.score.toFixed(2)} · via {citation.via}</span></li>)}</ul></section>;
}
