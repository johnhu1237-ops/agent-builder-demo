# Configurable Code Agent Builder Demo Design

Date: 2026-06-24

## Summary

Build a Railway-deployable v0.1 demo for a configurable code-agent builder. The first version focuses on one editable Research Agent, a real remote Codex CLI runner, configurable model credentials, mock app/skill configuration, and a Markdown final report.

The product UI must not expose that Codex CLI is the underlying runner. Users configure and run an agent; the runner implementation remains an internal service boundary.

## Goals

- Prove an end-to-end agent builder flow: configure agent, enter task, run, view final output.
- Deploy the demo on Railway with a dedicated runner worker.
- Use Codex CLI as the real internal code-agent runtime.
- Let the user configure model provider, model name, API endpoint, and API key.
- Keep the user-facing result simple: render the runner's final Markdown output.
- Show apps, skills, and abilities as product concepts without integrating real MCP apps yet.
- Keep v0.1 small enough to implement quickly and evolve later into multi-agent CRUD.

## Non-Goals

- Multi-agent create/edit/delete management.
- Real MCP app integrations.
- OAuth or third-party app credentials.
- Permission policy UI or approval flows.
- Artifact browser, file tree viewer, or diff viewer.
- Structured JSON report parsing.
- Visual workflow canvas.
- User auth, multi-tenancy, billing, RBAC, or audit retention.
- Production-grade sandboxing.
- Exposing or switching the underlying runner runtime in the UI.

## Product Scope

v0.1 has a single Research Agent. The user can edit:

- Agent name.
- Agent description/persona.
- System prompt.
- Model provider.
- Model name.
- API endpoint.
- API key.
- Enabled mock apps.
- Enabled skills.
- Enabled abilities.
- Task prompt for the current run.

The first real task type is web research that produces a Markdown report. The user prompt is the run goal. Agent identity does not include a separate `goal` field.

Mock apps are configuration-only in v0.1. They demonstrate the future MCP-style plugin model but do not start real MCP servers or add real external tools.

## Design Language

Use `DESIGN.md` as the UI reference. The installed design system is RunwayML-inspired: editorial, monochrome, restrained, and information-dense.

Apply it to this operational tool as follows:

- Prefer a white or near-white workspace, black primary actions, neutral text, and hairline dividers.
- Use restrained typography and generous spacing without turning the app into a marketing page.
- Keep controls compact and scannable.
- Avoid gradients, glow effects, decorative blobs, and saturated accent-heavy palettes.
- Use black pill buttons for primary actions.
- Use simple bordered panels and dividers instead of dark nested cards.
- Keep the first screen as the actual builder workspace, not a landing page.

The existing `agent-builder-demo.html` is the interaction reference: builder configuration on the main surface and a run console for testing. The final implementation should adapt that structure to the RunwayML-inspired visual language rather than copying the current dark theme.

## Architecture

The system has three main boundaries.

### Builder UI

The UI renders the single Research Agent workspace. It owns form state, client validation, task input, run initiation, trace display, and Markdown result rendering.

The UI shows product concepts:

- Agent identity.
- System prompt.
- Model configuration.
- Apps.
- Skills.
- Abilities.
- Run trace.
- Final Markdown output.
- Agent Spec export.

The UI does not show:

- Codex CLI.
- CLI runner selection.
- Runtime adapter names.
- Permission internals.
- Raw artifacts as a primary concept.

### Web/API Orchestrator

The API validates the Agent Spec and task, creates run records, sends run requests to the runner worker, receives run events, stores final output, and serves updates to the UI.

Recommended v0.1 persistence:

- Postgres on Railway for run records and non-sensitive agent config.
- API keys are not persisted in v0.1. They are accepted for the current run and passed to the runner through a secure internal request path.

If implementation speed requires it, persistence can temporarily start with in-memory state, but the design target is Railway Postgres.

### Runner Worker

The runner is a separate Railway service built from a Dockerfile. It preinstalls Codex CLI and runs agent tasks in isolated per-run workspaces.

Responsibilities:

- Receive validated run request from API.
- Create a temporary workspace.
- Materialize the agent instructions and task into a runner prompt.
- Inject model configuration and API key for the run.
- Execute Codex CLI through an internal `CodexRunnerAdapter`.
- Capture event stream, stdout/stderr, exit code, timeout, and final message.
- Return final Markdown output to the API.

