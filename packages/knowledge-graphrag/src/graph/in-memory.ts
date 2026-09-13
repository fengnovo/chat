import { createHash } from 'node:crypto';
import type { GraphExtraction, GraphLimits, GraphRelation, GraphStore, GraphTraversal } from '../types.js';

export function normalizeEntityKey(name: string): string { return name.trim().toLocaleLowerCase().replace(/\s+/g, ' '); }
function relationId(source: string, type: string, target: string): string { return createHash('sha256').update(`${source}\0${type}\0${target}`).digest('hex').slice(0, 32); }
function validateLimits(limits: GraphLimits): void {
  if (![limits.maxHops, limits.maxFanout, limits.maxRelations].every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)) throw new Error('Invalid graph limit');
}

export class InMemoryGraphStore implements GraphStore {
  private readonly entities = new Map<string, Set<string>>();
  private readonly relations = new Map<string, GraphRelation>();
  private readonly documents = new Map<string, Set<string>>();

  addExtraction(documentId: string, chunkId: string, extraction: GraphExtraction): void {
    for (const entity of extraction.entities) {
      const key = normalizeEntityKey(entity.key ?? entity.name);
      const chunks = this.entities.get(key) ?? new Set<string>(); chunks.add(chunkId); this.entities.set(key, chunks);
    }
    for (const rel of extraction.relationships) {
      const source = normalizeEntityKey(rel.source), target = normalizeEntityKey(rel.target), type = rel.type.trim();
      const id = relationId(source, type, target); const existing = this.relations.get(id);
      if (existing) { if (!existing.sourceChunkIds.includes(chunkId)) existing.sourceChunkIds.push(chunkId); }
      else this.relations.set(id, { id, source, target, type, sourceChunkIds: [chunkId] });
    }
    const docs = this.documents.get(documentId) ?? new Set<string>(); docs.add(chunkId); this.documents.set(documentId, docs);
  }

  entityKeysForChunks(chunkIds: Iterable<string>): Set<string> {
    const wanted = new Set(chunkIds), result = new Set<string>();
    for (const [key, chunks] of this.entities) if ([...chunks].some((id) => wanted.has(id))) result.add(key);
    return result;
  }

  traverse(seedKeys: Iterable<string>, limits: GraphLimits): GraphTraversal {
    validateLimits(limits);
    const seeds = [...new Set([...seedKeys].map(normalizeEntityKey))];
    const seen = new Set(seeds), selected: GraphRelation[] = [], queue = seeds.map((key) => ({ key, hop: 0 }));
    while (queue.length && selected.length < limits.maxRelations) {
      const current = queue.shift()!;
      if (current.hop >= limits.maxHops) continue;
      const adjacent = [...this.relations.values()].filter((r) => r.source === current.key || r.target === current.key).slice(0, limits.maxFanout);
      for (const relation of adjacent) {
        if (selected.length >= limits.maxRelations) break;
        if (!selected.some((r) => r.id === relation.id)) selected.push({ ...relation, sourceChunkIds: [...relation.sourceChunkIds] });
        const next = relation.source === current.key ? relation.target : relation.source;
        if (!seen.has(next)) { seen.add(next); queue.push({ key: next, hop: current.hop + 1 }); }
      }
    }
    return { entityKeys: [...seen], relations: selected, chunkIds: [...new Set(selected.flatMap((r) => r.sourceChunkIds))] };
  }

  removeDocument(documentId: string): void {
    const chunks = this.documents.get(documentId); if (!chunks) return;
    for (const [key, ids] of this.entities) { for (const id of chunks) ids.delete(id); if (!ids.size) this.entities.delete(key); }
    for (const [id, relation] of this.relations) { relation.sourceChunkIds = relation.sourceChunkIds.filter((chunk) => !chunks.has(chunk)); if (!relation.sourceChunkIds.length) this.relations.delete(id); }
    this.documents.delete(documentId);
  }
}
