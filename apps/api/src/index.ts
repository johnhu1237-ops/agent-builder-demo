import cors from "cors";
import express from "express";
import { Pool } from "pg";
import {
  exportAgentSpec,
  isTerminalTaskStatus,
  validateAgentSpec,
  type AgentSpec,
  type AgentTask,
  type AgentTaskStatus,
  type ChatSessionDetail,
  type CreateAgentRequest,
  type RunnerTaskEventRequest,
  type TaskMessageEvent,
  type TaskSnapshotEvent,
  type TaskTerminalEvent,
  type UpdateAgentRequest
} from "@agent-builder/shared";
import { getRunnerEventToken, requireRunnerEventAuth, runnerEventEndpoint } from "./runner-event-auth";
import { runChatMigrations } from "./chat-migrations";
import { PgChatStore } from "./chat-store";
import { redactSecrets } from "./redaction";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";
import { decryptApiKey, validateEncryptionKey } from "./encryption";
import { TaskEventBroadcaster } from "./task-events";

export type ApiDependencies = Partial<RunnerClient> & {
  chatStore?: PgChatStore;
};

function publicAgentSpec(spec: AgentSpec): AgentSpec {
  const exported = exportAgentSpec(spec);
  const { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...model } = exported.model;
  return { ...exported, model };
}

function publicAgent(agent: { encryptedApiKey?: string | null; spec: AgentSpec; [key: string]: unknown }) {
  const { encryptedApiKey: _encryptedApiKey, spec, ...rest } = agent;
  return { ...rest, spec: publicAgentSpec(spec) };
}

function stableError(message: string) {
  return { error: message };
}

function statusFromError(message: string): Exclude<AgentTaskStatus, "pending" | "running" | "completed" | "cancelled"> {
  return message.toLowerCase().includes("timed out") ? "timed_out" : "failed";
}

