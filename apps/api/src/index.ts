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
import { agentTaskMcpGatewayEndpoint, getRunnerEventToken, requireRunnerEventAuth, runnerEventEndpoint } from "./runner-event-auth";
import { runChatMigrations } from "./chat-migrations";
import { PgChatStore, type ToolConfiguration } from "./chat-store";
import { redactSecrets } from "./redaction";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";
import { decryptApiKey, validateEncryptionKey } from "./encryption";
import { TaskEventBroadcaster } from "./task-events";
import { ArcadeApiToolExecutor, type ExternalToolExecutor } from "./external-tool-executor";

export type ApiDependencies = Partial<RunnerClient> & {
  chatStore?: PgChatStore;
  externalToolExecutor?: ExternalToolExecutor;
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

function bearerToken(req: express.Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function mcpToolCallParams(body: unknown): { name: string; args: unknown } | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") {
    return null;
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }
  return {
    name: name.trim(),
    args: (params as { arguments?: unknown }).arguments ?? {}
  };
}

const gatewayToolDefinitions = {
  github_create_issue: {
    name: "github_create_issue",
    description: "Create a GitHub issue through the product MCP gateway.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" }
      },
      required: ["title"]
    }
  },
  slack_post_message: {
    name: "slack_post_message",
    description: "Post a Slack message through the product MCP gateway.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        text: { type: "string" }
      },
      required: ["channel", "text"]
    }
  },
  notion_create_page: {
    name: "notion_create_page",
    description: "Create a Notion page through the product MCP gateway.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" }
      },
      required: ["title"]
    }
  }
} as const;