The runner is an implementation detail. The product remains "agent builder", not "Codex wrapper".

## Agent Spec

The Agent Spec is the shared contract between UI, API, and runner.

Example shape:

```json
{
  "version": "0.1",
  "identity": {
    "name": "Research Agent",
    "description": "Researches companies, products, or markets and writes concise Markdown reports.",
    "persona": "Careful research analyst"
  },
  "systemPrompt": "You are a careful research agent. Use available web research capability. Do not fabricate facts. Produce a concise Markdown report.",
  "model": {
    "provider": "openai-compatible",
    "name": "gpt-5",
    "apiEndpoint": "https://api.openai.com/v1",
    "apiKeyRef": "runtime-only"
  },
  "apps": [
    { "id": "mock-github", "enabled": false, "mode": "configuration-only" },
    { "id": "mock-slack", "enabled": false, "mode": "configuration-only" },
    { "id": "mock-notion", "enabled": false, "mode": "configuration-only" }
  ],
  "skills": [
    { "id": "research-synthesis", "enabled": true },
    { "id": "source-citation", "enabled": true },
    { "id": "executive-summary", "enabled": true }
  ],
  "abilities": [
    { "id": "web-research", "enabled": true }
  ],
  "output": {
    "format": "markdown"
  }
}
```

Exported Agent Specs must not include the raw API key. They may include `apiKeyRef: "runtime-only"` or omit the key field entirely.

## Run Request

Each run combines:

- Agent Spec snapshot.
- Runtime-only API key.
- User task prompt.

The task prompt is the goal for that run. It is not part of agent identity.

Example:

```json
{
  "agentSpec": "...",
  "runtimeSecrets": {
    "apiKey": "runtime-only"
  },
  "task": "Research RunwayML as a company and produce a concise competitor profile."
}
```

## Run Record

Each run stores:

- `id`
- `task`
- `status`: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `canceled`
- `agentSpecSnapshot`
- `traceEvents`
- `finalMarkdown`
- `rawOutput` or raw log reference for debugging
- `startedAt`
- `completedAt`
- `error`

The UI uses `finalMarkdown` as the primary output. Raw output is internal/debug-only in v0.1.

## Run Lifecycle

1. User edits the Research Agent configuration.
2. User enters API key and task prompt.
3. UI validates required fields.
4. API validates Agent Spec and task.
5. API creates a run record.
6. API sends the run request to Runner Worker.
7. Runner creates a per-run workspace.
8. Runner materializes a prompt from system prompt, enabled skills, mock app context, web research ability, and task.
9. Runner executes Codex CLI.
10. Runner streams simple status events back to API.
11. Runner writes or captures the final Codex message.
12. API stores `finalMarkdown`.
13. UI renders final Markdown output.

## Codex Runner

The internal adapter is `CodexRunnerAdapter`.

Target command shape:

```bash
codex \
  --search \
  --ask-for-approval never \
  exec \
  --json \
  --model "$MODEL_NAME" \
  --sandbox danger-full-access \
  --skip-git-repo-check \
  --output-last-message final.md \
  -C "$RUN_WORKSPACE" \
  "$MATERIALIZED_PROMPT"
```

Implementation details may change if Codex CLI configuration requires provider-specific environment variables or config file overrides. The design requirement is that the UI can provide:

- Model provider.
- Model name.
- API endpoint.
- API key.

The runner must map those inputs into the Codex execution environment without exposing runner internals to the user.

### Runner Security Assumption

v0.1 deliberately runs with broad CLI permissions to reduce friction:

- `danger-full-access`
- no interactive approval
- web search enabled
- optional bypass flags if required by the deployed Codex CLI version

This is acceptable only because the runner is deployed as an isolated Railway service with per-run temporary workspaces and timeouts. It must not share a writable filesystem with the main application or contain unrelated secrets.

Fine-grained permissions and approval flows are deferred to a later phase.

## UI Requirements

### Workspace

The first screen is the actual builder workspace. It should include:

- Product title.
- Single selected Research Agent.
- Save/export actions where useful.
- Configuration panels.
- Run console.

### Profile

Fields:

- Agent name.
- Description/persona.
- System prompt.

No separate agent `goal` field.

### Model

Fields:

- Provider selector.
- Model name input/select.
- API endpoint input.
- API key password input.

API key messaging should be clear: v0.1 uses it for the current run and does not persist it.

### Apps, Skills, Abilities

Apps:

