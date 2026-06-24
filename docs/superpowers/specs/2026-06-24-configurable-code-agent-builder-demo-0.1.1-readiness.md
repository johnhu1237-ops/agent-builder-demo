# Configurable Code Agent Builder Demo v0.1.1 Conversational Readiness Spec

Date: 2026-06-24

## Summary

v0.1.1 upgrades the current v0.1 run-only skeleton into a conversational single-agent demo. It does not redefine the roadmap's v0.2 milestone. Instead, it closes the main v0.1 implementation gap by making the Research Agent session-based: a user can keep talking to the same configured agent, the runner can resume the same Codex conversation/workspace, and the product can persist user-visible chat history.

The naming should intentionally stay close to Multica's model because that vocabulary is easier to reason about and maps well to agent teammate products. v0.1.1 should use these names in the product model, database schema, API payloads, and implementation files unless an adapter boundary needs provider-specific names:

- `chat_session`: product-level conversation between the user and the configured Research Agent.
- `chat_message`: user-visible message in a chat session.
- `agent_tasks`: one lightweight execution record triggered by a user message. This intentionally maps to Multica's `agent_task_queue` concept without implementing a full queue system in v0.1.1.
- `task_message`: low-level execution trace/raw runner event for a task.
- `session_id + work_dir`: Codex/provider-native resume pointer and persistent workspace reference.

The existing v0.2 roadmap remains reserved for real MCP app integration, permissions UI, developer log viewer, and secret persistence.

## Background

The current implementation proves the basic skeleton:

- Single editable Research Agent.
- Shared Agent Spec validation and prompt materialization.
- Express API orchestrator.
- Separate runner service boundary.
- Fake deterministic runner.
- Vite React builder UI.
- Runtime-only API key in the UI contract.
- Markdown final output for a single task.
- Local fake-mode smoke path.
- Docker and Railway file skeleton.

The architecture is currently run-first:

```text
Agent Spec + task -> Run -> finalMarkdown
```

That is too narrow for the desired product direction. The agent should be conversational and resumable:

```text
chat_session
  -> chat_message(user)
     -> agent_tasks
        -> task_message
     -> chat_message(assistant)

chat_session also stores:
  -> session_id + work_dir for Codex resume
```

v0.1.1 should make this shift without expanding into v0.2 features.

## Goals

- Introduce session-first product semantics for the single Research Agent.
- Persist user-visible conversation history in Postgres.
- Persist per-session Codex resume pointers: `session_id` and `work_dir`.
- Keep each user message as a `chat_message` and each agent execution as an `agent_tasks` record.
- Store runner trace/raw events as `task_message` rows or an equivalent redacted trace table.
- Make `RUNNER_MODE=codex` support first-turn execution and resumed follow-up turns.
- Preserve the runtime-only API key guarantee: raw API keys must never be stored in database records, exported Agent Specs, normal user-facing errors, or user-visible chat messages.
- Keep fake runner mode for local demo and deployment fallback.
- Keep the UI product abstraction intact: users are chatting with their configured agent, not manually driving Codex CLI.

## Non-Goals

- No real MCP app integration.
- No permissions policy UI.
- No multi-agent CRUD.
- No encrypted API key persistence.
- No project/user auth.
- No billing, RBAC, teams, or audit retention.
- No artifact browser or file tree viewer.
- No visual workflow canvas.
- No multi-runtime selection UI.
- No production-grade sandboxing beyond reasonable v0.1.1 runner boundaries.

## Version Boundary

### v0.1.1 Means

v0.1.1 is a conversational readiness patch over v0.1:

- Single Research Agent remains the only editable agent.
- The run console becomes a chat/workbench.
- Every user message can trigger one lightweight agent task.
- Codex can resume prior session context via `session_id`.
- The runner can reuse a persistent per-session `work_dir`.
- Postgres becomes the product source of truth for visible chat state.

### v0.2 Still Means

v0.2 remains the future product expansion described in the existing design spec:

- Real MCP app integration for one provider.
- Permissions UI and safer default runner policies.
- Raw log viewer behind developer mode.
- Persisted project-level secrets or encrypted API keys.

## Naming Model

Use these names in the spec, plan, API, implementation files, and database unless there is a strong reason not to. The goal is to make the code read like the product model and stay close to the Multica vocabulary:

```text
chat_session ~= Multica chat_session
chat_message ~= Multica chat_message
agent_tasks ~= lightweight Multica agent_task_queue
task_message ~= Multica task_message
session_id + work_dir ~= Codex session id + persistent runner workspace
```

Avoid introducing parallel names such as `agent_session`, `session_message`, `session_run`, `run_event`, `raw_trace`, `session_task`, `execution`, or `job` for the same concepts. The v0.1 `run` language may remain only in migration notes, compatibility shims, or narrow runner adapter internals.

### `chat_session`

The product-level conversation between the user and the Research Agent.

Suggested fields:

- `id`
- `agent_spec_snapshot`
- `title`
- `session_id`
- `work_dir`
- `status`: `active` or `archived`
- `created_at`
- `updated_at`

