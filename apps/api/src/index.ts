import cors from "cors";
import express from "express";
import { defaultAgentSpec, exportAgentSpec, validateAgentSpec, type AgentSpec } from "@agent-builder/shared";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";
import { RunStore, statusFromError } from "./run-store";
import { sendSse } from "./sse";

export type ApiDependencies = Partial<RunnerClient> & {
  runStore?: RunStore;
};

let currentAgentSpec: AgentSpec = defaultAgentSpec;

function publicAgentSpec(spec: AgentSpec): AgentSpec {
  const exported = exportAgentSpec(spec);
  const { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...model } = exported.model;
  return { ...exported, model };
}

export function createApiApp(deps: ApiDependencies = {}) {
  const app = express();
  const runStore = deps.runStore ?? new RunStore();
  const runnerClient: RunnerClient = {
    runAgent:
      deps.runAgent ??
      createHttpRunnerClient(process.env.RUNNER_BASE_URL ?? "http://localhost:4101").runAgent
  };

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/agent/default", (_req, res) => {
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.put("/api/agent/default", (req, res) => {
    const validation = validateAgentSpec(req.body);
    if (!validation.success) {
      res.status(400).json({ error: validation.error.message });
      return;
    }
    currentAgentSpec = exportAgentSpec(validation.data);
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.post("/api/runs", async (req, res) => {
    const validation = validateAgentSpec(req.body.agentSpec);
    if (!validation.success) {
      res.status(400).json({ error: validation.error.message });
      return;
    }

    const task = String(req.body.task ?? "").trim();
    const apiKey = String(req.body.runtimeSecrets?.apiKey ?? "").trim();

    if (!task) {
      res.status(400).json({ error: "Task prompt is required" });
      return;
    }

    if (!apiKey) {
      res.status(400).json({ error: "API key is required" });
      return;
    }

    const run = runStore.createQueuedRun({ task, agentSpec: validation.data });

    try {
      runStore.updateRun(run.id, { status: "running" });
      runStore.addEvent(run.id, { type: "starting", message: "Starting runner" });
      const result = await runnerClient.runAgent({
        agentSpec: validation.data,
        runtimeSecrets: { apiKey },
        task
      });
      for (const event of result.events) {
        runStore.addEvent(run.id, event);
      }
      const completed = runStore.updateRun(run.id, {
        status: "succeeded",
        finalMarkdown: result.finalMarkdown,
        rawOutput: result.rawOutput,
        completedAt: new Date().toISOString()
      });
      res.status(201).json(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run failed";
      runStore.addEvent(run.id, { type: "failed", message });
      const failed = runStore.updateRun(run.id, {
        status: statusFromError(message),
        error: message,
        completedAt: new Date().toISOString()
      });
      res.status(500).json(failed);
    }
  });

  app.get("/api/runs/:id", (req, res) => {
    const run = runStore.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  });

  app.get("/api/runs/:id/events", (req, res) => {
    const run = runStore.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    sendSse(res, "snapshot", run.traceEvents);
    res.end();
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT ?? 4001);
  createApiApp().listen(port, () => {
    console.log(`api listening on ${port}`);
  });
}