- Mock GitHub.
- Mock Slack.
- Mock Notion or CRM.

These are configuration-only and should be labeled accordingly.

Skills:

- Research synthesis.
- Source citation.
- Executive summary.

Abilities:

- Web Research, enabled by default and treated as the real v0.1 capability.

### Run Console

Fields and states:

- Task prompt textarea.
- Run button.
- Running/disabled state.
- Simple trace timeline.
- Error display.
- Markdown final output.

Trace should stay understandable:

- Queued.
- Starting runner.
- Researching.
- Generating report.
- Completed.
- Failed/timed out.

### Export Agent Spec

The user can export the current Agent Spec as JSON. The export must exclude the raw API key.

## API Requirements

Minimum API surface:

- `GET /api/agent/default`
- `PUT /api/agent/default`
- `POST /api/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events` or equivalent SSE endpoint

The exact routing can change based on framework choice, but the boundary should remain:

- agent config endpoint
- run creation endpoint
- run status/event endpoint

## Plugin Registry v0.1

The registry can be static in code for v0.1.

It should define:

- Mock app metadata.
- Skill metadata and instruction text.
- Ability metadata.

The registry must reject unknown IDs during validation.

This boundary is important because future MCP apps can be added without rewriting runner orchestration.

## Error Handling

User-facing errors:

- Missing task prompt.
- Missing API key.
- Missing model name.
- Invalid API endpoint.
- Runner unavailable.
- Run timed out.
- Run failed.
- Empty final output.

Developer/debug details:

- raw stdout/stderr.
- exit code.
- internal adapter error.
- workspace path or object key.

Debug details should not dominate the primary UI.

## Testing

### Unit Tests

- Agent Spec validation accepts valid config.
- Agent Spec validation rejects unknown app/skill/ability IDs.
- Agent Spec export omits API key.
- Prompt materialization includes system prompt, task, enabled skills, mock app context, and web research ability.
- Prompt materialization excludes disabled apps/skills.

### Runner Tests

- Fake runner emits deterministic events and final Markdown.
- Runner timeout marks run as `timed_out`.
- Runner failure marks run as `failed`.
- Empty final output returns a useful error.

### API Tests

- Creating a run validates required fields.
- Run status moves through expected lifecycle.
- Final Markdown is stored and returned.
- Runtime-only API key is not persisted in run record or Agent Spec export.

### UI Tests

- User can edit agent profile.
- User can edit model fields.
- User sees API key non-persistence hint.
- User can enable/disable mock apps and skills.
- User can submit a task.
- UI renders Markdown final output.
- UI shows validation errors for missing task/API key.

### Manual Smoke Test

On Railway:

1. Deploy Web/API and Runner Worker.
2. Enter model config and API key.
3. Run a company research task.
4. Confirm status events appear.
5. Confirm final Markdown report renders.
6. Confirm exported Agent Spec excludes API key.

## Deployment

Railway-first deployment:

- `web` service: UI and API Orchestrator.
- `runner` service: Dockerfile Worker with Codex CLI installed.
- `postgres` service: run records and non-sensitive agent config.

The runner service needs:

- Node/runtime dependencies required by Codex CLI.
- Codex CLI installed.
- Ability to make outbound network calls for model API and web search.
- Temporary filesystem for per-run workspaces.
- Timeout configuration.

The web service should call the runner over Railway private networking when possible.

## Future Evolution

### v0.2

- Add real MCP app integration for one low-friction provider.
- Add permissions UI and safer default runner policies.
- Add raw log viewer behind developer mode.
- Persist encrypted API keys or project-level secrets.

### v0.3

- Evolve from single agent to C-lite:
  - create agent
  - duplicate agent
  - edit agent
  - delete agent
  - seed agents
  - run history per agent
- Store agent versions or run-time Agent Spec snapshots for explainability.

### Later

- Real multi-user auth.
- Production sandboxing.
- Kubernetes jobs or stronger isolation.
- Marketplace-style app registry.
- Structured report schemas.
- Multi-runtime support, still hidden behind product-level abstractions.

## Open Implementation Questions

- Exact framework choice for UI/API.
- Exact Codex CLI environment variables or config overrides for custom API endpoints.
- Whether v0.1 starts with Postgres immediately or uses temporary in-memory persistence for the first local prototype.
- Whether run events stream through SSE, WebSocket, or polling.

These are implementation planning questions, not product scope blockers.