`session_id` is the Codex/provider-native resume id. `work_dir` is the runner workspace path/reference. Both are runner-owned pointers and may be empty before the first task establishes them.

### `chat_message`

A user-visible message in a chat session.

Suggested fields:

- `id`
- `chat_session_id`
- `role`: `user` or `assistant`
- `content_markdown`
- `task_id`
- `created_at`

Only product-visible conversation content belongs here. Tool events, stdout/stderr, and internal runner logs do not belong in `chat_message`.

### `agent_tasks`

One lightweight unit of agent execution, usually triggered by a user `chat_message`.

Suggested fields:

- `id`
- `chat_session_id`
- `trigger_message_id`
- `agent_spec_snapshot`
- `status`: `pending`, `running`, `completed`, `failed`, `timed_out`, `cancelled`
- `session_id`
- `work_dir`
- `result_markdown`
- `raw_output_redacted`
- `error`
- `created_at`
- `started_at`
- `completed_at`

For this project, `agent_tasks` is not a full worker queue. It keeps the per-turn execution state that the product needs now while leaving room to evolve toward Multica's richer `agent_task_queue` later.

v0.1.1 should defer:

- priority scheduling.
- daemon claim leases.
- multi-agent assignment.
- issue/comment triggers.
- retry trees.
- cross-agent parallelism rules.
- task handoff between runtimes.

### `task_message`

Low-level execution trace for a task.

Suggested fields:

- `id`
- `task_id`
- `seq`
- `type`: `status`, `text`, `tool_use`, `tool_result`, `error`, `log`
- `tool`
- `content`
- `input_json`
- `output`
- `created_at`

`task_message` is useful for streaming, debugging, and future developer log views. It should be redacted before persistence.

## Product Behavior

### First Turn

1. User opens the Research Agent workspace.
2. UI creates or loads an active `chat_session`.
3. User enters API key and sends a message.
4. API persists a `chat_message(role='user')`.
5. API creates an `agent_tasks` row linked to that user message.
6. Runner receives the task with no prior `session_id`.
7. Runner creates or resolves a persistent `work_dir`.
8. Runner starts Codex with the materialized prompt.
9. Runner returns final Markdown, raw trace, `session_id`, and `work_dir`.
10. API stores the task result, updates the `chat_session.session_id/work_dir`, and creates a `chat_message(role='assistant')`.

### Follow-Up Turn

1. User sends another message in the same `chat_session`.
2. API persists a new user `chat_message`.
3. API creates a new `agent_tasks` row.
4. Runner receives:
   - current user message.
   - `chat_session.session_id`, if available.
   - `chat_session.work_dir`, if available.
   - sanitized Agent Spec snapshot.
5. Runner calls Codex resume when `session_id` is present.
6. Runner reuses the same `work_dir`.
7. API persists the assistant message and task trace.

### Resume Failure

If Codex resume fails before establishing a new session:

- The task should fall back to a fresh Codex session when safe.
- The fallback should still use the same `work_dir` if the workspace is valid.
- The API should not wipe an existing `chat_session.session_id` with an empty value.
- The task should record the resume failure in `task_message` or `raw_output_redacted`.

## Persistence Requirements

Postgres is required for v0.1.1.

Persist:

- Default Research Agent config.
- `chat_session`.
- `chat_message`.
- `agent_tasks`.
- `task_message` or equivalent redacted task trace.

Do not persist:

- Raw runtime API key.
- Unredacted stdout/stderr that may contain secrets.
- Internal runner implementation details as user-visible chat messages.

Acceptance criteria:

- Restarting the API does not erase chat sessions.
- Restarting the API does not erase chat messages.
- Restarting the API does not erase task status/result history.
- `chat_session.session_id/work_dir` survive API restart.
- A follow-up message can resume the previous Codex session when the runner workspace still exists.
- If the runner workspace is missing, the user receives a clear recovery/fresh-session outcome.

## Runner Requirements

The runner service must support both fake and Codex modes.

### Fake Mode

Fake mode must simulate session behavior:

- First turn returns a deterministic assistant message.
- Follow-up turn can include the prior fake `session_id`.
- Fake mode returns stable `session_id` and `work_dir` placeholders for tests.

### Codex Mode

Codex mode must support:

- First turn: `codex exec ...`
- Follow-up turn: `codex exec resume <session_id> ...` or the equivalent current Codex protocol.
- Persistent `work_dir` per `chat_session`.
- Configurable timeout.
- Redacted raw output.
- Empty-output detection.
- Non-zero exit handling.
- Resume failure fallback when safe.

Runner output must include:

- task status.
- assistant final Markdown.
- raw output redacted.
- task messages/events.
- `session_id`, when known.
- `work_dir`, when known.

## API Requirements

Replace run-first endpoints with session-first endpoints. Endpoint names should use chat/task language rather than run language.

Required endpoints:

- `GET /health`
- `GET /api/agent/default`
- `PUT /api/agent/default`
- `POST /api/chat-sessions`
- `GET /api/chat-sessions`
- `GET /api/chat-sessions/:id`
- `POST /api/chat-sessions/:id/messages`
- `GET /api/chat-sessions/:id/events` or equivalent polling/status endpoint
- `GET /api/agent-tasks/:id`

