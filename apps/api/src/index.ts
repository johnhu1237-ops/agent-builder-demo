import cors from "cors";
import express from "express";
import { Pool } from "pg";
import {
  exportAgentSpec,
  validateAgentSpec,
  type AgentSpec,
  type AgentTaskStatus,
  type CreateAgentRequest,
  type RunnerTaskEventRequest,
  type UpdateAgentRequest
} from "@agent-builder/shared";
import { getRunnerEventToken, requireRunnerEventAuth, runnerEventEndpoint } from "./runner-event-auth";
import { runChatMigrations } from "./chat-migrations";
import { PgChatStore } from "./chat-store";
import { redactSecrets } from "./redaction";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";

export type ApiDependencies = Partial<RunnerClient> & {
  chatStore?: PgChatStore;
};

function publicAgentSpec(spec: AgentSpec): AgentSpec {
  const exported = exportAgentSpec(spec);
  const { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...model } = exported.model;
  return { ...exported, model };
}

function stableError(message: string) {
  return { error: message };
}

function statusFromError(message: string): Exclude<AgentTaskStatus, "pending" | "running" | "completed" | "cancelled"> {
  return message.toLowerCase().includes("timed out") ? "timed_out" : "failed";
}

export function createApiApp(deps: ApiDependencies = {}) {
  const app = express();
  const chatStore = deps.chatStore;
  if (!chatStore) {
    throw new Error("createApiApp requires a PgChatStore. Use createProductionApiApp for process startup.");
  }
  const runnerClient: RunnerClient = {
    runAgentTask:
      deps.runAgentTask ??
      createHttpRunnerClient(process.env.RUNNER_BASE_URL ?? "http://localhost:4101").runAgentTask
  };

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/agent/default", async (_req, res) => {
    const persisted = await chatStore.getDefaultAgentSpec();
    res.json(publicAgentSpec(persisted));
  });

  app.put("/api/agent/default", async (req, res) => {
    const validation = validateAgentSpec(req.body);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    const saved = await chatStore.saveDefaultAgentSpec(validation.data);
    res.json(publicAgentSpec(saved));
  });

  // Agent CRUD

  app.post("/api/agents", async (req, res) => {
    const rawSpec = req.body.spec;
    const apiKey = req.body.apiKey;
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json(stableError("apiKey is required"));
      return;
    }
    let input: CreateAgentRequest;
    if (rawSpec === undefined) {
      input = { apiKey };
    } else {
      const validation = validateAgentSpec(rawSpec);
      if (!validation.success) {
        res.status(400).json(stableError(validation.error.message));
        return;
      }
      input = { spec: validation.data, apiKey };
    }
    const agent = await chatStore.createAgent(input);
    res.status(201).json({ ...agent, spec: publicAgentSpec(agent.spec) });
  });

  app.get("/api/agents", async (_req, res) => {
    const agents = await chatStore.listAgents();
    res.json(agents.map((a) => ({ ...a, spec: publicAgentSpec(a.spec) })));
  });

  app.get("/api/agents/:id", async (req, res) => {
    const agent = await chatStore.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json(stableError("Agent not found"));
      return;
    }
    res.json({ ...agent, spec: publicAgentSpec(agent.spec) });
  });

  app.put("/api/agents/:id", async (req, res) => {
    const validation = validateAgentSpec(req.body.spec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    const input: UpdateAgentRequest = { spec: validation.data };
    if (req.body.apiKey && typeof req.body.apiKey === "string") {
      input.apiKey = req.body.apiKey;
    }
    try {
      const agent = await chatStore.updateAgent(req.params.id, input);
      res.json({ ...agent, spec: publicAgentSpec(agent.spec) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      res.status(message.includes("not found") ? 404 : 500).json(stableError(message));
    }
  });

  app.post("/api/chat-sessions", async (req, res) => {
    const agentId = String(req.body.agentId ?? "").trim();
    if (!agentId) {
      res.status(404).json(stableError("Agent not found"));
      return;
    }
    try {
      const session = await chatStore.createChatSession({
        agentId,
        title: req.body.title
      });
      res.status(201).json(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Creation failed";
      res.status(message.includes("not found") ? 404 : 500).json(stableError(message));
    }
  });

  app.get("/api/chat-sessions", async (_req, res) => {
    res.json(await chatStore.listChatSessions());
  });

  app.get("/api/chat-sessions/:id", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }
    res.json(detail);
  });

  app.post("/api/chat-sessions/:id/messages", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }

    const agent = await chatStore.getAgent(detail.agentId);
    if (!agent) {
      res.status(500).json(stableError("Agent not found for this session"));
      return;
    }

    const apiKey = String(req.body.runtimeSecrets?.apiKey ?? "").trim();
    const agentSpec: AgentSpec = {
      ...agent.spec,
      model: {
        ...agent.spec.model,
        apiKey
      }
    };

    const validation = validateAgentSpec(agentSpec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }

    const message = String(req.body.message ?? "").trim();
    if (!message) {
      res.status(400).json(stableError("Message is required"));
      return;
    }
    if (!apiKey) {
      res.status(400).json(stableError("API key is required"));
      return;
    }

    const userMessage = await chatStore.createChatMessage({
      chatSessionId: detail.id,
      role: "user",
      contentMarkdown: redactSecrets(message, [apiKey]),
      taskId: null
    });
    const task = await chatStore.createAgentTask({
      chatSessionId: detail.id,
      triggerMessageId: userMessage.id,
      agentSpec: validation.data
    });

    await chatStore.markAgentTaskRunning(task.id);

    try {
      const result = await runnerClient.runAgentTask({
        chatSessionId: detail.id,
        taskId: task.id,
        message,
        agentSpec: validation.data,
        runtimeSecrets: { apiKey },
        sessionId: detail.sessionId,
        workDir: detail.workDir,
        runnerEvents: getRunnerEventToken()
          ? {
              endpoint: runnerEventEndpoint(),
              token: getRunnerEventToken()!
            }
          : null
      });
      if (result.status === "completed" && result.finalMarkdown.trim()) {
        await chatStore.completeAgentTask(task.id, {
          status: "completed",
          resultMarkdown: redactSecrets(result.finalMarkdown, [apiKey]),
          rawOutputRedacted: redactSecrets(result.rawOutputRedacted, [apiKey]),
          sessionId: result.sessionId,
          workDir: result.workDir,
          taskMessages: result.taskMessages.map((item) => ({
            ...item,
            content: redactSecrets(item.content, [apiKey]),
            output: item.output ? redactSecrets(item.output, [apiKey]) : null
          }))
        });
      } else {
        await chatStore.failAgentTask(task.id, {
          status: result.status === "timed_out" ? "timed_out" : "failed",
          error: result.finalMarkdown || "Runner did not produce assistant content",
          rawOutputRedacted: redactSecrets(result.rawOutputRedacted, [apiKey]),
          sessionId: result.sessionId,
          workDir: result.workDir,
          taskMessages: result.taskMessages.map((item) => ({
            ...item,
            content: redactSecrets(item.content, [apiKey]),
            output: item.output ? redactSecrets(item.output, [apiKey]) : null
          }))
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Runner failed";
      await chatStore.failAgentTask(task.id, {
        status: statusFromError(messageText),
        error: redactSecrets(messageText, [apiKey]),
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: [
          { type: "error", tool: null, content: redactSecrets(messageText, [apiKey]), inputJson: null, output: null }
        ]
      });
      const failedDetail = await chatStore.getChatSessionDetail(detail.id);
      res.status(500).json(failedDetail);
      return;
    }

    res.status(201).json(await chatStore.getChatSessionDetail(detail.id));
  });

  app.get("/api/chat-sessions/:id/events", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }
    res.json({ task: detail.latestTask, taskMessages: detail.taskMessages });
  });

  app.get("/api/agent-tasks/:id", async (_req, res) => {
    res.status(501).json(stableError("Use GET /api/chat-sessions/:id for v0.1.1 task details"));
  });

  app.post("/internal/runner/task-events", async (req, res) => {
    if (!requireRunnerEventAuth(req)) {
      res.status(401).json(stableError("Unauthorized runner event request"));
      return;
    }

    const body = req.body as RunnerTaskEventRequest;
    if (!body.taskId?.trim() || !Array.isArray(body.messages)) {
      res.status(400).json(stableError("taskId and messages are required"));
      return;
    }

    try {
      await chatStore.appendRunnerTaskMessages(body.taskId, body.messages, body.secretValues ?? []);
      res.status(202).json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to append runner task events";
      res.status(message.includes("terminal task") ? 409 : 404).json(stableError(message));
    }
  });

  return app;
}

async function createProductionApiApp() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for v0.1.1 chat persistence");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  await runChatMigrations(pool);
  return createApiApp({ chatStore: new PgChatStore(pool) });
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT ?? 4001);
  createProductionApiApp()
    .then((app) => {
      app.listen(port, () => {
        console.log(`api listening on ${port}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
