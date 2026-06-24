# Configurable Code Agent Builder Demo v0.1.2 E2B Sandbox Runner Spec

Date: 2026-06-24

## Summary

v0.1.2 changes how the conversational Research Agent executes. It keeps the entire
v0.1.1 product model — `chat_session`, `chat_message`, `agent_tasks`, `task_message`,
and the `session_id + work_dir` resume pointers — unchanged. The only thing that
changes is the runner's execution substrate: instead of spawning `codex` on the
runner host with an ephemeral local workspace, the runner executes Codex CLI inside
an E2B sandbox.

This delegates persistent workspace, resume, and isolation to a mature sandbox
provider rather than building and operating that state management ourselves. The
v0.1.1 spec planned to introduce a persistent `work_dir` and Codex resume on top of
the local-spawn runner; v0.1.2 supersedes that runner implementation choice while
leaving the persistence requirements and product behavior identical.

## Background

After v0.1.1, the product layer is in place:

- Postgres is the source of truth for `chat_session`, `chat_message`, `agent_tasks`,
  and `task_message`.
- Shared contracts already model `sessionId` and `workDir` as opaque,
  provider-owned resume pointers (`packages/shared/src/chat.ts`).
- The API, database schema, and UI treat `sessionId` / `workDir` as values the
  runner returns and the API stores — they carry no provider-specific meaning above
  the runner boundary.

The runner itself is the gap. The current `apps/runner/src/codex-runner.ts`:

- creates a fresh temp workspace under `tmpdir()` per request,
- runs `codex exec ...` once with `--sandbox danger-full-access`,
- reads `final.md`,
- then deletes the workspace in a `finally` block.

So there is no persistent `work_dir`, no resume, and no isolation today. v0.1.1
intended to add persistent workspaces and Codex resume directly on this local-spawn
path, which would have required us to operate persistent runner storage, manage
workspace lifecycle, and handle resume/fallback ourselves.

v0.1.2 fills the same gap by running Codex inside an E2B sandbox, where a persistent
filesystem and pause/resume are native primitives.

## Goals

- Replace the local-spawn Codex runner with an E2B-sandbox Codex runner.
- Map one `chat_session` to one long-lived E2B sandbox using pause/resume.
- Use the E2B sandbox id as the `work_dir` resume pointer.
- Continue to track the Codex `session_id` so conversation context resumes, not just
  the filesystem.
- Preserve all v0.1.1 product behavior, persistence guarantees, public Web/API
  session endpoints, and UI.
- Accept a narrow API/runner contract expansion for incremental `task_message`
  persistence: v0.1.2 keeps Option C as the baseline streaming approach.
- Keep `fake` runner mode as the local demo path and an operator-selectable fallback
  (switch `RUNNER_MODE` back to `fake`) when E2B is unavailable. v0.1.2 does not add
  automatic e2b-to-fake failover.
- Preserve the runtime-only API key guarantee: the key is injected into the sandbox
  only for the current execution and is never persisted.
- Control sandbox cost with an explicit lifecycle policy.

## Non-Goals

- No change to the Postgres schema, public UI-facing API endpoints, or UI product
  model, except the runner-internal contract extension required for Option C.
- No real MCP app integration (still v0.2).
- No permissions policy UI (still v0.2).
- No encrypted API key persistence (still v0.2).
- No multi-agent CRUD.
- No per-turn fresh-sandbox-plus-volume model (rejected in favor of long-lived
  sandbox + pause/resume).
- No retaining of the local-spawn `codex` runner mode as a supported production path.
- No sandbox destruction on `chat_session` archive in v0.1.2; archive cleanup is
  deferred to a later lifecycle phase.

## Version Boundary

### v0.1.2 Means

v0.1.2 is an execution-substrate patch over v0.1.1:

- Product model, persistence, public chat APIs, and UI are exactly as shipped in
  v0.1.1, except for runner/API internals needed for incremental task events.
- `RUNNER_MODE` supports `fake` and `e2b`. The `codex` (local-spawn) mode is removed.
- Codex CLI runs inside an E2B sandbox built from a custom template.
- A `chat_session` owns one E2B sandbox across turns via pause/resume.
- `work_dir` holds the E2B sandbox id; `session_id` holds the Codex session id.
- Runner requests carry enough task identity for the runner to emit incremental
  task events to the API while the final response remains the existing task result
  shape.

### What v0.1.2 Does Not Touch

- The v0.1.1 conversational data model and acceptance criteria remain authoritative.
- v0.2 still means real MCP integration, permissions UI, developer log viewer, and
  persisted/encrypted secrets.
