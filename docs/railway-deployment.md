# Railway Deployment

## Services

Two application services from the same repository, plus the Postgres plugin
(see [ADR-0006](adr/0006-api-serves-web-spa-as-combined-service.md) — the Web/API
service serves the built SPA, so there is no separate static web service).

Each service pins its own Dockerfile via a config file:

- Web/API service → config `railway.web.json` (`Dockerfile.web`)
- Runner service → config `railway.runner.json` (`Dockerfile.runner`)

`PORT` is injected by Railway on every service; the code prefers it over
`API_PORT` / `RUNNER_PORT`, so leave `PORT` unset in the UI.

### Web/API service

- Config: `railway.web.json` (`Dockerfile.web`)
- Start command: default Docker CMD (serves the API + the built `apps/web/dist` SPA)
- Variables:
  - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  - `RUNNER_BASE_URL=http://<runner-private-domain>:8080`
  - `API_PUBLIC_BASE_URL=https://<web-api-public-domain>` — handed to the E2B
    sandbox for the MCP gateway; must be publicly reachable.
  - `API_INTERNAL_BASE_URL=http://<web-api-private-domain>:8080` — used for
    runner→API callbacks (task-event append and Agent Task Lease sandbox bind).
    See [ADR-0007](adr/0007-dual-base-urls-for-runner-and-e2b-callbacks.md).
  - `LLM_API_KEY_ENCRYPTION_KEY` — `openssl rand -hex 32`. **Non-rotatable**:
    back it up off-Railway. Losing it means losing access to all stored API keys.
  - `TOOL_CONFIRMATION_HMAC_SECRET` — `openssl rand -hex 32`.
  - `RUNNER_EVENT_TOKEN` — a Railway shared/reference variable so the Web/API and
    Runner services hold the same value.
  - Arcade: `ARCADE_API_KEY`, `ARCADE_USER_ID`, `ARCADE_GITHUB_PROVIDER_ID`.
  - Do **not** set `VITE_API_BASE_URL`: the SPA is same-origin and calls the API
    with a relative base URL.

### Runner service

- Config: `railway.runner.json` (`Dockerfile.runner`)
- Start command: default Docker CMD
- Variables:
  - `RUNNER_MODE=fake` — deploy fake first; flip to `e2b` once the chain is green.
  - `RUN_TIMEOUT_MS=120000`
  - `RUNNER_EVENT_TOKEN` — the same shared/reference variable as the Web/API service.
  - `E2B_API_KEY`, `E2B_TEMPLATE_ID` — only when `RUNNER_MODE=e2b`.

### Why the two base URLs cannot be collapsed

The runner runs inside Railway and reaches the API over the private network
(`API_INTERNAL_BASE_URL`); routing its callbacks over the public reverse proxy
produced a `502 / api-upstream-unavailable` during sandbox bind. The E2B sandbox
runs outside Railway and can only reach the API over the public internet
(`API_PUBLIC_BASE_URL`). See ADR-0007.

## First deployment (fake-first)

1. Add the Postgres plugin; reference it as `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Deploy both services with `RUNNER_MODE=fake`.
3. Open the public Web/API URL and confirm the Agent Builder workspace loads
   (the SPA is served by the API, same-origin).
4. Enter model provider, model name, API endpoint, and API key.
5. Run a task; confirm final Markdown renders and task events stream in.
6. Export Agent Spec and confirm it excludes the API key.
7. Once green, set `RUNNER_MODE=e2b` (with `E2B_API_KEY` / `E2B_TEMPLATE_ID`) on
   the runner and redeploy.

## Fallback deployment mode

Set `RUNNER_MODE=fake` on the runner service if E2B credentials or endpoint
mapping need debugging. This keeps the UI/API demo usable while the real runner
is repaired.

## Persistent runner storage

E2B/codex resume benefits from persistent runner storage
(`RUNNER_WORKSPACE_ROOT=/data/agent-builder-workspaces` on a mounted volume).
Without a persistent volume, chat messages still persist in Postgres, but
workspace-backed resume can fail after a runner restart — the runner records the
resume failure and starts a fresh session when safe.
