# Local Smoke Test

## Requirements

- Node 22+
- pnpm
- Docker
- Postgres reachable through `DATABASE_URL`

## Start Postgres

```bash
docker run --rm --name agent-builder-postgres -p 54329:5432 -e POSTGRES_PASSWORD=agent_builder -e POSTGRES_DB=agent_builder postgres:16
```

Use:

```bash
export DATABASE_URL=postgres://postgres:agent_builder@localhost:54329/agent_builder
```

## Start Services

```bash
RUNNER_MODE=fake DATABASE_URL=$DATABASE_URL pnpm dev
```

Open `http://localhost:5173`.

## Fake Chat Smoke

1. Enter any non-empty API key.
2. Send `Research RunwayML and produce a concise company profile.`
3. Confirm the message list shows the user message and a Markdown assistant response.
4. Send `Continue with competitors.`
5. Confirm the timeline shows completed task events.
6. Restart the API and confirm the chat session still appears.

## Codex Chat Smoke

```bash
RUNNER_MODE=codex RUNNER_WORKSPACE_ROOT=/tmp/agent-builder-workspaces DATABASE_URL=$DATABASE_URL pnpm dev
```

Use a valid API key in the UI. Send a first message, then a follow-up. The follow-up should reuse the saved `session_id` and `work_dir` when the runner workspace still exists.