function toolsForToolConfigurations(toolConfigurations: ToolConfiguration[]) {
  return toolConfigurations
    .filter((toolConfiguration) => toolConfiguration.mode !== "disabled")
    .map((toolConfiguration) => gatewayToolDefinitions[toolConfiguration.toolName as keyof typeof gatewayToolDefinitions])
    .filter((tool): tool is (typeof gatewayToolDefinitions)[keyof typeof gatewayToolDefinitions] => Boolean(tool));
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
  agentTaskLease: {
    id: string;
    token: string;
  };
}): Promise<void> {
  const { chatStore, runnerClient, taskEvents, detail, task, message, apiKey, agentSpec, agentTaskLease } = params;
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
      mcpGatewayUrl: agentTaskMcpGatewayEndpoint(),
      agentTaskLeaseId: agentTaskLease.id,
      agentTaskLeaseToken: agentTaskLease.token,
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
      await chatStore.revokeAgentTaskLeases(task.id);
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
      await chatStore.revokeAgentTaskLeases(task.id);
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
    await chatStore.revokeAgentTaskLeases(task.id);
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
  const externalToolExecutor = deps.externalToolExecutor ?? new ArcadeApiToolExecutor();

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

  app.get("/api/agents/:id/tool-configurations", async (req, res) => {
    const agent = await chatStore.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json(stableError("Agent not found"));
      return;
    }
    res.json(await chatStore.listToolConfigurationsForAgent(req.params.id));
  });

  app.patch("/api/agents/:id/tool-configurations/:toolConfigurationId", async (req, res) => {
    const mode = String(req.body.mode ?? "");
    if (!["auto", "ask_each_time", "disabled"].includes(mode)) {
      res.status(400).json(stableError("Tool Configuration mode must be auto, ask_each_time, or disabled"));
      return;
    }

    try {
      const updated = await chatStore.updateToolConfigurationMode({
        agentId: req.params.id,
        toolConfigurationId: req.params.toolConfigurationId,
        mode: mode as "auto" | "ask_each_time" | "disabled"
      });
      res.json(updated);
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
      const agentTaskLease = await chatStore.issueAgentTaskLease(task.id);

      const runningTask = (await chatStore.markAgentTaskRunning(task.id)) ?? task;

      const execution = executeAgentTask({
        chatStore,
        runnerClient,
        taskEvents,
        detail,
        task: runningTask,
        message,
        apiKey,
        agentSpec: validation.data,
        agentTaskLease
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

  app.post("/mcp/agent-task", async (req, res) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json(stableError("Agent Task Lease bearer token is required"));
      return;
    }

    const lease = await chatStore.validateAgentTaskLease(token);
    if (!lease) {
      res.status(401).json(stableError("Invalid or expired Agent Task Lease"));
      return;
    }

    const id = req.body?.id ?? null;
    const method = String(req.body?.method ?? "");
    if (method === "initialize") {
      res.json(
        jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-builder", version: "0.1.0" }
        })
      );
      return;
    }

    if (method === "tools/list") {
      const toolConfigurations = await chatStore.listToolConfigurationsForAgent(lease.agentId);
      res.json(jsonRpcResult(id, { tools: toolsForToolConfigurations(toolConfigurations) }));
      return;
    }

    if (method === "tools/call") {
      const toolCall = mcpToolCallParams(req.body);
      if (!toolCall) {
        res.status(400).json(jsonRpcError(id, -32602, "Invalid tools/call params"));
        return;
      }

      const toolConfiguration = await chatStore.getToolConfigurationForAgentTool(lease.agentId, toolCall.name);
      if (!toolConfiguration || toolConfiguration.connectedAccountStatus !== "connected") {
        await chatStore.recordToolCallAudit({
          agentTaskId: lease.agentTaskId,
          chatSessionId: lease.chatSessionId,
          agentId: lease.agentId,
          connectedAccountId: toolConfiguration?.connectedAccountId ?? null,
          provider: toolConfiguration?.appId ?? "unknown",
          mcpToolName: toolCall.name,
          providerToolName: toolConfiguration?.toolName ?? null,
          mode: toolConfiguration?.mode ?? null,
          args: toolCall.args,
          status: "denied",
          error: "Tool is not available to this Agent Task"
        });
        res.json(jsonRpcError(id, -32602, "Tool is not available to this Agent Task"));
        return;
      }

      if (toolConfiguration.mode !== "auto") {
        await chatStore.recordToolCallAudit({
          agentTaskId: lease.agentTaskId,
          chatSessionId: lease.chatSessionId,
          agentId: lease.agentId,
          connectedAccountId: toolConfiguration.connectedAccountId,
          provider: toolConfiguration.appId,
          mcpToolName: toolCall.name,
          providerToolName: toolConfiguration.toolName,
          mode: toolConfiguration.mode,
          args: toolCall.args,
          status: toolConfiguration.mode === "ask_each_time" ? "confirmation_required" : "denied",
          error:
            toolConfiguration.mode === "ask_each_time"
              ? "Tool confirmation is required"
              : "Tool is disabled for this Agent"
        });
        res.json(
          jsonRpcError(
            id,
            -32602,
            toolConfiguration.mode === "ask_each_time"
              ? "Tool confirmation is required"
              : "Tool is disabled for this Agent"
          )
        );
        return;
      }

      try {
        const execution = await externalToolExecutor.executeTool({
          arcadeUserId: toolConfiguration.externalAccountId,
          provider: toolConfiguration.appId,
          mcpToolName: toolCall.name,
          providerToolName: toolConfiguration.toolName,
          args: toolCall.args
        });
        await chatStore.recordToolCallAudit({
          agentTaskId: lease.agentTaskId,
          chatSessionId: lease.chatSessionId,
          agentId: lease.agentId,
          connectedAccountId: toolConfiguration.connectedAccountId,
          provider: toolConfiguration.appId,
          mcpToolName: toolCall.name,
          providerToolName: toolConfiguration.toolName,
          mode: toolConfiguration.mode,
          args: toolCall.args,
          status: "executed",
          error: null
        });
        res.json(jsonRpcResult(id, execution));
      } catch (error) {
        const message = error instanceof Error ? error.message : "External tool execution failed";
        await chatStore.recordToolCallAudit({
          agentTaskId: lease.agentTaskId,
          chatSessionId: lease.chatSessionId,
          agentId: lease.agentId,
          connectedAccountId: toolConfiguration.connectedAccountId,
          provider: toolConfiguration.appId,
          mcpToolName: toolCall.name,
          providerToolName: toolConfiguration.toolName,
          mode: toolConfiguration.mode,
          args: toolCall.args,
          status: "failed",
          error: message
        });
        res.json(jsonRpcError(id, -32603, message));
      }
      return;
    }

    res.status(400).json(jsonRpcError(id, -32601, "Method not found"));
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

  app.post("/internal/agent-task-leases/:id/bind-sandbox", async (req, res) => {
    if (!requireRunnerEventAuth(req)) {
      res.status(401).json(stableError("Unauthorized runner event request"));
      return;
    }

    const sandboxId = String(req.body?.sandboxId ?? "").trim();
    if (!sandboxId) {
      res.status(400).json(stableError("sandboxId is required"));
      return;
    }

    const result = await chatStore.bindAgentTaskLeaseSandbox(req.params.id, sandboxId);
    if (result === "bound") {
      res.status(202).json({ ok: true });
      return;
    }
    if (result === "conflict") {
      res.status(409).json(stableError("Agent Task Lease is already bound to a different sandbox"));
      return;
    }
    res.status(404).json(stableError("Agent Task Lease not found"));
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
