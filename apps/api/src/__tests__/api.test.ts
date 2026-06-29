import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec, type Agent, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";
import { createApiApp } from "../index";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainPendingTaskExecutions(app: import("express").Express): Promise<void> {
  await Promise.all([...((app.locals.pendingTaskExecutions as Set<Promise<void>>) ?? [])]);
}

const completedRunnerResult: RunnerAgentTaskResponse = {
  status: "completed",
  finalMarkdown: "Done",
  rawOutputRedacted: "",
  sessionId: null,
  workDir: null,
  taskMessages: []
};

type SseEvent = { event: string; data: unknown; id: string | null };

function parseSseEvents(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      let id: string | null = null;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("id:")) id = line.slice("id:".length).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      const dataRaw = dataLines.join("\n");
      let data: unknown = dataRaw;
      try {
        data = JSON.parse(dataRaw);
      } catch {
        // keep raw string for non-JSON payloads (e.g. keepalive comments)
      }
      return { event, data, id };
    });
}

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

  it("schedules the agent task and returns a 202 scheduled response without awaiting the runner", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Scheduled send" })
      .expect(201);

    const res = await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Use sk-test to inspect Acme." })
      .expect(202);

    expect(res.body.chatSessionId).toBe(sessionResponse.body.id);
    expect(res.body.userMessage.role).toBe("user");
    expect(res.body.userMessage.contentMarkdown).toContain("[REDACTED]");
    expect(JSON.stringify(res.body)).not.toContain("sk-test");
    expect(res.body.task.status).toBe("running");
    expect(res.body.eventsUrl).toBe(`/api/chat-sessions/${sessionResponse.body.id}/events`);

    // Runner has not resolved: no assistant message yet, task still running.
    const detail = await store.getChatSessionDetail(sessionResponse.body.id);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0].role).toBe("user");
    expect(detail?.latestTask?.status).toBe("running");

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
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
      .expect(202);
    await drainPendingTaskExecutions(app);

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

    expect(messageResponse.body.userMessage.role).toBe("user");
    expect(messageResponse.body.userMessage.contentMarkdown).toContain("[REDACTED]");
    expect(messageResponse.body.task.status).toBe("running");
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

  it("persists a concise assistant message when the runner returns a failed task", async () => {
    const runAgentTask = vi.fn().mockResolvedValue({
      status: "failed",
      finalMarkdown: "Codex exited with code 1 and mentioned sk-test in detailed logs",
      rawOutputRedacted: "long raw output sk-test",
      sessionId: "runner-session-1",
      workDir: "/tmp/session-1",
      taskMessages: [
        {
          type: "error",
          tool: null,
          content: "Detailed failure sk-test",
          inputJson: null,
          output: "stack trace sk-test"
        }
      ]
    } satisfies RunnerAgentTaskResponse);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const session = await store.createChatSession({ agentId: agent.id, title: "Failed turn" });

    await request(app)
      .post(`/api/chat-sessions/${session.id}/messages`)
      .send({ message: "This will fail" })
      .expect(202);
    await drainPendingTaskExecutions(app);

    const detailResponse = await request(app)
      .get(`/api/chat-sessions/${session.id}`)
      .expect(200);

    expect(detailResponse.body.latestTask.status).toBe("failed");
    expect(detailResponse.body.messages).toHaveLength(2);
    expect(detailResponse.body.messages[1].role).toBe("assistant");
    expect(detailResponse.body.messages[1].contentMarkdown).toBe("Task failed: Codex exited with code 1 and mentioned [REDACTED] in detailed logs");
    expect(detailResponse.body.taskMessages).toHaveLength(1);
    expect(detailResponse.body.taskMessages[0].content).toBe("Detailed failure [REDACTED]");
    expect(detailResponse.body.taskMessages[0].output).toBe("stack trace [REDACTED]");
    expect(JSON.stringify(detailResponse.body)).not.toContain("sk-test");
  });

  it("persists a concise assistant message when the runner times out", async () => {
    const runAgentTask = vi.fn().mockResolvedValue({
      status: "timed_out",
      finalMarkdown: "",
      rawOutputRedacted: "timeout logs",
      sessionId: null,
      workDir: null,
      taskMessages: [
        { type: "error", tool: null, content: "Command timed out", inputJson: null, output: null }
      ]
    } satisfies RunnerAgentTaskResponse);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const session = await store.createChatSession({ agentId: agent.id, title: "Timeout turn" });

    await request(app)
      .post(`/api/chat-sessions/${session.id}/messages`)
      .send({ message: "This will time out" })
      .expect(202);
    await drainPendingTaskExecutions(app);

    const detail = await store.getChatSessionDetail(session.id);
    expect(detail?.latestTask?.status).toBe("timed_out");
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[1].contentMarkdown).toBe("Task timed out.");
    expect(detail?.taskMessages[0].content).toBe("Command timed out");
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
      .expect(202);
    await drainPendingTaskExecutions(app);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({
        message: "Second turn"
      })
      .expect(202);
    await drainPendingTaskExecutions(app);

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
      .expect(202);
    await drainPendingTaskExecutions(app);

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
      .expect(202);
    await drainPendingTaskExecutions(app);

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

  describe("SSE task event stream", () => {
    async function scheduledSession(app: import("express").Express, runner: ReturnType<typeof vi.fn>) {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "SSE" });
      return session.id;
    }

    it("replays a snapshot then a terminal event for an already-completed task", async () => {
      const runAgentTask = vi.fn().mockResolvedValue({
        status: "completed",
        finalMarkdown: "All done",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: [{ type: "status", tool: null, content: "Working", inputJson: null, output: null }]
      } satisfies RunnerAgentTaskResponse);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const sessionId = await scheduledSession(app, runAgentTask);

      const scheduled = await request(app)
        .post(`/api/chat-sessions/${sessionId}/messages`)
        .send({ message: "Go" })
        .expect(202);
      await drainPendingTaskExecutions(app);

      const res = await request(app).get(`/api/chat-sessions/${sessionId}/events`).expect(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");

      const events = parseSseEvents(res.text);
      const snapshot = events.find((e) => e.event === "task_snapshot");
      expect(snapshot).toBeTruthy();
      expect((snapshot!.data as { task: { id: string; status: string } }).task.id).toBe(scheduled.body.task.id);
      expect((snapshot!.data as { taskMessages: unknown[] }).taskMessages).toHaveLength(1);

      const terminal = events.find((e) => e.event === "task_completed");
      expect(terminal).toBeTruthy();
      expect((terminal!.data as { taskId: string; status: string }).status).toBe("completed");
    });

    it("returns 404 for SSE on a missing chat session", async () => {
      const app = createApiApp({ chatStore: store });
      await request(app).get("/api/chat-sessions/missing/events").expect(404);
    });

    it("pushes a live task_message with seq then a terminal event for a running task", async () => {
      process.env.RUNNER_EVENT_TOKEN = "runner-token";
      const deferred = createDeferred<RunnerAgentTaskResponse>();
      const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const sessionId = await scheduledSession(app, runAgentTask);

      const scheduled = await request(app)
        .post(`/api/chat-sessions/${sessionId}/messages`)
        .send({ message: "Go" })
        .expect(202);
      const taskId = scheduled.body.task.id as string;

      // Open the SSE stream without awaiting; it ends when the task terminates.
      const streamPromise = request(app).get(`/api/chat-sessions/${sessionId}/events`);

      // Runner pushes a live event through the internal endpoint.
      await request(app)
        .post("/internal/runner/task-events")
        .set("authorization", "Bearer runner-token")
        .send({
          taskId,
          messages: [{ type: "status", tool: null, content: "Live update", inputJson: null, output: null }]
        })
        .expect(202);

      // Runner finishes → background completion publishes the terminal event and ends the stream.
      deferred.resolve({
        status: "completed",
        finalMarkdown: "Finished",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: []
      });
      await drainPendingTaskExecutions(app);

      const res = await streamPromise;
      const events = parseSseEvents(res.text);

      const liveMessage = events.find((e) => e.event === "task_message");
      expect(liveMessage).toBeTruthy();
      expect((liveMessage!.data as { taskMessage: { content: string } }).taskMessage.content).toBe("Live update");
      expect(liveMessage!.id).toBe(String((liveMessage!.data as { seq: number }).seq));

      expect(events.some((e) => e.event === "task_completed")).toBe(true);
    });

    it("emits task_failed for an already-failed task", async () => {
      const runAgentTask = vi.fn().mockResolvedValue({
        status: "failed",
        finalMarkdown: "Codex exited with code 1",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: [{ type: "error", tool: null, content: "Failure detail", inputJson: null, output: null }]
      } satisfies RunnerAgentTaskResponse);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const sessionId = await scheduledSession(app, runAgentTask);

      await request(app)
        .post(`/api/chat-sessions/${sessionId}/messages`)
        .send({ message: "Go" })
        .expect(202);
      await drainPendingTaskExecutions(app);

      const res = await request(app).get(`/api/chat-sessions/${sessionId}/events`).expect(200);
      const events = parseSseEvents(res.text);

      const terminal = events.find((e) => e.event === "task_failed");
      expect(terminal).toBeTruthy();
      expect((terminal!.data as { status: string; error: string }).status).toBe("failed");
      expect((terminal!.data as { status: string; error: string }).error).toBe("Codex exited with code 1");
    });

    it("emits task_failed for an already-timed-out task", async () => {
      const runAgentTask = vi.fn().mockResolvedValue({
        status: "timed_out",
        finalMarkdown: "Runner timed out",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: [{ type: "error", tool: null, content: "Timeout detail", inputJson: null, output: null }]
      } satisfies RunnerAgentTaskResponse);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const sessionId = await scheduledSession(app, runAgentTask);

      await request(app)
        .post(`/api/chat-sessions/${sessionId}/messages`)
        .send({ message: "Go" })
        .expect(202);
      await drainPendingTaskExecutions(app);

      const res = await request(app).get(`/api/chat-sessions/${sessionId}/events`).expect(200);
      const events = parseSseEvents(res.text);

      const terminal = events.find((e) => e.event === "task_failed");
      expect(terminal).toBeTruthy();
      expect((terminal!.data as { status: string; error: string }).status).toBe("timed_out");
    });

    it("replays only persisted task messages after Last-Event-ID on reconnect", async () => {
      process.env.RUNNER_EVENT_TOKEN = "runner-token";
      const deferred = createDeferred<RunnerAgentTaskResponse>();
      const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const sessionId = await scheduledSession(app, runAgentTask);

      const scheduled = await request(app)
        .post(`/api/chat-sessions/${sessionId}/messages`)
        .send({ message: "Go" })
        .expect(202);
      const taskId = scheduled.body.task.id as string;

      await request(app)
        .post("/internal/runner/task-events")
        .set("authorization", "Bearer runner-token")
        .send({
          taskId,
          messages: [
            { type: "status", tool: null, content: "First", inputJson: null, output: null },
            { type: "status", tool: null, content: "Second", inputJson: null, output: null },
            { type: "status", tool: null, content: "Third", inputJson: null, output: null }
          ]
        })
        .expect(202);

      deferred.resolve({
        status: "completed",
        finalMarkdown: "Finished",
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: []
      });
      await drainPendingTaskExecutions(app);

      const res = await request(app)
        .get(`/api/chat-sessions/${sessionId}/events`)
        .set("Last-Event-ID", "0")
        .expect(200);
      const events = parseSseEvents(res.text).filter((event) => event.event === "task_message");

      expect(events.map((event) => event.id)).toEqual(["1", "2"]);
      expect(events.map((event) => (event.data as { taskMessage: { content: string } }).taskMessage.content)).toEqual([
        "Second",
        "Third"
      ]);
      expect(events.every((event) => event.id === String((event.data as { seq: number }).seq))).toBe(true);
    });
  });

  describe("single-flight chat session enforcement", () => {
    it("rejects a second message while a task is still running in the same session", async () => {
      const deferred = createDeferred<RunnerAgentTaskResponse>();
      const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "Single-flight" });

      await request(app)
        .post(`/api/chat-sessions/${session.id}/messages`)
        .send({ message: "First turn" })
        .expect(202);

      const rejected = await request(app)
        .post(`/api/chat-sessions/${session.id}/messages`)
        .send({ message: "Second turn while running" })
        .expect(409);

      expect(rejected.body.error).toMatch(/already running|in progress/i);
      expect(runAgentTask).toHaveBeenCalledTimes(1);

      // Only one user message and one task should exist for the session.
      const detail = await store.getChatSessionDetail(session.id);
      expect(detail?.messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(detail?.latestTask?.status).toBe("running");

      deferred.resolve(completedRunnerResult);
      await drainPendingTaskExecutions(app);
    });

    it("accepts a new message after the previous task reaches a terminal status", async () => {
      const runAgentTask = vi.fn().mockResolvedValue(completedRunnerResult);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "Follow-up after done" });

      await request(app)
        .post(`/api/chat-sessions/${session.id}/messages`)
        .send({ message: "First turn" })
        .expect(202);
      await drainPendingTaskExecutions(app);

      await request(app)
        .post(`/api/chat-sessions/${session.id}/messages`)
        .send({ message: "Second turn" })
        .expect(202);
      await drainPendingTaskExecutions(app);

      expect(runAgentTask).toHaveBeenCalledTimes(2);
    });

    it("rejects concurrent duplicate sends that would create two running tasks", async () => {
      const deferred = createDeferred<RunnerAgentTaskResponse>();
      const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
      const app = createApiApp({ chatStore: store, runAgentTask });
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "Concurrent send" });

      const [first, second] = await Promise.all([
        request(app)
          .post(`/api/chat-sessions/${session.id}/messages`)
          .send({ message: "First" }),
        request(app)
          .post(`/api/chat-sessions/${session.id}/messages`)
          .send({ message: "Second" })
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([202, 409]);
      expect(runAgentTask).toHaveBeenCalledTimes(1);

      const detail = await store.getChatSessionDetail(session.id);
      expect(detail?.messages.filter((m) => m.role === "user")).toHaveLength(1);

      deferred.resolve(completedRunnerResult);
      await drainPendingTaskExecutions(app);
    });
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
        .expect(202);
      await drainPendingTaskExecutions(app);

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
        .expect(202);
      await drainPendingTaskExecutions(app);

      const calledAgentSpec = runAgentTask.mock.calls[0]![0].agentSpec;
      expect(calledAgentSpec.identity.name).toBe("Renamed Agent");
      expect(calledAgentSpec.systemPrompt).toBe("Updated system prompt");
      expect(calledAgentSpec.model.apiKey).toBe("sk-test");
    });
  });
});
