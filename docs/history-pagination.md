# Bounded session history

`GET /api/agent/sessions/:sessionId/history` returns the latest 20 Runs by default, with at most 50 Runs per request (`limit=1..50`). A Run can contribute a user message and an assistant message. Messages within each page remain chronological. Existing `session`, `messages`, `latestRun`, reasoning, citations and attachment fields remain available.

`hasMore` and `nextCursor` identify an older page. Pass the opaque cursor as `?cursor=...`, then prepend that page's messages while retaining current messages by ID. Both Web and mobile expose a “加载更早消息” action, preserve the active stream, and ignore page responses belonging to a different session. A newer Run created between requests does not move the older-page cursor. Latest Run metadata always describes the actual newest Run, including when reading older pages.

`includeLatestEvents=1` returns the latest 500 persisted events, plus `latestRunProjection` and `latestRunEventsTruncated`. The projection includes the complete current assistant text, reasoning, citations and event sequence. Mobile seeds text from that projection, replays bounded control events, and applies text events only when newer than the projection cursor; reconnects resume after the reconciled cursor. Older event traces are not included in this history response.

Migration `026_history_projections.sql` installs `run_message_projections` and `session_file_projections`. An event INSERT updates projections in the same PostgreSQL transaction, so failed/rolled-back writes cannot publish a partial projection. Assistant snapshots replace prior text, including empty snapshots; deltas and reasoning append; retrieval citations are retained. The migration backfills existing data in PostgreSQL. A missing Run projection rebuilds from its ledger in PostgreSQL on the next authorized history read, without loading the ledger into application memory.

`GET /api/agent/sessions/:sessionId/files` reads the durable file projection directly, defaults to 100 files, and accepts `limit=1..200` plus an opaque `cursor`. The Web file panel exposes “加载更多文件” when another page exists. The latest write/edit content remains available when a later read/delete operation touches the same path. File operations with empty paths or paths longer than 1024 characters are excluded. Existing attachment content URLs and missing-session 404 responses are unchanged.

Invalid page sizes or cursors return HTTP 400. Database queries authorize the session owner and tenant, and exclude deleted sessions. Pages use `(created_at,id)` Run cursors preserving PostgreSQL microsecond precision, and file cursors use path ordering.

To rebuild one Run after diagnosing projection corruption, use the existing database's SQL console:

```sql
SELECT rebuild_run_message_projection('<run UUID>', '<tenant UUID>');
```

This rebuild acquires the Run row lock and is safe alongside event persistence. Run migrations before deploying API/Worker changes; projections are maintained by the database trigger for both fenced and legacy repository event writes.
