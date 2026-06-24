import cors from "cors";
import express from "express";
import { validateAgentSpec, type CreateAgentTaskRequest } from "@agent-builder/shared";
import { runE2BAgentTask } from "./e2b-runner";
import { runFakeAgentTask } from "./fake-runner";
import { redactRunnerOutput } from "./redaction";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.RUNNER_PORT ?? 4101);
const runnerMode = process.env.RUNNER_MODE ?? "fake";
const timeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 120000);

app.get("/health", (_req, res) => {
  res.json({ ok: true, runnerMode });
});

app.post("/agent-tasks", async (req, res) => {
  const body = req.body as CreateAgentTaskRequest;
  const validation = validateAgentSpec(body.agentSpec);

  if (!validation.success) {
    res.status(400).json({ error: validation.error.message });
    return;
  }
  if (!body.chatSessionId?.trim()) {
    res.status(400).json({ error: "chatSessionId is required" });
    return;
  }
  if (!body.message?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }
  if (!body.runtimeSecrets?.apiKey?.trim()) {
    res.status(400).json({ error: "API key is required" });
    return;
  }

  try {
    const request = { ...body, agentSpec: validation.data };
    const result =
      runnerMode === "e2b"
        ? await runE2BAgentTask(request, { timeoutMs, templateId: process.env.E2B_TEMPLATE_ID })
        : await runFakeAgentTask(request);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner failed";
    res.status(500).json({
      error: redactRunnerOutput(message, [body.runtimeSecrets?.apiKey ?? ""])
    });
  }
});

app.listen(port, () => {
  console.log(`runner listening on ${port}`);
});