- Full duplex runner streaming (SSE/NDJSON) remains a later upgrade; v0.1.2 uses
  incremental persistence plus UI polling.

## Architecture

### Change Surface

The change is intentionally narrow and concentrated in the runner.

Unchanged:

- Postgres schema and migrations.
- Public chat API endpoints and UI-facing response shapes.
- Shared contracts in `packages/shared/src/chat.ts`, including `CreateAgentTaskRequest`,
  `RunnerAgentTaskResponse`, and the `sessionId` / `workDir` fields, except for the
  narrow runner-internal event ingestion extension described below.
- Web UI.
- `apps/runner/src/fake-runner.ts`.

Replaced:

- `apps/runner/src/codex-runner.ts` → `apps/runner/src/e2b-runner.ts`.
- The local `spawn("codex", ...)` execution path is removed.

Added:

- An E2B sandbox template: `e2b.Dockerfile` plus `e2b.toml`, with Codex CLI
  preinstalled and pinned to a known version.
- Runner configuration for E2B (`E2B_API_KEY`, `E2B_TEMPLATE_ID`).
- Runner/API incremental task-event plumbing for Option C:
  - `CreateAgentTaskRequest` includes the `taskId` and an internal API event target
    or callback configuration.
  - The API exposes a runner-authenticated internal route for appending redacted
    `task_message` rows for that task, or an equivalent internal write adapter.
  - The UI continues polling `GET /api/chat-sessions/:id/events`; no UI protocol
    change is required.

### Runner Internal Units

`e2b-runner.ts` is decomposed into small, independently testable units:

- `resolveSandbox(workDir)` — when `workDir` is null, create a new sandbox from the
  template; when present, attempt to resume the sandbox by id. Distinguishes a
  successful resume from a "workspace lost" outcome (expired/missing sandbox).
- `buildCodexCommand({ modelName, sessionId, prompt, finalPath, workspacePath })` —
  a pure function. First turn produces `codex exec ...`; when `sessionId` is present
  it produces `codex exec resume <sessionId> ...`. Mirrors the existing
  `createCodexCommand` shape to keep it portable and unit-testable.
- `execInSandbox(sandbox, command, { apiKey, apiEndpoint, timeoutMs, emitEvent })`
  — runs the Codex command inside the sandbox, injecting the API key and endpoint as
  command-scoped environment variables for that execution only, reads the final
  Markdown file, collects raw output, and emits redacted task events incrementally.
- `finalize(sandbox)` — pauses the sandbox and returns the `RunnerAgentTaskResponse`
  with `workDir` set to the sandbox id and `sessionId` set to the Codex session id.

## Runner Requirements

The runner service must support both `fake` and `e2b` modes.

### Fake Mode

Unchanged from v0.1.1. Fake mode simulates session behavior with deterministic
`session_id` / `work_dir` placeholders and serves as the local demo path and an
operator-selectable fallback when E2B is unavailable. There is no automatic
e2b-to-fake failover in v0.1.2.

### E2B Mode

E2B mode must support:

- First turn: create a sandbox from `E2B_TEMPLATE_ID`, run `codex exec ...`.
- Follow-up turn: resume the sandbox by `work_dir` (sandbox id), run
  `codex exec resume <session_id> ...`.
- Pausing the sandbox after each task completes.
- Configurable execution timeout.
- Redacted raw output.
- Empty-output detection.
- Non-zero exit handling.
- Resume-failure fallback when safe.
- Incremental task event persistence through the API/runner internal channel.

Runner output must include task status, assistant final Markdown, redacted raw
output, task messages/events, `session_id` (when known), and `work_dir`
(the sandbox id, when known) — exactly the existing `RunnerAgentTaskResponse` shape.

The API key must never appear in runner output, task messages, or returned pointers.

## Sandbox Lifecycle and Resume

### Two-Layer Resume Semantics

