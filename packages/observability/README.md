# @repo/observability

Server-only OpenTelemetry runtime for Node.js 22 and later. Import this package only
from API, worker, or other Node server entrypoints. The package exposes a Node
entrypoint and explicitly rejects the `browser` export condition; there is no
browser or client entrypoint. It uses Node crypto and async context APIs.

`loadObservabilityConfig` rejects `OBSERVABILITY_SHUTDOWN_TIMEOUT_MS` outside
1–5000 ms. Runtime `forceFlush` and `shutdown` also cap directly supplied budgets
at 5000 ms, including configurations constructed without the loader. Shutdown
flushes first and initiates cleanup even when that flush consumes its deadline.
Cleanup can finish later, with exporter deadlines and rejection handling still
active; it cannot extend the caller's wait.
