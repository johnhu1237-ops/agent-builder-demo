# Agent Builder Demo

Railway-ready v0.1 demo for a configurable code-agent builder.

## What it proves

- Configure one Research Agent.
- Configure model provider, model name, API endpoint, and runtime-only API key.
- Toggle mock apps and skills.
- Run a task through a hidden runner boundary.
- Render final Markdown output.

## Local development

```bash
pnpm install
RUNNER_MODE=fake pnpm dev
```

Open http://localhost:5173.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | prod | Postgres connection string for chat persistence. |
| `LLM_API_KEY_ENCRYPTION_KEY` | yes | Master key for encrypting LLM API keys at rest. Must be a 64-character hex string (32 bytes). Generate with `openssl rand -hex 32`. **Back this up securely — losing it means losing access to all stored API keys.** The server refuses to start without it. |

## Deployment

See `docs/railway-deployment.md`.
