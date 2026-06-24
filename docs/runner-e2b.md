# E2B Runner

## Required Environment

- `RUNNER_MODE=e2b`
- `E2B_API_KEY`: E2B API key for the runner service.
- `E2B_TEMPLATE_ID`: published template id for `e2b.Dockerfile`.
- `RUN_TIMEOUT_MS`: per Codex execution timeout, default `120000`.
- `RUNNER_EVENT_TOKEN`: shared secret used by the runner to append incremental task events through the API.
- `API_PUBLIC_BASE_URL`: API base URL reachable by the runner for `/internal/runner/task-events`.

## Template Build

Build and publish the template with the E2B CLI after authenticating to E2B:

```bash
e2b template build
```

Record the published template id in `E2B_TEMPLATE_ID`.

## Runtime Model Credentials

The end user provides the model API key per chat request. The API forwards it to the runner as `runtimeSecrets.apiKey`. The runner passes it to the E2B command with command-scoped `envs`:

```ts
envs: {
  OPENAI_API_KEY: runtimeSecrets.apiKey,
  OPENAI_BASE_URL: agentSpec.model.apiEndpoint
}
```

Do not put user-provided model keys in `Sandbox.create({ envs })`, E2B metadata, template files, prompts, command arguments, or logs. Command-scoped `envs` are scoped to the command, but they are visible inside the sandbox process environment while the command runs. Treat E2B as trusted execution infrastructure for the duration of execution.

## Secret Residue Smoke

After an E2B smoke run, inspect the sandbox before pause in a debug build and confirm the runtime key is absent from:

- `/home/user/workspace`
- Codex config and session directories
- shell history files
- runner raw output
- persisted `task_message` rows

## Lifecycle

v0.1.2 pauses sandboxes after each run and resumes them by sandbox id on follow-up turns. If a sandbox is gone, the runner creates a fresh sandbox and must establish a fresh Codex session id before updating `chat_session` pointers.

Archive cleanup is deferred in v0.1.2. Do not add kill-on-archive behavior in this release.

## Verification Notes

- Unit tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Fake smoke: `pnpm smoke:health` with `RUNNER_MODE=fake`
- E2B smoke: first turn and follow-up turn in deployed environment with valid E2B and model credentials
