# Automatic Polling Fallback

Status: ready-for-agent
Type: AFK

## What to build

Add client-side fallback from SSE to polling. The web app should prefer `EventSource`, but if SSE is unavailable or repeatedly fails, it should poll the session-scoped task state until the Agent Task reaches terminal state.

## Acceptance criteria

- [ ] The web app uses `EventSource` as the primary live Activity transport.
- [ ] If `EventSource` is unavailable or fails repeatedly, the web app automatically falls back to polling.
- [ ] Polling preserves the same visible semantics as SSE: Activity updates while running, collapses at terminal state, and final session detail is refreshed.
- [ ] Polling does not create duplicate Activity rows when switching from SSE.
- [ ] Tests cover automatic fallback and terminal refresh in fallback mode.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`
- `.scratch/sse-task-event-stream/issues/04-sse-replay-reconnect-semantics.md`
