# Single-Flight Chat Session Enforcement

Status: ready-for-agent
Type: AFK

## What to build

Enforce that a Chat Session can have at most one running Agent Task. While Activity is running in a session, the chat composer should prevent another send, and the API should reject duplicate sends that would create concurrent running tasks.

## Acceptance criteria

- [ ] The API rejects a second message send for a Chat Session that already has a running task.
- [ ] The web composer is disabled or otherwise prevents sending while the current session has running Activity.
- [ ] Duplicate clicks or multi-tab sends cannot create two running Agent Tasks in the same Chat Session.
- [ ] The user sees a clear error or disabled state rather than a silent failure.
- [ ] Tests cover both API enforcement and frontend send prevention.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`
