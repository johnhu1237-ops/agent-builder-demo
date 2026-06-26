import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec, type Agent, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";
import { createApiApp } from "../index";

describe("API orchestrator", () => {
  let pool: import("pg").Pool;
  let store: PgChatStore;

  beforeEach(async () => {
    process.env.LLM_API_KEY_ENCRYPTION_KEY = "a".repeat(64);
    const db = newDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await runChatMigrations(pool);
    store = new PgChatStore(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it("returns the default agent without an API key", async () => {
    const app = createApiApp({ chatStore: store });

    const response = await request(app).get("/api/agent/default").expect(200);

    expect(response.body.identity.name).toBe("Research Agent");
    expect(JSON.stringify(response.body)).not.toContain("apiKey");
  });

  it("creates and lists chat sessions", async () => {
    const app = createApiApp({ chatStore: store });

    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const createResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Acme research" })
      .expect(201);

    expect(createResponse.body.title).toBe("Acme research");
    expect(createResponse.body.agentId).toBe(agent.id);
    expect(createResponse.body.agentName).toBe(defaultAgentSpec.identity.name);
    expect(JSON.stringify(createResponse.body)).not.toContain("apiKey");

    const listResponse = await request(app).get("/api/chat-sessions").expect(200);

    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0].id).toBe(createResponse.body.id);
    expect(listResponse.body[0].title).toBe("Acme research");
  });

  it("persists first-turn chat messages, task state, and redacts runtime secrets", async () => {
    const runAgentTask = vi.fn<
      (request: {
        chatSessionId: string;
        message: string;
        agentSpec: typeof defaultAgentSpec;
        runtimeSecrets: { apiKey: string };
        sessionId: string | null;
        workDir: string | null;
      }) => Promise<RunnerAgentTaskResponse>
    >().mockResolvedValue({
      status: "completed",
      finalMarkdown: "Done without exposing sk-test",
      rawOutputRedacted: "raw output with sk-test",
      sessionId: "runner-session-1",
      workDir: "/tmp/session-1",
      taskMessages: [
        {
          type: "status",
          tool: null,
          content: "Started with sk-test",
          inputJson: { apiKey: "sk-test", nested: { token: "sk-test", note: "keep me" } },
          output: "tool output sk-test"
        }
      ]
    });
    const app = createApiApp({ chatStore: store, runAgentTask });

    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "First turn" })
      .expect(201);

    const messageResponse = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        message: "Use sk-test to inspect Acme."
      })
      .expect(201);

    expect(runAgentTask).toHaveBeenCalledTimes(1);
    expect(runAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: sessionResponse.body.id,
        message: "Use sk-test to inspect Acme.",
        runtimeSecrets: { apiKey: "sk-test" },
        sessionId: null,
        workDir: null
      })
    );
    const callArgs = runAgentTask.mock.calls[0]![0];
    expect(callArgs.agentSpec.identity.name).toBe(defaultAgentSpec.identity.name);
    expect(callArgs.agentSpec.model.apiKey).toBe("sk-test");

    expect(messageResponse.body.messages).toHaveLength(2);
    expect(messageResponse.body.messages[0].role).toBe("user");
    expect(messageResponse.body.messages[0].contentMarkdown).toContain("[REDACTED]");
    expect(messageResponse.body.messages[1].role).toBe("assistant");
    expect(messageResponse.body.latestTask.status).toBe("completed");
    expect(messageResponse.body.latestTask.sessionId).toBe("runner-session-1");
    expect(messageResponse.body.latestTask.workDir).toBe("/tmp/session-1");
    expect(JSON.stringify(messageResponse.body)).not.toContain("sk-test");

    const detailResponse = await request(app)
      .get(`/api/chat-sessions/${sessionResponse.body.id}`)
      .expect(200);

    expect(detailResponse.body.sessionId).toBe("runner-session-1");
    expect(detailResponse.body.workDir).toBe("/tmp/session-1");
    expect(detailResponse.body.messages).toHaveLength(2);
    expect(detailResponse.body.messages[0].role).toBe("user");
    expect(detailResponse.body.messages[1].role).toBe("assistant");
    expect(detailResponse.body.latestTask.status).toBe("completed");
    expect(detailResponse.body.taskMessages).toHaveLength(1);
    expect(detailResponse.body.taskMessages[0].content).toContain("[REDACTED]");
    expect(JSON.stringify(detailResponse.body)).not.toContain("sk-test");
  });

  it("passes existing session pointers to the runner on follow-up messages", async () => {
    const runAgentTask = vi
      .fn()
      .mockResolvedValueOnce({
        status: "completed",
        finalMarkdown: "First reply",
        rawOutputRedacted: "first raw output",
        sessionId: "runner-session-1",
        workDir: "/tmp/session-1",
        taskMessages: []
      } satisfies RunnerAgentTaskResponse)
      .mockResolvedValueOnce({
        status: "completed",
        finalMarkdown: "Second reply",
        rawOutputRedacted: "second raw output",
        sessionId: "runner-session-1",
        workDir: "/tmp/session-1",
        taskMessages: []
      } satisfies RunnerAgentTaskResponse);
    const app = createApiApp({ chatStore: store, runAgentTask });

    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Follow-up session" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        message: "First turn"
      })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        message: "Second turn"
      })
      .expect(201);

    expect(runAgentTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatSessionId: sessionResponse.body.id,
        message: "Second turn",
        sessionId: "runner-session-1",
        workDir: "/tmp/session-1"
      })
    );
  });

  it("rejects message creation when the agent has no api key configured", async () => {
    const app = createApiApp({ chatStore: store });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    await pool.query(`update agents set encrypted_api_key = null where id = $1`, [agent.id]);
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "No key session" })
      .expect(201);

    const response = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Tell me about Acme." })
      .expect(400);

    expect(response.body.error).toBe(
      "Agent API key not configured. Please update the agent settings."
    );
  });

  it("decrypts the stored key just-in-time and passes it to the runner", async () => {
    const runAgentTask = vi.fn().mockResolvedValue({
      status: "completed",
      finalMarkdown: "Done",
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: []
    } satisfies RunnerAgentTaskResponse);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-stored" });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Decrypt JIT" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Hello" })
      .expect(201);

    expect(runAgentTask.mock.calls[0]![0].runtimeSecrets).toEqual({ apiKey: "sk-stored" });
    expect(runAgentTask.mock.calls[0]![0].agentSpec.model.apiKey).toBe("sk-stored");
  });

  it("returns 500 with a clear message when decryption fails", async () => {
    const app = createApiApp({ chatStore: store });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    await pool.query(`update agents set encrypted_api_key = 'corrupted' where id = $1`, [agent.id]);
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Corrupt key" })
      .expect(201);

    const response = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Hello" })
      .expect(500);

    expect(response.body.error).toBe("Failed to decrypt API key for agent");
  });

  it("passes task id and runner event target to the runner", async () => {
    process.env.RUNNER_EVENT_TOKEN = "runner-token";
    process.env.API_PUBLIC_BASE_URL = "http://api.internal:4001";
    const runAgentTask = vi.fn().mockResolvedValue({
      status: "completed",
      finalMarkdown: "Done",
      rawOutputRedacted: "",
      sessionId: "runner-session-1",
      workDir: "sandbox-1",
      taskMessages: []
    } satisfies RunnerAgentTaskResponse);
    const app = createApiApp({ chatStore: store, runAgentTask });

    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Runner event target" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        message: "Run with events."
      })
      .expect(201);

    expect(runAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.any(String),
        runnerEvents: {
          endpoint: "http://api.internal:4001/internal/runner/task-events",
          token: "runner-token"
        }
      })
    );
  });

  it("authenticates and persists internal runner task events", async () => {
    process.env.RUNNER_EVENT_TOKEN = "runner-token";
    const app = createApiApp({ chatStore: store });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const session = await store.createChatSession({
      agentId: agent.id,
      title: "Internal event ingest"
    });
    const trigger = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run task.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: trigger.id,
      agentSpec: defaultAgentSpec
    });
    await store.markAgentTaskRunning(task.id);

    await request(app)
      .post("/internal/runner/task-events")
      .set("authorization", "Bearer runner-token")
      .send({
        taskId: task.id,
        secretValues: ["sk-test"],
        messages: [{ type: "status", tool: null, content: "streamed sk-test", inputJson: null, output: null }]
      })
      .expect(202);

    await request(app)
      .post("/internal/runner/task-events")
      .set("authorization", "Bearer wrong-token")
      .send({
        taskId: task.id,
        messages: [{ type: "status", tool: null, content: "rejected", inputJson: null, output: null }]
      })
      .expect(401);

    const detail = await store.getChatSessionDetail(session.id);
    expect(detail?.taskMessages).toHaveLength(1);
    expect(detail?.taskMessages[0].content).toBe("streamed [REDACTED]");
  });

  describe("agent CRUD endpoints", () => {
    it("rejects creating an agent without an api key", async () => {
      const app = createApiApp({ chatStore: store });
      const res = await request(app).post("/api/agents").send({ spec: defaultAgentSpec }).expect(400);
      expect(res.body.error).toBe("API key is required");
    });

    it("returns hasApiKey true and never leaks key material", async () => {
      const app = createApiApp({ chatStore: store });
      const res = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-secret" })
        .expect(201);
      expect(res.body.hasApiKey).toBe(true);
      expect(res.body.encryptedApiKey).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("sk-secret");
    });

    it("creates an agent via POST /api/agents", async () => {
      const app = createApiApp({ chatStore: store });

      const res = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" })
        .expect(201);

      const agent = res.body as Agent;
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe(defaultAgentSpec.identity.name);
      // apiKey and apiKeyRef must not leak in HTTP responses
      const model = agent.spec.model as Record<string, unknown>;
      expect(model.apiKey).toBeUndefined();
      expect(model.apiKeyRef).toBeUndefined();
    });

    it("creates an agent with default spec when no body provided", async () => {
      const app = createApiApp({ chatStore: store });

      const res = await request(app)
        .post("/api/agents")
        .send({ apiKey: "sk-test" })
        .expect(201);

      expect(res.body.name).toBe(defaultAgentSpec.identity.name);
    });

    it("lists agents via GET /api/agents", async () => {
      const app = createApiApp({ chatStore: store });

      await request(app).post("/api/agents").send({ spec: defaultAgentSpec, apiKey: "sk-test" });
      await request(app).post("/api/agents").send({
        spec: { ...defaultAgentSpec, identity: { name: "Agent 2", description: "Second" } },
        apiKey: "sk-test"
      });

      const res = await request(app).get("/api/agents").expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("gets an agent by id via GET /api/agents/:id", async () => {
      const app = createApiApp({ chatStore: store });

      const created = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const res = await request(app)
        .get(`/api/agents/${created.body.id}`)
        .expect(200);

      expect(res.body.name).toBe(defaultAgentSpec.identity.name);
    });

    it("returns 400 for invalid agent spec on create", async () => {
      const app = createApiApp({ chatStore: store });

      await request(app)
        .post("/api/agents")
        .send({ spec: { invalid: true }, apiKey: "sk-test" })
        .expect(400);
    });

    it("updates an agent via PUT /api/agents/:id", async () => {
      const app = createApiApp({ chatStore: store });

      const created = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const res = await request(app)
        .put(`/api/agents/${created.body.id}`)
        .send({
          spec: {
            ...defaultAgentSpec,
            identity: { name: "Updated", description: "Updated description" }
          }
        })
        .expect(200);

      expect(res.body.name).toBe("Updated");
      expect(res.body.description).toBe("Updated description");
    });

    it("returns 404 for nonexistent agent update", async () => {
      const app = createApiApp({ chatStore: store });

      await request(app)
        .put("/api/agents/nonexistent")
        .send({ spec: defaultAgentSpec })
        .expect(404);
    });
  });

  describe("agent-bound session creation via API", () => {
    it("creates a chat session bound to an agent id", async () => {
      const app = createApiApp({ chatStore: store });

      const agent = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const res = await request(app)
        .post("/api/chat-sessions")
        .send({ agentId: agent.body.id, title: "API test chat" })
        .expect(201);

      expect(res.body.agentId).toBe(agent.body.id);
      expect(res.body.agentName).toBe(defaultAgentSpec.identity.name);
    });

    it("returns 404 when creating a session without agentId", async () => {
      const app = createApiApp({ chatStore: store });

      await request(app)
        .post("/api/chat-sessions")
        .send({ title: "No agent" })
        .expect(404); // Agent not found
    });
  });

  describe("live-spec message sending", () => {
    it("sends a message without agentSpec in the request body", async () => {
      const runAgentTask = vi.fn<
        (request: {
          chatSessionId: string;
          message: string;
          agentSpec: typeof defaultAgentSpec;
          runtimeSecrets: { apiKey: string };
          sessionId: string | null;
          workDir: string | null;
        }) => Promise<RunnerAgentTaskResponse>
      >().mockResolvedValue({
        status: "completed",
        finalMarkdown: "# Done",
        rawOutputRedacted: "raw",
        sessionId: null,
        workDir: null,
        taskMessages: []
      });
      const app = createApiApp({ chatStore: store, runAgentTask });

      const agent = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const session = await request(app)
        .post("/api/chat-sessions")
        .send({ agentId: agent.body.id, title: "Live spec test" });

      const res = await request(app)
        .post(`/api/chat-sessions/${session.body.id}/messages`)
        .send({ message: "Hello" })
        .expect(201);

      expect(res.body).toBeTruthy();
    });

    it("uses the latest agent spec from the DB, not a stale one", async () => {
      const runAgentTask = vi.fn().mockResolvedValue({
        status: "completed",
        finalMarkdown: "Done",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: []
      } satisfies RunnerAgentTaskResponse);
      const app = createApiApp({ chatStore: store, runAgentTask });

      const agent = await request(app)
        .post("/api/agents")
        .send({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const session = await request(app)
        .post("/api/chat-sessions")
        .send({ agentId: agent.body.id, title: "Spec drift test" });

      // Update the agent spec AFTER creating the session
      await request(app)
        .put(`/api/agents/${agent.body.id}`)
        .send({
          spec: {
            ...defaultAgentSpec,
            identity: { name: "Renamed Agent", description: "Renamed" },
            systemPrompt: "Updated system prompt"
          }
        })
        .expect(200);

      await request(app)
        .post(`/api/chat-sessions/${session.body.id}/messages`)
        .send({ message: "Hi" })
        .expect(201);

      const calledAgentSpec = runAgentTask.mock.calls[0]![0].agentSpec;
      expect(calledAgentSpec.identity.name).toBe("Renamed Agent");
      expect(calledAgentSpec.systemPrompt).toBe("Updated system prompt");
      expect(calledAgentSpec.model.apiKey).toBe("sk-test");
    });
  });
});