E2B sandbox resume restores the entire sandbox filesystem, which includes both the
working-directory artifacts and Codex's own on-disk session files. `codex exec
resume <session_id>` then restores the conversation context. Both layers together
mean a follow-up turn genuinely continues the prior conversation and workspace.

### First Turn

1. Task arrives with `work_dir = null` and `session_id = null`.
2. `resolveSandbox(null)` creates a new sandbox from the template.
3. `execInSandbox` runs `codex exec ...` with the materialized prompt.
4. Read final Markdown.
5. `finalize` pauses the sandbox.
6. Return `work_dir = sandbox id`, `session_id = codex session id`, result, redacted
   raw output, and task messages.

### Follow-Up Turn

1. Task arrives with `work_dir` (sandbox id) and `session_id` (codex session id).
2. `resolveSandbox(workDir)` resumes the sandbox.
3. `execInSandbox` runs `codex exec resume <session_id> ...`.
4. Read final Markdown.
5. `finalize` pauses the sandbox.
6. Return updated pointers and results.

### Resume Failure / Workspace Lost

If resuming the sandbox fails (expired, evicted, or otherwise missing):

- Treat it as "workspace lost" and start a fresh sandbox for the turn.
- Do not overwrite an existing `chat_session.session_id` with an empty value when
  the new session id is not yet established.
- Never mix an old Codex `session_id` with a fresh sandbox id. If workspace loss
  forces a fresh sandbox, the old `session_id` is no longer valid for that sandbox.
  On successful fallback, return and persist the fresh sandbox id and the fresh Codex
  session id. If the fresh Codex session id cannot be established, leave the old
  pointer pair unchanged or explicitly clear both pointers; do not persist a fresh
  `work_dir` alongside the old `session_id`.
- Record the resume failure in `task_message` / `raw_output_redacted`.
- Surface a small "fresh session started" status to the UI, consistent with the
  v0.1.1 "missing workspace" recovery outcome.

### Cost / Lifecycle Policy

- **Pause on completion:** after each task's Codex execution finishes, the sandbox is
  paused immediately so only storage is billed between turns.
- **Resume loss is acceptable:** if a paused sandbox is gone on the next turn, the
  session falls back to a fresh sandbox (see Resume Failure). v0.1.2 does not add an
  idle-timeout sweeper or a retention-expiry job; that optimization is deferred.
- **Archive cleanup deferred:** v0.1.2 does not destroy sandboxes when a
  `chat_session` is archived. Kill-on-archive requires an API lifecycle hook and is
  deferred with the idle-timeout sweeper / retention-expiry job.

## Streaming Task Output

Running Codex inside a sandbox does not cost real-time streaming. E2B is not the
bottleneck; the runner-to-API transport is.

End-to-end chain:

```text
codex exec --json (in sandbox)
  -> stdout JSONL events, line by line
  -> E2B SDK onStdout/onStderr stream callbacks (runner process)
  -> parse each line -> task_message
  -> [runner -> API transport: see options]
  -> API persists task_message + relays via sendSse events endpoint
  -> UI trace/timeline
