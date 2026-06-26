# SSE Task Event Stream Spec

Date: 2026-06-26

## Summary

The chat workbench must show an agent task's work while it is running, not only
after the task completes. The product should use Server-Sent Events (SSE) as the
primary browser-facing realtime protocol, with polling kept only as a fallback for
environments where an SSE connection cannot be maintained.

E2B is not the browser streaming protocol. E2B streams command output to the runner
through `onStdout` and `onStderr` callbacks. The runner converts that output into
redacted task events, sends them to the API, and the API exposes those events to the
web client over SSE.

## Current Behavior

- The web app sends a chat message with `POST /api/chat-sessions/:id/messages` and
  waits for the response.
- The API creates the user message and agent task, then awaits
  `runnerClient.runAgentTask(...)`.
- The runner receives E2B command output incrementally and posts redacted task
  events back to the API through `/internal/runner/task-events`.
- The API persists those incremental task events as `task_message` rows.
- The browser does not subscribe to those rows while the task runs.
- The API returns the full `ChatSessionDetail` only after the runner finishes, so
  the UI can only render final assistant output and the completed task timeline.

## Goals

- Show task progress in the chat workbench while the agent task is running.
- Present live task progress inline in the chat as Activity, similar to Codex-style
  interaction: expanded while running, collapsed after completion.
- Use SSE as the primary realtime delivery mechanism from API to browser.
- Preserve E2B command streaming as the runner-side source of task events.
- Keep polling only as a fallback, not the main product path.
- Continue persisting task events in Postgres so reconnects and page reloads can
  replay already-recorded task messages.
- Preserve existing redaction guarantees for API keys and runner output.
- Avoid exposing runner-only credentials or internal event endpoints to the browser.

## Non-Goals

- No browser-to-runner direct connection.
- No direct browser-to-E2B streaming.
- No WebSocket requirement for this change.
- No change to the agent configuration model.
- No change to the user's model API key storage behavior.
- No replacement of E2B `onStdout` / `onStderr` handling in the runner.
- No claim that the UI displays hidden model reasoning, chain-of-thought, or private
  internal thoughts. Activity displays visible task events only.

## Confirmed Decisions

### Browser Realtime Protocol

Use SSE as the formal browser-facing realtime protocol for task progress. Polling is
only a fallback for clients or deployment environments where SSE is not viable.

Rationale:

- The system already has a task-event concept and an `/events` route.
- Agent task progress is server-to-browser, not full duplex, so SSE fits better than
  WebSockets.
- Polling would be easier to add but would keep the public realtime contract
  ambiguous and require another migration later.

### Chat Presentation

Render the Task Event Stream inline in the chat as Activity. Activity is expanded
while the agent task is running and automatically collapses after the task reaches a
terminal status. The user can manually expand completed Activity to inspect the
recorded work trace.

Rationale:

- Users expect to see what the agent is doing in the place where the conversation is
  happening, not in a separate developer log panel.
- Codex-style interaction makes the running task feel alive without interrupting the
  final answer.
- Collapsing completed Activity keeps the transcript readable while preserving
  inspectability.

Activity is not hidden model reasoning. It displays visible task events such as
status updates, tool calls, tool results, logs, and errors.

### Product Terminology

Use `Activity` for the chat UI label. Use `Task Event Stream` for architecture,
protocol, API, and persistence discussions.

### Chat Session Concurrency

Do not allow more than one running agent task in a chat session at the same time.
While a task is running, the chat composer should prevent another send for that
session, and the API should reject or ignore a second send that would create another
running task.

Rationale:

- A user message maps to one agent task, one inline Activity block, and one final
  assistant message.
- Single-flight chat sessions keep final answer ordering and Activity ownership
  unambiguous.
- Concurrent tasks would require task-scoped UI routing, interleaved Activity
  rendering, and more complex failure and cancellation semantics.

### SSE Scope

The browser subscribes to task events by chat session:
`GET /api/chat-sessions/:id/events`.

The stream is session-scoped, not task-scoped. Because a chat session may have at
most one running agent task, session scope is enough to route live Activity without
interleaving multiple active tasks. Event payloads should still include `taskId` so
the browser can deduplicate, reconcile reconnects, and ignore stale events.

Rationale:

- The chat session is the user's navigation and persistence boundary.
- The route already exists as `/api/chat-sessions/:id/events`.
- A session-scoped stream makes reload and resume behavior simpler for the web app.
- Task-scoped URLs would add routing complexity without providing value while
  per-session concurrency is single-flight.

## Proposed Architecture

### Event Flow

1. The web app posts the user's message to `POST /api/chat-sessions/:id/messages`.
2. The API creates the user `chat_message`, creates an `agent_tasks` row, marks it
   running, and returns enough information for the browser to subscribe to task
   progress.
3. The API starts the runner task asynchronously.
4. The runner executes Codex in E2B.
5. E2B streams command output to the runner through `onStdout` / `onStderr`.
6. The runner converts output into redacted `RunnerTaskMessage` events.
7. The runner posts those events to `/internal/runner/task-events`.
8. The API persists events as `task_message` rows and broadcasts them to active SSE
   subscribers for the chat session.
