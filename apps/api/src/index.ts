import cors from "cors";
import express from "express";
import { Pool } from "pg";
import {
  defaultAgentSpec,
  exportAgentSpec,
  validateAgentSpec,
  type AgentSpec,
  type AgentTaskStatus
} from "@agent-builder/shared";
import { runChatMigrations } from "./chat-migrations";
import { PgChatStore } from "./chat-store";
import { redactSecrets } from "./redaction";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";

export type ApiDependencies = Partial<RunnerClient> & {
  chatStore?: PgChatStore;
};

let currentAgentSpec: AgentSpec = defaultAgentSpec;

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
    if (persisted) currentAgentSpec = persisted;
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.put("/api/agent/default", async (req, res) => {
    const validation = validateAgentSpec(req.body);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    currentAgentSpec = await chatStore.saveDefaultAgentSpec(validation.data);
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.post("/api/chat-sessions", async (req, res) => {
    const validation = validateAgentSpec(req.body.agentSpec ?? currentAgentSpec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    const session = await chatStore.createChatSession({
      agentSpec: validation.data,
      title: String(req.body.title ?? validation.data.identity.name)
    });
    res.status(201).json({ ...session, agentSpecSnapshot: publicAgentSpec(session.agentSpecSnapshot) });
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

    const validation = validateAgentSpec(req.body.agentSpec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }

    const message = String(req.body.message ?? "").trim();
    const apiKey = String(req.body.runtimeSecrets?.apiKey ?? "").trim();
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
        message,
        agentSpec: validation.data,
        runtimeSecrets: { apiKey },
        sessionId: detail.sessionId,
        workDir: detail.workDir
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
