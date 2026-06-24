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

## Deployment

See `docs/railway-deployment.md`.
