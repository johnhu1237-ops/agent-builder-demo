import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";
import { createApiApp } from "../index";

describe("API orchestrator", () => {
  let pool: import("pg").Pool;
  let store: PgChatStore;

  beforeEach(async () => {
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

    const createResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "Acme research" })
      .expect(201);

    expect(createResponse.body.title).toBe("Acme research");
    expect(createResponse.body.agentSpecSnapshot.identity.name).toBe(defaultAgentSpec.identity.name);
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

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "First turn" })
      .expect(201);

    const messageResponse = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        agentSpec: defaultAgentSpec,
        message: "Use sk-test to inspect Acme.",
        runtimeSecrets: { apiKey: "sk-test" }
      })
      .expect(201);

    expect(runAgentTask).toHaveBeenCalledTimes(1);
    expect(runAgentTask).toHaveBeenCalledWith({
      chatSessionId: sessionResponse.body.id,
      message: "Use sk-test to inspect Acme.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      sessionId: null,
      workDir: null
    });

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

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "Follow-up session" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        agentSpec: defaultAgentSpec,
        message: "First turn",
        runtimeSecrets: { apiKey: "sk-test" }
      })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        agentSpec: defaultAgentSpec,
        message: "Second turn",
        runtimeSecrets: { apiKey: "sk-test" }
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

  it("rejects message creation without a runtime API key", async () => {
    const app = createApiApp({ chatStore: store });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "No key session" })
      .expect(201);

    const response = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        agentSpec: defaultAgentSpec,
        message: "Tell me about Acme.",
        runtimeSecrets: { apiKey: "" }
      })
      .expect(400);

    expect(response.body.error).toBe("API key is required");
  });
});
