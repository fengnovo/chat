# Production hardening design

The user authorized implementation of all eight findings in `docs/项目优化.md` and the preceding review. Keep PostgreSQL, BullMQ, LangGraph, the fenced execution lease, and existing clients. Work in the current checkout and preserve the user's untracked review document. No deployment or external messages are part of this change.

## Access boundaries

Preview and rebuild must authorize the current user against the requested session, accepting internal IDs and external keys. Static preview files must not traverse directories or symlinks. Origin/Referer are not authorization. Native clients opening previews may obtain a short-lived preview capability after authenticating; resources can reuse a session-scoped preview cookie. Such a capability must not authorize other API routes. Idempotency identities are tenant/user/session scoped, include a canonical hash of the complete request, serialize concurrent submissions, and reject reused keys with different payloads.

## Durable execution

Run completion atomically creates the memory extraction job intent. A memory consumer polls the database as the source of truth; Redis remains a wake-up hint. Business terminal states cancel live children and waiting interrupts consistently. Expose an authorized task view with ownership, attempt, status, and waiting reason. Background children remain attached to the parent Run; detached cross-Run execution is not introduced.

Persist a non-secret execution descriptor before runtime side effects: runtime/graph version, effective model configuration, tool policies and schema hashes, prompt/skills/MCP resource hashes. Existing descriptors must match before continuation. Reject incompatible recovery explicitly with a useful failure code; preserve successful tool results. Credentials are excluded from descriptors. Existing pre-descriptor checkpoints are conservatively refused when recovery cannot establish compatibility.

Unsafe uncertain tool outcomes require their own approval even when ordinary tools are session-approved. Do not infer replay safety from third-party annotations. Automatic replay requires stored and current trusted policies to be safe; an idempotency argument alone does not prove the external service deduplicates. Explicit retry approvals remain bound to execution ID and retry count.

## Resource bounds and architecture

History uses a durable, rebuildable per-Run message projection, keyset pagination, and bounded pages. Historical projections derive text with snapshot replacement, reasoning, and citations. Preserve response compatibility and add pagination metadata. Update clients to load older pages. Replay reads are paginated rather than capped at a large one-shot limit. SSE writes await drain, have a finite timeout, and clean up on disconnect. Coalesce consecutive text events within a bounded byte/time window; flush before barriers, interrupts, and terminal events, always persist before notifying.

Extract business tools and prompt construction from the Agent runtime, centralize framework recovery adapters and shared event projections, and retain compatibility exports. Keep dependency patches documented and covered by behavior tests. Add operational documentation for recovery/version refusal and task state.

## Verification

Regression tests must exercise actual routes, repositories, middleware, streams, and temporary files. Run unit tests and typecheck for changed packages. CI starts isolated PostgreSQL and Redis services and runs database, fenced-checkpoint, and SIGKILL recovery suites without skipping them. The integration runner refuses non-test database names. Local integration execution uses dedicated temporary infrastructure where available. Report environmental limitations honestly.
