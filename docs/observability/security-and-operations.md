# Observability security and operations

## Configuration contract

`.env.example` and `deploy/env.production.example` intentionally contain the same observability keys. They are templates, not credential stores. Local development keeps `OTEL_ENABLED=false` and `OBSERVABILITY_CAPTURE_CONTENT=false`. Production uses parent-based trace-ID ratio sampling with an initial ratio of `0.05`; staging should use 100% trace sampling (`OTEL_TRACES_SAMPLER_ARG=1`). Error requests and explicitly debugged runs may raise sampling through the approved runtime controls, but user IDs must never be used as telemetry labels.

OTLP headers and Langfuse keys stay empty in repository templates. Inject them at runtime from the deployment secret manager. Never add new credentials to Git.

## Historical credential cleanup

An older Git history revision of `.env.example` contained suspected Langfuse credentials. Before production rollout, the credential owner must revoke and rotate those credentials and confirm the replacements are injected only by the secret manager. The security owner decides whether history rewriting is required and must retain an audit record of that decision and any rewrite.

## Retention and privacy

- Metrics: 30 days.
- Ordinary logs: 14 days.
- Traces: 7 days.
- Langfuse data: 30 days.
- Production content capture: disabled.

Deletion requests and access audits remain subject to the existing PostgreSQL governance process. Telemetry must use low-cardinality operational identifiers; do not put user IDs, prompts, completions, or secrets into labels.

## Operational guardrails

Telemetry must be fail-open for business traffic: an exporter or collector outage must not fail API requests or worker jobs. Shutdown flushes are bounded by `OBSERVABILITY_SHUTDOWN_TIMEOUT_MS` (five seconds in the production template). Rotate credentials immediately if a secret appears in logs, traces, or a repository artifact, then record the incident and verify downstream revocation.
