# End-to-End Verification and Smoke Coverage

Status: ready-for-agent
Type: AFK

## What to build

Add end-to-end verification for the completed Activity experience across the fake runner path and the E2B runner path. The smoke coverage should prove scheduled send, live Activity, reconnect behavior, failure presentation, and polling fallback.

## Acceptance criteria

- [ ] Automated tests cover the live Activity happy path from send through final assistant message.
- [ ] Automated tests cover failure Activity and assistant failure message behavior.
- [ ] Automated tests cover reconnect/replay behavior and no duplicate Activity rows.
- [ ] Automated tests cover client polling fallback after SSE failure.
- [ ] Smoke documentation explains how to verify the fake runner path locally.
- [ ] Smoke documentation explains how to verify the E2B runner path in an environment with valid credentials.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`
- `.scratch/sse-task-event-stream/issues/02-single-flight-chat-session-enforcement.md`
- `.scratch/sse-task-event-stream/issues/03-activity-presentation-collapse-behavior.md`
- `.scratch/sse-task-event-stream/issues/04-sse-replay-reconnect-semantics.md`
- `.scratch/sse-task-event-stream/issues/05-failure-activity-assistant-failure-message.md`
- `.scratch/sse-task-event-stream/issues/06-automatic-polling-fallback.md`
