# Runbook: telemetry outage

Use this runbook when OTLP, Alloy, Langfuse, dashboards, or alerting stop receiving expected data.

1. Confirm the business-plane health endpoints and representative API/worker requests. Telemetry loss must not block them.
2. Check collector/exporter health, endpoint reachability, queue/backlog depth, and recent deploy or credential-rotation events.
3. If the collector is unavailable, leave application traffic running in degraded/no-op mode. Do not enable content capture to compensate.
4. Restore connectivity or rotate the failed credential through the credential-rotation runbook. Validate one API trace, one worker run, and one metric export.
5. Record the outage window, affected signals, dropped data, customer impact, and retention implications. Escalate if the outage exceeds the applicable alert/SLO window.
