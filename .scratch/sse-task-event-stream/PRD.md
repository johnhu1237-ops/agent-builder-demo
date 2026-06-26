# SSE Task Event Stream

Source spec: `docs/superpowers/specs/2026-06-26-sse-task-event-stream.md`

## Summary

Show an Agent Task's visible work in the chat transcript as Activity while it runs. The browser-facing realtime protocol is Server-Sent Events, with client-side polling only as an automatic fallback.

## Issue List

- `issues/01-scheduled-send-live-activity-happy-path.md`
- `issues/02-single-flight-chat-session-enforcement.md`
- `issues/03-activity-presentation-collapse-behavior.md`
- `issues/04-sse-replay-reconnect-semantics.md`
- `issues/05-failure-activity-assistant-failure-message.md`
- `issues/06-automatic-polling-fallback.md`
- `issues/07-end-to-end-verification-smoke-coverage.md`