function sendSse(res: express.Response, event: string, data: unknown, id?: string): void {
  if (id !== undefined) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function lastEventSeq(req: express.Request): number | null {
  const raw = req.header("last-event-id");
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function terminalSseEventName(status: TaskTerminalEvent["status"]): "task_completed" | "task_failed" | "task_cancelled" {
  if (status === "completed") {
    return "task_completed";
  }
  if (status === "cancelled") {
    return "task_cancelled";
  }
  return "task_failed";
}

async function executeAgentTask(params: {
  chatStore: PgChatStore;
  runnerClient: RunnerClient;
  taskEvents: TaskEventBroadcaster;
  detail: ChatSessionDetail;
  task: AgentTask;
  message: string;
  apiKey: string;
  agentSpec: AgentSpec;
}): Promise<void> {
  const { chatStore, runnerClient, taskEvents, detail, task, message, apiKey, agentSpec } = params;
  const publishTerminal = (finalTask: AgentTask) => {
    taskEvents.publish(detail.id, {
      type: "terminal",
      payload: {
        taskId: finalTask.id,
        status: finalTask.status as TaskTerminalEvent["status"],
        error: finalTask.error
      }
    });
  };
  try {
    const result = await runnerClient.runAgentTask({
      chatSessionId: detail.id,
      taskId: task.id,
      message,
      agentSpec,
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
      const finalTask = await chatStore.completeAgentTask(task.id, {
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
      publishTerminal(finalTask);
    } else {
      const finalTask = await chatStore.failAgentTask(task.id, {
        status: result.status === "timed_out" ? "timed_out" : "failed",
        error: redactSecrets(result.finalMarkdown || "Runner did not produce assistant content", [apiKey]),
        rawOutputRedacted: redactSecrets(result.rawOutputRedacted, [apiKey]),
        sessionId: result.sessionId,
        workDir: result.workDir,
        taskMessages: result.taskMessages.map((item) => ({
          ...item,
          content: redactSecrets(item.content, [apiKey]),
          output: item.output ? redactSecrets(item.output, [apiKey]) : null
        }))
      });
      publishTerminal(finalTask);
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Runner failed";
    const finalTask = await chatStore.failAgentTask(task.id, {
      status: statusFromError(messageText),
      error: redactSecrets(messageText, [apiKey]),
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: [
        { type: "error", tool: null, content: redactSecrets(messageText, [apiKey]), inputJson: null, output: null }
      ]
    });
    publishTerminal(finalTask);
  }
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

  const pendingTaskExecutions = new Set<Promise<void>>();
  app.locals.pendingTaskExecutions = pendingTaskExecutions;

  const sendingSessions = new Set<string>();

  const taskEvents = new TaskEventBroadcaster();
  app.locals.taskEvents = taskEvents;

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
    const apiKey = String(req.body.apiKey ?? "").trim();
    if (!apiKey) {
      res.status(400).json(stableError("API key is required"));
      return;
    }
    const rawSpec = req.body.spec;
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
    res.status(201).json(publicAgent(agent));
  });

  app.get("/api/agents", async (_req, res) => {
    const agents = await chatStore.listAgents();
    res.json(agents.map((a) => publicAgent(a)));
  });

  app.get("/api/agents/:id", async (req, res) => {
    const agent = await chatStore.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json(stableError("Agent not found"));
      return;
    }
    res.json(publicAgent(agent));
  });

  app.put("/api/agents/:id", async (req, res) => {
    const validation = validateAgentSpec(req.body.spec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    const apiKey = String(req.body.apiKey ?? "").trim();
    const input: UpdateAgentRequest = apiKey
      ? { spec: validation.data, apiKey }
      : { spec: validation.data };
    try {
      const agent = await chatStore.updateAgent(req.params.id, input);
      res.json(publicAgent(agent));
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

    if (detail.latestTask && !isTerminalTaskStatus(detail.latestTask.status)) {
      res
        .status(409)
        .json(stableError("A task is already running in this chat session."));
      return;
    }

    if (sendingSessions.has(detail.id)) {
      res
        .status(409)
        .json(stableError("A task is already running in this chat session."));
      return;
    }
    sendingSessions.add(detail.id);

    try {
      const agent = await chatStore.getAgent(detail.agentId);
      if (!agent) {
        res.status(500).json(stableError("Agent not found for this session"));
        return;
      }

      if (!agent.encryptedApiKey) {
        res
          .status(400)
          .json(stableError("Agent API key not configured. Please update the agent settings."));
        return;
      }

      const message = String(req.body.message ?? "").trim();
      if (!message) {
        res.status(400).json(stableError("Message is required"));
        return;
      }

      let apiKey: string;
      try {
        apiKey = decryptApiKey(agent.encryptedApiKey);
      } catch (error) {
        console.error(`Decryption failed for agent ${agent.id}:`, error);
        res.status(500).json(stableError("Failed to decrypt API key for agent"));
        return;
      }

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

      const runningTask = (await chatStore.markAgentTaskRunning(task.id)) ?? task;

      const execution = executeAgentTask({
        chatStore,
        runnerClient,
        taskEvents,
        detail,
        task: runningTask,
        message,
        apiKey,
        agentSpec: validation.data
      });
      const tracked = execution
        .catch((error) => {
          console.error(`Background agent task ${task.id} failed:`, error);
        })
        .finally(() => {
          pendingTaskExecutions.delete(tracked);
        });
      pendingTaskExecutions.add(tracked);

      res.status(202).json({
        chatSessionId: detail.id,
        userMessage,
        task: runningTask,
        eventsUrl: `/api/chat-sessions/${detail.id}/events`
      });
    } finally {
      sendingSessions.delete(detail.id);
    }
  });

  app.get("/api/chat-sessions/:id/events", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const lastSeenSeq = lastEventSeq(req);
    const replayTaskMessages =
      lastSeenSeq == null
        ? detail.taskMessages
        : detail.taskMessages.filter((message) => message.seq > lastSeenSeq);

    const snapshot: TaskSnapshotEvent = { task: detail.latestTask, taskMessages: replayTaskMessages };
    sendSse(res, "task_snapshot", snapshot);

    for (const msg of replayTaskMessages) {
      const event: TaskMessageEvent = { taskId: msg.taskId, seq: msg.seq, taskMessage: msg };
      sendSse(res, "task_message", event, String(msg.seq));
    }

    const latestTask = detail.latestTask;
    if (latestTask && isTerminalTaskStatus(latestTask.status)) {
      const terminal: TaskTerminalEvent = {
        taskId: latestTask.id,
        status: latestTask.status as TaskTerminalEvent["status"],
        error: latestTask.error
      };
      sendSse(res, terminalSseEventName(terminal.status), terminal);
      res.end();
      return;
    }

    const unsubscribe = taskEvents.subscribe(detail.id, (event) => {
      if (event.type === "task_message") {
        sendSse(res, "task_message", event.payload, String(event.payload.seq));
      } else if (event.type === "terminal") {
        sendSse(res, terminalSseEventName(event.payload.status), event.payload);
        unsubscribe();
        res.end();
      }
    });

    req.on("close", () => {
      unsubscribe();
    });
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
      const { chatSessionId, messages: inserted } = await chatStore.appendRunnerTaskMessages(
        body.taskId,
        body.messages,
        body.secretValues ?? []
      );
      for (const msg of inserted) {
        const event: TaskMessageEvent = { taskId: body.taskId, seq: msg.seq, taskMessage: msg };
        taskEvents.publish(chatSessionId, { type: "task_message", payload: event });
      }
      res.status(202).json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to append runner task events";
      res.status(message.includes("terminal task") ? 409 : 404).json(stableError(message));
    }
  });

  return app;
}

async function createProductionApiApp() {
  validateEncryptionKey();
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