Optional endpoint:

- `POST /api/agent-tasks/:id/cancel`

Implementation note: `/api/tasks/:id` can exist as a compatibility or convenience alias, but the primary persisted record, domain type, and implementation file names should use `agent_tasks` / `AgentTask`.

Behavior requirements:

- `POST /api/chat-sessions/:id/messages` validates the message, current Agent Spec, model fields, and runtime API key.
- The API creates the user `chat_message` before creating the `agent_tasks` record.
- The API links the user `chat_message` to the created task.
- The API creates the assistant `chat_message` only when a task produces visible assistant content.
- The API must not expose raw API keys in responses.
- The API must return stable error shapes.

## UI Requirements

The right-side Run Console should become a chat/workbench:

- Message list with user and assistant messages.
- Composer input for the next message.
- Current task status.
- Trace/timeline for the active task.
- Markdown rendering for assistant messages.
- Runtime-only API key field, still clearly non-persistent.
- Export Agent Spec action, still excluding raw API key.

The UI should not expose:

- Codex CLI command details.
- Raw `session_id` as a primary user-facing concept.
- `work_dir` as a primary user-facing concept.

The UI may show a small technical status such as "Session resumed" or "Fresh session started" if useful for debugging the demo, but it should not dominate the product experience.

## Security and Redaction Requirements

- Runtime API keys are request-only.
- The API key must be passed to the runner only for the current task.
- The API key must not be written into `chat_session`, `chat_message`, `agent_tasks`, or `task_message`.
- Raw runner output must be redacted before persistence.
- User-visible assistant messages must be redacted before persistence.
- The runner must keep broad permissions hidden from the UI.
- The runner must document current sandbox/workspace limitations.

## Testing Requirements

### Shared

- Agent Spec export omits raw API key.
- Prompt/session materialization includes current user message and agent config.
- Prompt/session materialization preserves product instructions even when using Codex resume.
- Unknown registry IDs still fail validation.

### Runner

- Fake runner returns deterministic `session_id`, `work_dir`, assistant Markdown, and task messages.
- Codex command builder supports first-turn execution.
- Codex command builder supports resumed execution.
- Codex runner handles success.
- Codex runner handles non-zero exit.
- Codex runner handles timeout.
- Codex runner handles empty final output.
- Codex runner reports `session_id/work_dir` without leaking API key.
- Resume failure can fall back to fresh session when safe.

### API

- Creating a chat session persists `chat_session`.
- Sending a message persists `chat_message(role='user')`.
- Sending a message creates an `agent_tasks` task.
- Completed task creates `chat_message(role='assistant')`.
- Completed task updates `chat_session.session_id/work_dir`.
- Failed task does not erase existing `chat_session.session_id/work_dir`.
- Runtime-only API key is not persisted.
- Session state survives store/API reinitialization against the same database.

### UI

- User can create/load a chat session.
- User can send the first message.
- User can send a follow-up message.
- UI shows user and assistant messages.
- UI shows pending/running/completed/failed/timed-out task states.
- UI renders assistant Markdown.
- UI shows validation errors for missing message/API key.
- Exported Agent Spec excludes raw API key.

### Deployment

- Docker image builds are verified.
- Local fake-mode chat smoke passes.
- Local or Railway codex-mode chat smoke passes with valid credentials.
- A follow-up turn resumes the prior Codex session in a deployed environment when workspace storage is available.

## Documentation Requirements

Update or add docs for:

- Local development with Postgres.
- Chat/session data model.
- Fake runner chat smoke test.
- Codex runner first-turn and resume smoke test.
- Railway deployment with Web/API, Runner, Postgres, and persistent runner storage assumptions.
- Runner security assumptions.
- Troubleshooting:
  - Docker pull/build failures.
  - Codex CLI missing or misconfigured.
  - invalid model endpoint.
  - resume failure.
  - missing workspace.
  - timeout.
  - empty final output.

## Open Questions

- Should `/api/tasks/:id` exist as a short compatibility alias, or should v0.1.1 expose only `/api/agent-tasks/:id` to keep the vocabulary strict?
- Should v0.1.1 require a persistent runner volume, or allow degraded behavior where messages persist but workspaces can be lost on runner restart?
- Should the API support multiple chat sessions immediately, or create one implicit active session for the single Research Agent?
- Should cancellation ship in v0.1.1, or remain deferred until the runner execution model is fully asynchronous?
- Should raw output be stored directly in Postgres as redacted text, or stored as separate task messages with size limits?
- Which exact Codex CLI mechanism should production use: `codex exec resume <id>` or the app-server `thread/resume` protocol?

## Suggested Implementation Slices

1. Shared session/task/message contracts and prompt materialization.
2. Postgres schema and store boundary using Multica-inspired names.
3. API chat session/message/task lifecycle.
4. Fake runner session behavior.
5. Codex runner first-turn/resume behavior.
6. Chat/workbench UI.
7. Redaction, timeout, workspace, and resume-failure hardening.
8. Docker/Railway chat smoke validation.

These slices are intentionally not a full implementation plan. A separate plan should break them into test-first tasks with exact file edits and verification commands.
