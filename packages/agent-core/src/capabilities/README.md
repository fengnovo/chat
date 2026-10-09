# Agent capabilities and attached children

`product-prompt.ts` owns the product instructions. `memory.ts` owns the memory
store mount and explicit remember/forget tools; it never adds the mutable profile
to deepagents' native memory sources. `preview.ts` returns the existing preview
capability URI. Their public compatibility exports remain in `deep-agent.ts`.

The root runtime persists or compares its non-secret descriptor before creating
the graph. The descriptor fingerprints tool schemas, trusted replay policies,
model identity, prompt templates, child limits, and host-provided uploaded resource
hashes. API keys, URL credentials/query tokens, workspace locations, retrieved
memory text, and session auto-approval state are excluded. A host should supply
`durable.runtimeResources` content hashes and `durable.bindRuntimeDescriptor`.
The pure `buildRuntimeStaticDescriptor()` gives host preflight the graph/prompt
identity and installed SDK versions before sandbox acquisition. SDK metadata is
resolved once during normal module loading. Reserved platform/product tool names
are filtered from both shared and per-run MCP discovery, so external bare names
cannot replace trusted handlers or inherit their replay policy; `graphrag_search`
keeps its current name.

Background children are attached to the parent Run. An acknowledgement means the
intent is persisted and registered in that execution pass; it does not detach
work into another Run. Three children can run at once, and queued children count
as unfinished. Each attempt has at most 100 model calls, 200 graph steps, ten
minutes of wall time, and a 2,000-character summary. Review takes at most one
minute across structured-output fallbacks; remediation has at most five attempts.
The defaults are 50 model calls and three attempts. Environment overrides are
validated and clamped.

Normal parent completion waits for background results and commits result messages
with stable child IDs before continuing. The root permits at most two background
follow-up rounds. If the final round dispatches more children, local execution is
stopped and the parent's terminal repository transaction cancels unfinished
children. Parent failure and user cancellation also cancel live child records and
waiting interrupts in that transaction. `cancelled` is terminal: spawn replay,
approval response, and rehydration cannot restart it.

An approval pause, ownership loss, or graceful Worker shutdown only aborts local
promises. `abortAll()` waits at most three seconds and does not write a durable
cancellation. An aborted pass cannot persist a child attempt as completed, even
if a handler returns after observing abort. Live intent stays recoverable; the next
owner rehydrates the saved child identity and resumes the same attempt checkpoint.
Completed attempt output is saved before review and reused after a review crash.
Waiting approvals remain checkpoint-addressed, and retry approvals retain the
execution ID and retry count. Framework recovery reads/invocations/streams cross
the validated boundary in `adapters/langgraph.ts`.
