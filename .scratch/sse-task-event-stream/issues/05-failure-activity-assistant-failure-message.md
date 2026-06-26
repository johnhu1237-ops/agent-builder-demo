# Failure Activity + Assistant Failure Message

Status: ready-for-agent
Type: AFK

## What to build

When an Agent Task fails or times out, the Chat Session should still receive an assistant-side outcome. The transcript should show a short assistant failure message, while Activity keeps the detailed error events, logs, and tool output.

## Acceptance criteria

- [ ] Failed and timed-out tasks create a concise assistant message in the chat transcript.
- [ ] Detailed errors, logs, and tool output remain in Activity rather than being dumped into the assistant message.
- [ ] The SSE stream emits `task_failed` for failed and timed-out tasks.
- [ ] Failed Activity collapses to a failed summary such as `Failed · N events`.
- [ ] Historical chat review shows the failed turn without requiring Activity expansion.
- [ ] Tests cover failure message persistence, `task_failed`, and failed Activity presentation.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`
- `.scratch/sse-task-event-stream/issues/03-activity-presentation-collapse-behavior.md`
