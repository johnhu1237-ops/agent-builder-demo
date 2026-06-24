# Local Smoke Test

## Start services

```bash
RUNNER_MODE=fake pnpm dev
```

Expected ports:

- Web: http://localhost:5173
- API: http://localhost:4001
- Runner: http://localhost:4101

## Check health

```bash
pnpm smoke:health
```

Expected:

```json
{"ok":true}{"ok":true,"runnerMode":"fake"}
```

## UI path

1. Open http://localhost:5173.
2. Confirm the workspace opens directly to Agent Builder.
3. Enter any API key value, such as `sk-local-fake`.
4. Keep `Research RunwayML and produce a concise company profile.` as the task.
5. Click `Run agent`.
6. Confirm a Markdown report appears.
7. Click `Export Agent Spec`.
8. Confirm the copied JSON does not contain the API key.