9. The browser receives `task_message` events and updates the inline Activity block
   in the chat transcript.
10. When the task completes or fails, the API persists the terminal state and
    broadcasts a terminal SSE event.
11. The browser closes the SSE connection and refreshes the session detail to render
    the final assistant message and canonical task state, then collapses Activity to
    its summary state.

### API Shape

`POST /api/chat-sessions/:id/messages` should stop being a long-running request. It
should return quickly after the task is created and scheduled. The response should
be a lightweight scheduled response, not a final `ChatSessionDetail`.

Suggested response shape:

```json
{
  "chatSessionId": "chat_123",
  "userMessage": {
    "id": "msg_123",
    "chatSessionId": "chat_123",
    "role": "user",
    "contentMarkdown": "Research RunwayML",
    "taskId": null,
    "createdAt": "2026-06-26T00:00:00.000Z"
  },
  "task": {
    "id": "task_123",
    "chatSessionId": "chat_123",
    "triggerMessageId": "msg_123",
    "status": "running"
  },
  "eventsUrl": "/api/chat-sessions/chat_123/events"
}
```

The browser uses this response to append the user's message immediately, create an
expanded Activity block for the running task, and subscribe to the session-scoped
SSE stream. The final assistant message is loaded from canonical session detail
after a terminal SSE event.

The browser should open the SSE connection immediately after `POST /messages`
returns the scheduled response. It should not subscribe before posting the message:
the scheduled response provides the canonical `eventsUrl` and running `task.id`.
Any task messages written between task scheduling and SSE connection establishment
must be replayed by the SSE endpoint from persisted `task_message` rows.

`GET /api/chat-sessions/:id/events` should become an SSE endpoint instead of a
one-shot JSON endpoint.

The SSE endpoint should send:

- an initial snapshot or replay of already-persisted task state,
- incremental task messages as they are appended,
- a terminal event when the task completes or fails,
- lightweight keepalive comments or events so intermediaries do not close idle
  connections too aggressively.

SSE event names:

- `task_snapshot`: sent after connection establishment with the current latest task
  and already-persisted task messages.
- `task_message`: sent for each newly appended Activity event.
- `task_completed`: sent when the task completes successfully.
- `task_failed`: sent when the task fails or times out.
- `keepalive`: optional heartbeat event for long-running tasks.

Suggested payloads:

```ts
type TaskSnapshotEvent = {
  task: AgentTask | null;
  taskMessages: TaskMessage[];
};

type TaskMessageEvent = {
  taskId: string;
  seq: number;
  taskMessage: TaskMessage;
};

type TaskTerminalEvent = {
  taskId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled";
  error?: string | null;
};
```

The web state machine should initialize from `task_snapshot`, append visible
Activity rows from `task_message`, and refresh canonical session detail after
`task_completed` or `task_failed`.

SSE task-message events should use the persisted `task_message.seq` as the SSE
event id. Event payloads should include both `taskId` and `seq`.

On reconnect:

- If the request includes `Last-Event-ID`, replay persisted messages for the current
  latest task with `seq > Last-Event-ID`.
- If the request does not include `Last-Event-ID`, replay all persisted messages for
  the current latest running task before streaming new messages.
- If the latest task is already terminal, the endpoint may replay its messages and
  immediately send the terminal event.

This keeps replay deterministic and aligned with standard EventSource behavior.

### Persistence And Replay

Postgres remains the source of truth for task messages. SSE is a delivery mechanism,
not the state store. If a browser reconnects, the API should be able to replay
already-persisted task messages before sending new ones.

### Failure Presentation

When an agent task fails or times out, the chat transcript should still receive an
assistant message. The assistant failure message should be short and human-readable,
for example:

```md
Task failed: Codex exited with code 1
```

The detailed error event, logs, and tool output remain in Activity. Completed failed
Activity collapses to a failed summary, such as `Failed · 7 events`, and stays
manually expandable.

Rationale:

- A user message should always have a visible assistant-side outcome in the
  transcript.
- Historical chat review should reveal failed turns without requiring the user to
  expand Activity.
- Long logs and low-level details belong in Activity, not in the assistant message.

Current code note: `failAgentTask` records task status, error, and task messages,
but does not yet create an assistant chat message for the failure. This spec changes
that behavior.

### Runner Boundary

The runner remains responsible for:

- reading E2B command output incrementally,
- parsing Codex JSON lines where possible,
- redacting secrets before emitting events,
- posting events to the API's internal runner event endpoint,
- returning final task output to the API when the command completes.

The runner should not know about browser SSE connections.

## Fallback

Polling may be used only when SSE is unavailable. The fallback should be automatic
on the client, not a deployment configuration switch.

The web app should prefer `EventSource`. It should fall back to polling when:

- `EventSource` is unavailable,
- the SSE connection fails before receiving usable task state,
- the connection repeatedly drops beyond a small retry threshold.

In polling mode, the web app can poll the session-scoped task-event endpoint or
session detail at a fixed interval until the task reaches a terminal status.
Polling must preserve the same product semantics as SSE: running state is visible,
persisted task messages are shown, Activity collapses after terminal state, and the
final assistant message is loaded from canonical session detail.

## Open Questions

- None.
