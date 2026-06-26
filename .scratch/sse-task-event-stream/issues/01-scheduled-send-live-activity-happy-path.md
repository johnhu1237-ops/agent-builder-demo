# Scheduled Send + Live Activity Happy Path

Status: ready-for-agent
Type: AFK

## What to build

Make the happy path for live Activity work end to end. When a user sends a message, the chat should immediately show the user message and an expanded Activity block for the running Agent Task. The API should schedule the task without waiting for final completion, expose session-scoped SSE events, and let the browser refresh canonical session detail once the task completes.

## Acceptance criteria

- [ ] Sending a chat message returns a scheduled response containing the created user message, the running task, and the session-scoped events URL.
- [ ] The Agent Task runs asynchronously after the scheduled response is returned.
- [ ] `GET /api/chat-sessions/:id/events` streams `task_snapshot`, `task_message`, and `task_completed` events for the session.
- [ ] The chat UI appends the user message immediately, renders expanded Activity while the task runs, and refreshes session detail after completion.
- [ ] Existing redaction guarantees for task messages and runner output remain intact.
- [ ] API and web tests cover the scheduled-send happy path.

## Blocked by

None - can start immediately
