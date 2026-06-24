# Railway Deployment

## Services

Create two Railway services from the same repository.

### Web/API service

- Dockerfile: `Dockerfile.web`
- Start command: default Docker CMD
- Variables:
  - `API_PORT=4001`
  - `RUNNER_BASE_URL=http://<runner-private-domain>:4101`

### Runner service

- Dockerfile: `Dockerfile.runner`
- Start command: default Docker CMD
- Variables:
  - `RUNNER_PORT=4101`
  - `RUNNER_MODE=codex`
  - `RUN_TIMEOUT_MS=120000`

## First deployment smoke test

1. Open the public Web/API service URL.
2. Confirm the Agent Builder workspace loads.
3. Enter model provider, model name, API endpoint, and API key.
4. Run a company research task.
5. Confirm final Markdown output renders.
6. Export Agent Spec and confirm it excludes the API key.

## Fallback deployment mode

Set `RUNNER_MODE=fake` on the runner service if Codex credentials or endpoint mapping need debugging. This keeps the UI/API demo usable while the real runner is repaired.

## v0.1.1 Services

- Web: Vite static build served from `apps/web`.
- API: Express service with `DATABASE_URL` and `RUNNER_BASE_URL`.
- Runner: Express service with `RUNNER_MODE=fake` or `RUNNER_MODE=codex`.
- Postgres: required for chat sessions, messages, tasks, and task messages.

## Required API Variables

```dotenv
DATABASE_URL=<Railway Postgres URL>
RUNNER_BASE_URL=<runner service URL>
API_PORT=4001
```

## Required Runner Variables

```dotenv
RUNNER_PORT=4101
RUNNER_MODE=fake
RUN_TIMEOUT_MS=120000
RUNNER_WORKSPACE_ROOT=/data/agent-builder-workspaces
```

Codex resume requires persistent runner storage. Without a persistent volume, chat messages still persist in Postgres, but workspace-backed resume can fail after runner restart. In that case the runner records the resume failure and starts a fresh session when safe.
