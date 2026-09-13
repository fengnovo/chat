# Task 2 report: Pure GraphRAG package

## Status

Implemented `@repo/knowledge-graphrag` as a side-effect-free pure algorithm package. No Postgres, Qdrant, service, API, worker, or web code was added.

## Delivered

- Strict UTF-8 text/Markdown parser with binary/NUL rejection and Markdown heading extraction.
- Bounded character chunker with validated size/overlap, heading paths, and deterministic UUID-shaped SHA-256 chunk IDs.
- In-memory `GraphStore` with normalized entity keys, duplicate relation source merging, document removal, bidirectional BFS, and max-hop/fan-out/relation bounds.
- Candidate merge that de-duplicates by `chunkId`, annotates vector/graph provenance, and only includes source chunks from selected graph relations.
- Public types and `Embedder`/`EmbeddingProfile` interfaces for later storage/index adapters.
- Seven focused tests covering parser rejection, heading retention, overlap, stable IDs, three-hop traversal, duplicate provenance, traversal bounds, and candidate merge.

## Verification

- `pnpm --filter @repo/knowledge-graphrag test`: 7 passed.
- `pnpm --filter @repo/knowledge-graphrag typecheck`: passed.
- `pnpm --filter @repo/knowledge-graphrag build`: passed.
- `git diff --check`: passed.

## Fix round 1 TDD evidence

- Red: the newly added regression suite failed in five targeted cases (heading-boundary metadata, provenance union, invalid graph limits, invalid candidate limit, and runtime MIME validation).
- Green: after minimal fixes, `pnpm --filter @repo/knowledge-graphrag test` reports 13 passed; package typecheck and build also pass.
- Added independent hop, fan-out, and relation-cap assertions, plus invalid-limit rejection coverage.

## Concerns / follow-up

- Chunking is character-based and intentionally minimal; later index-pipeline work can add token-aware policies without changing the pure API.
- Graph relation IDs are deterministic SHA-256-derived IDs and relation traversal is in-memory only; the persistence adapter should preserve the same normalized keys and provenance semantics.
- Heading state is derived from complete source-line offsets, so chunks beginning inside a heading never receive fabricated prefix paths.

## Fix round 2 TDD evidence

- Red: the CRLF heading-boundary regression failed because line offsets advanced by one character, attaching a later heading to an incomplete chunk.
- Green: regex-derived original line offsets fixed CRLF handling; the complete package suite reports 14 passed, with typecheck and build passing.
- Expanded malformed-limit tests independently cover negative, fractional, and infinite values for `maxHops`, `maxFanout`, `maxRelations`, and `maxCandidates`.
