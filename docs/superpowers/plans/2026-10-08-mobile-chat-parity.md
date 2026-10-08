# Mobile chat continuity and media implementation

Requested scope: persistent first-message titles; reusable in-app preview WebView;
image enlargement; real attachment upload matching Web; server-owned execution
and accurate state after backgrounding/termination. Existing API/worker owns jobs.

1. Extend generic run creation with validated attachment references (same ownership,
   readiness and atomic association as Web). Persist an untitled session's first
   prompt inside the create-run transaction, preserve custom titles. Add API/DB tests.
2. Add optional latest-run events to history. Test restoration for running,
   interrupted, failed/cancelled and completed runs. Mobile foreground/focus
   reloads authoritative history and resumes SSE with cursor; leaving never cancels.
3. Add a mounted reusable WebView overlay to the authenticated app. Resolve
   preview://open to session preview; same URL preserves page state, other URL
   navigates existing instance. Add fullscreen image viewer with pinch/double-tap
   zoom and authenticated private-image URLs. Cover URL rules and native interaction.
4. Add native document picker, SHA-256 and single/multipart/instant upload pipeline
   with size/count limits, ready/error/progress/removal/retry UI. Send attachment IDs
   and show user attachments, including after reopen. Test upload transport and API.
5. Typecheck/test affected packages, rebuild Android native modules, exercise title,
   WebView reuse, image zoom, text/image/file upload, force-stop during a run and
   relaunch after completed and while waiting. Update mobile README.
