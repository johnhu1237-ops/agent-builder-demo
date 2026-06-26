# SSE Replay and Reconnect Semantics

Status: ready-for-agent
Type: AFK

## What to build

Make SSE reconnect deterministic. The stream should use the persisted task message sequence as the SSE event id, replay missed messages with `Last-Event-ID`, and let the browser deduplicate Activity events by task and sequence.

## Acceptance criteria

- [ ] `task_message` SSE events use `task_message.seq` as the SSE event id.
- [ ] Event payloads include `taskId`, `seq`, and the task message.
- [ ] Reconnecting with `Last-Event-ID` replays persisted messages with a greater sequence number.
- [ ] Connecting without `Last-Event-ID` replays persisted messages for the current latest running task.
- [ ] The browser deduplicates Activity events by `taskId + seq`.
- [ ] Tests cover replay after disconnect and no duplicate Activity rows after reconnect.

## Blocked by

- `.scratch/sse-task-event-stream/issues/01-scheduled-send-live-activity-happy-path.md`
