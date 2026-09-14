# Runbook: observability credential rotation

Use this runbook when an OTLP or Langfuse credential is expiring, suspected exposed, or changed by the provider.

1. Identify the credential owner and affected environment; do not paste the value into tickets or chat.
2. Revoke the old Langfuse/OTLP credential at the provider and create a replacement in the approved secret manager.
3. Update the secret-manager version consumed by the API and worker services. Keep the corresponding repository template values empty.
4. Perform a rolling restart, then verify health checks and a synthetic trace/export. Confirm normal requests still succeed if the collector is unavailable.
5. Search logs and telemetry for the old credential, remove any accidental exposure according to incident policy, and document timestamps, owners, provider request IDs, and verification evidence.
6. The security owner decides whether Git history rewriting is necessary for historical `.env.example` exposure and preserves the audit record either way.