```

### Sandbox-level streaming is native

E2B command execution exposes real-time `onStdout` / `onStderr` stream callbacks (and
background command handles). `codex exec --json` already emits JSONL events line by
line, and those lines reach the runner through E2B's stream callbacks as they are
produced — the same granularity as a local `child_process` stdout pipe. The exact SDK
method surface must be confirmed against the E2B and Codex versions pinned in the
template (see Open Questions).

### The transport that actually changes is runner -> API

Today the runner is request/response: `runAgent` blocks and returns `events` in a
single batch at completion (`apps/api/src/runner-client.ts`,
`apps/runner/src/fake-runner.ts`). So real-time UI streaming is unsolved even for the
local-spawn path; it requires changing this hop regardless of E2B. Options:

| Option | Approach | Trade-off |
| --- | --- | --- |
| A. runner -> API stream (SSE/NDJSON) | API opens the task; runner emits each parsed `task_message` as it arrives; API persists and relays to the UI via the existing events endpoint | True real-time, best UX; most work |
| B. runner -> API webhook callback | Runner POSTs incremental events back to an API callback URL while running; returns final at the end | Simpler than holding a stream; adds an inbound API endpoint + auth |
| C. incremental DB writes + UI poll (baseline) | Runner stays blocking but writes `task_message` rows to Postgres incrementally; UI polls the existing `GET .../events` | No new transport, near-real-time (seconds); sufficient for the demo |

v0.1.2 baseline is **Option C**: smallest user-facing change, adequate for the demo,
and naturally drop-resilient. This intentionally adds a narrow internal API/runner
contract so the runner can append redacted `task_message` rows while the task is
running. Option A is recorded as a later upgrade.

### Streaming side effects

- **Pause does not conflict with streaming.** Streaming happens while the command
  executes; `finalize` pauses the sandbox only after `final.md` is read.
- **Incremental persistence resists disconnects.** As long as `task_message` rows are
  written as events arrive (Option A or C), a runner crash or dropped connection still
  leaves a partial trace in Postgres. A pure batch return loses the whole trace — which
  is itself the argument for incremental persistence.
- **Runner event writes are internal.** The runner must not receive broad database
  credentials for v0.1.2. Prefer a runner-authenticated API endpoint or a narrowly
  scoped adapter that only appends events for the active task id.

## Two Persistence Layers (E2B vs Postgres)

E2B persistence does not replace `chat_message` or the other product tables. The two
systems persist different things at different layers; they overlap only on conversation
content, and that overlap is intentional.

- **E2B persists the execution substrate:** the sandbox filesystem, including
  working-directory artifacts and Codex's own on-disk session files. Its purpose is
  cheap resume of an in-progress execution.
- **Postgres persists the product source of truth:** `chat_session`, `chat_message`,
  `agent_tasks`, `task_message` — the durable, redacted, queryable record the product
  renders.

Why the product record cannot live only in the sandbox:

1. **Product reads must not boot a sandbox.** Loading a session to display its history
   queries Postgres; it must never require resuming a sandbox (slow and billed).
2. **Codex's on-disk session format is provider-internal.** It has no role / markdown /
   timestamp / task-link structure and is not a clean record to render a UI from.
3. **Lifecycle mismatch loses data.** Paused sandboxes can expire or be evicted
   (workspace-lost), and a sandbox is killed on archive. If history lived only in the
   sandbox, archiving or losing it would erase the user's visible conversation. Postgres
   must survive both.
4. **Resume-failure fallback depends on the separation.** On resume failure the product
   keeps the Postgres history and rebuilds only the sandbox, so the user still sees the
   full conversation.
5. **Security boundary.** Postgres holds redacted, product-visible content; the sandbox
   may hold raw output, secrets in transit, and internal traces.

The conversation context therefore exists at two layers on purpose: the Codex session
inside the sandbox (full-fidelity, for Codex's own reasoning) and `chat_message` rows in
Postgres (redacted, queryable, durable, for display). This is the same reason an app
stores chat history in its own database even when the model provider also holds a thread
object — it is intentional redundancy, not waste.

## Persistence Requirements

Persistence is unchanged from v0.1.1. Postgres remains the source of truth for
`chat_session`, `chat_message`, `agent_tasks`, and `task_message`.

The only semantic note for v0.1.2: `chat_session.work_dir` stores the E2B sandbox id,
and `chat_session.session_id` stores the Codex session id. Both remain opaque runner
pointers above the runner boundary.

Acceptance criteria (carried from v0.1.1, reaffirmed):

- Restarting the API does not erase chat sessions, messages, or task history.
- `chat_session.session_id` / `work_dir` survive API restart.
- A follow-up message resumes the prior sandbox + Codex session when the sandbox
  still exists.
- If the sandbox is gone, the user receives a clear fresh-session recovery outcome.

## Security and Redaction Requirements

- Runtime API keys remain request-only.
- The model API key is injected into the sandbox as a command-scoped environment
  variable only for the current Codex execution. E2B supports both sandbox-level
  `envs` on `Sandbox.create(...)` and command-level `envs` on
  `sandbox.commands.run(...)`; v0.1.2 must use command-level `envs` for runtime
  model credentials so the key is not deliberately attached to the long-lived sandbox
  environment.
- E2B documents command-scoped `envs` as scoped to the command but not private in the
  sandbox OS. Treat the sandbox as trusted execution infrastructure for the duration
  of the run, and verify that Codex does not persist the key into files, config,
  shell history, logs, raw output, task messages, or returned pointers before pause.
- The API key must not be written into `chat_session`, `chat_message`, `agent_tasks`,
  `task_message`, sandbox metadata, or returned pointers.
- Raw runner output is redacted before persistence.
- User-visible assistant messages are redacted before persistence.
- The sandbox's permission posture is kept out of the UI.
- The runner documents current sandbox limitations and the E2B trust boundary.

## Configuration and Deployment

New / changed configuration:

- `RUNNER_MODE`: `fake` | `e2b` (the `codex` value is removed).
- `E2B_API_KEY`: credential for the E2B API (runner service only).
- `E2B_TEMPLATE_ID`: id of the custom template with Codex preinstalled.
- `RUN_TIMEOUT_MS`: still governs per-execution timeout.
- Internal runner event auth/config: a runner-only token or equivalent mechanism for
  appending incremental `task_message` rows through the API.

Deployment notes:

- The runner service no longer needs a persistent volume; per-session state lives in
  E2B. The runner only needs outbound network access to the E2B API.
- The E2B template (`e2b.Dockerfile` + `e2b.toml`) is built and published as a
  separate, versioned step from the runner image.
- Railway topology is otherwise unchanged: Web/API, Runner, Postgres.

## Testing Requirements

### Shared

- Unchanged v0.1.1 contract tests continue to pass.

### Runner

- `fake` runner behavior unchanged: deterministic `session_id`, `work_dir`, assistant
  Markdown, and task messages.
- `buildCodexCommand` pure-function tests: first-turn command and resume command
  shapes.
- `resolveSandbox` tests against a mocked E2B client: create branch (no `workDir`),
  resume branch (valid `workDir`), and workspace-lost branch (resume throws).
- `execInSandbox` reports `session_id` / `work_dir` without leaking the API key.
- `execInSandbox` passes model credentials through command-scoped E2B `envs`, not
  sandbox-level global `envs`.
- Secret-residue smoke: after a Codex run and before pause, scan expected Codex
  config/session/log locations and shell history files in the sandbox for the runtime
  API key; the key must not be present.
- Non-zero exit, timeout, and empty-final-output handling.
- Resume failure falls back to a fresh sandbox when safe and does not wipe an
  existing pointer pair unless the fallback establishes a fresh `session_id` for the
  fresh sandbox.

### API

- Unchanged v0.1.1 public API tests continue to pass.
- Internal runner event-ingest tests cover auth, task ownership, redaction, ordered
  append semantics, and rejection of writes to terminal tasks.
- Workspace-lost fallback tests verify the API never persists a fresh sandbox id with
  an old Codex session id.

### UI

- Unchanged v0.1.1 UI tests continue to pass.

### Deployment

- E2B template builds and publishes.
- Local fake-mode chat smoke passes.
- E2B-mode chat smoke passes with valid E2B and model credentials.
- A follow-up turn resumes the prior sandbox + Codex session in a deployed
  environment.

## Documentation Requirements

Update or add docs for:

- E2B account setup, `E2B_API_KEY`, and template build/publish flow.
- The custom Codex template (`e2b.Dockerfile`, `e2b.toml`) and version pinning.
- Switching `RUNNER_MODE` from `fake` to `e2b`.
- E2B-mode first-turn and resume smoke test.
- Sandbox lifecycle (pause on completion; archive cleanup deferred) and cost
  expectations.
- E2B trust boundary and sandbox limitations.
- Runtime model credential injection: command-scoped E2B `envs`, why global sandbox
  `envs` are avoided for user-provided API keys, and the secret-residue smoke check.
- Troubleshooting:
  - E2B auth/quota failures.
  - template build failures or Codex missing in the template.
  - invalid model endpoint.
  - resume failure / sandbox expired.
  - timeout.
  - empty final output.

## Open Questions

- Exact Codex resume mechanism inside the sandbox: `codex exec resume <id>` versus the
  app-server `thread/resume` protocol — confirm against the Codex version pinned in
  the template.
- Should `finalize` pause synchronously within the request, or pause asynchronously
  after returning the response to reduce turn latency?
- Should the runner cap concurrent live sandboxes to bound E2B cost, or rely on the
  per-session model plus pause-on-completion alone for v0.1.2?
- Where should the template build/publish step live in CI, and how is
  `E2B_TEMPLATE_ID` propagated to the runner service?
- Confirm the E2B SDK streaming surface (`onStdout` / `onStderr` callbacks, background
  command handles) and the Codex `--json` event schema against the versions pinned in
  the template before implementing Option C's incremental `task_message` parsing.
- Confirm the Codex CLI environment variable name for the pinned template
  (`CODEX_API_KEY` in E2B's Codex guide versus `OPENAI_API_KEY` in the current local
  runner), including how to pass a custom model endpoint.

## Suggested Implementation Slices

1. E2B template: `e2b.Dockerfile` + `e2b.toml` with Codex preinstalled and pinned.
2. `buildCodexCommand` pure function (first-turn + resume) with tests.
3. `resolveSandbox` create/resume/workspace-lost with a mocked E2B client.
4. `execInSandbox` + `finalize`: run Codex, read final output, pause, redact.
5. Wire `RUNNER_MODE=e2b` into the runner entrypoint; remove the local-spawn path.
6. Lifecycle: pause on completion, resume-failure fallback, archive cleanup deferred.
7. Config, deployment docs, and smoke tests.

These slices are not a full implementation plan. A separate plan should break them
into test-first tasks with exact file edits and verification commands.
