import cors from "cors";
import express from "express";
import { validateAgentSpec, type CreateRunRequest } from "@agent-builder/shared";
import { runCodexAgent } from "./codex-runner";
import { runFakeAgent } from "./fake-runner";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.RUNNER_PORT ?? 4101);
const runnerMode = process.env.RUNNER_MODE ?? "fake";
const timeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 120000);

app.get("/health", (_req, res) => {
  res.json({ ok: true, runnerMode });
});

app.post("/run", async (req, res) => {
  const body = req.body as CreateRunRequest;
  const validation = validateAgentSpec(body.agentSpec);

  if (!validation.success) {
    res.status(400).json({ error: validation.error.message });
    return;
  }

  if (!body.task?.trim()) {
    res.status(400).json({ error: "Task prompt is required" });
    return;
  }

  if (!body.runtimeSecrets?.apiKey?.trim()) {
    res.status(400).json({ error: "API key is required" });
    return;
  }

  try {
    const result =
      runnerMode === "codex"
        ? await runCodexAgent({ ...body, agentSpec: validation.data }, timeoutMs)
        : await runFakeAgent({ ...body, agentSpec: validation.data });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Runner failed" });
  }
});

app.listen(port, () => {
  console.log(`runner listening on ${port}`);
});
