import { newDb } from "pg-mem";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec, type Agent, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";
import { createApiApp, type ApiDependencies } from "../index";

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

async function waitForPendingConfirmation(pool: import("pg").Pool): Promise<{ id: string; args_hash: string }> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string; args_hash: string }>(
      `select id, args_hash from tool_confirmations where status = 'pending' limit 1`
    );
    if (result.rows[0]) {
      return result.rows[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for pending tool confirmation");
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

  it("reads and updates Tool Configuration for an Agent", async () => {
    const syncDeferred = createDeferred<{ syncVersion: string }>();
    const arcadeToolConfigurationSyncer = {
      syncToolConfiguration: vi.fn().mockReturnValue(syncDeferred.promise)
    };
    const app = createApiApp({ chatStore: store, arcadeToolConfigurationSyncer });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });

    const listResponse = await request(app)
      .get(`/api/agents/${agent.id}/tool-configurations`)
      .expect(200);

    expect(listResponse.body).toEqual([
      expect.objectContaining({
        appId: "mock-github",
        toolName: "github_create_issue",
        mode: "ask_each_time"
      }),
      expect.objectContaining({
        appId: "mock-github",
        toolName: "github_search_issues",
        mode: "ask_each_time"
      })
    ]);

    const toolConfigurationId = listResponse.body[0].id;
    const updatePromise = request(app)
      .patch(`/api/agents/${agent.id}/tool-configurations/${toolConfigurationId}`)
      .send({ mode: "disabled" })
      .expect(200);
    const updateSettled = updatePromise.then((response) => response);

    await vi.waitFor(async () => {
      const syncingResponse = await request(app)
        .get(`/api/agents/${agent.id}/tool-configurations`)
        .expect(200);
      expect(syncingResponse.body[0]).toEqual(
        expect.objectContaining({
          id: toolConfigurationId,
          mode: "disabled",
          syncStatus: "syncing"
        })
      );
    });
    expect(arcadeToolConfigurationSyncer.syncToolConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.id,
        toolConfigurationId,
        toolName: "github_create_issue",
        desiredMode: "disabled",
        connectedAccountExternalId: "github-user-1"
      })
    );

    syncDeferred.resolve({ syncVersion: "arcade-sync-1" });
    const updateResponse = await updateSettled;

    expect(updateResponse.body).toEqual(
      expect.objectContaining({
        id: toolConfigurationId,
        mode: "disabled",
        syncStatus: "synced",
        syncVersion: "arcade-sync-1",
        lastSyncedMode: "disabled",
        syncError: null
      })
    );
    await request(app)
      .patch(`/api/agents/${agent.id}/tool-configurations/${toolConfigurationId}`)
      .send({ mode: "enabled" })
      .expect(400);
  });

  it("does not create a GitHub Connected Account when Arcade reports the demo user is not authorized", async () => {
    const connectedAppAuthorizationClient = {
      authorize: vi.fn(),
      isAuthorized: vi.fn().mockResolvedValue(false)
    };
    const app = createApiApp({ chatStore: store, connectedAppAuthorizationClient });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const completeResponse = await request(app)
      .post(`/api/agents/${agent.id}/connected-apps/github/complete`)
      .send({ accountLabel: "Forged GitHub", externalAccountId: "attacker" })
      .expect(409);

    expect(completeResponse.body.error).toMatch(/not authorized/i);
    expect(connectedAppAuthorizationClient.isAuthorized).toHaveBeenCalledWith({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues"
    });

    const connectedAppsResponse = await request(app)
      .get(`/api/agents/${agent.id}/connected-apps`)
      .expect(200);
    expect(connectedAppsResponse.body[0]).toEqual(
      expect.objectContaining({
        provider: "github",
        status: "available",
        connectedAccount: null,
        tools: []
      })
    );

    const toolConfigurationsResponse = await request(app)
      .get(`/api/agents/${agent.id}/tool-configurations`)
      .expect(200);
    expect(toolConfigurationsResponse.body).toEqual([]);
  });

  it("starts GitHub Connected App Authorization through Arcade with the frontend callback return URL", async () => {
    const connectedAppAuthorizationClient = {
      authorize: vi.fn().mockResolvedValue({ authorizationUrl: "https://arcade.dev/authorize/github/demo" }),
      isAuthorized: vi.fn()
    };
    const app = createApiApp({ chatStore: store, connectedAppAuthorizationClient });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const returnUrl = `http://localhost:5173/oauth/arcade/github/callback?agentId=${agent.id}`;

    const authorizeResponse = await request(app)
      .post(`/api/agents/${agent.id}/connected-apps/github/authorize`)
      .send({ returnUrl })
      .expect(202);

    expect(connectedAppAuthorizationClient.authorize).toHaveBeenCalledWith({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues",
      returnUrl
    });
    expect(authorizeResponse.body).toEqual({
      provider: "github",
      arcadeUserId: "demo-user",
      authorizationUrl: "https://arcade.dev/authorize/github/demo",
      status: "authorization_required"
    });
  });

  it("uses the configured Arcade user id for GitHub Connected App Authorization", async () => {
    const originalArcadeUserId = process.env.ARCADE_USER_ID;
    process.env.ARCADE_USER_ID = "arcade-project-user-1";
    try {
      const connectedAppAuthorizationClient = {
        authorize: vi.fn().mockResolvedValue({ authorizationUrl: "https://arcade.dev/authorize/github/demo" }),
        isAuthorized: vi.fn()
      };
      const app = createApiApp({ chatStore: store, connectedAppAuthorizationClient });
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const returnUrl = `http://localhost:5173/oauth/arcade/github/callback?agentId=${agent.id}`;

      const authorizeResponse = await request(app)
        .post(`/api/agents/${agent.id}/connected-apps/github/authorize`)
        .send({ returnUrl })
        .expect(202);

      expect(connectedAppAuthorizationClient.authorize).toHaveBeenCalledWith({
        provider: "github",
        userId: "arcade-project-user-1",
        toolName: "Github.ListIssues",
        returnUrl
      });
      expect(authorizeResponse.body.arcadeUserId).toBe("arcade-project-user-1");
    } finally {
      if (originalArcadeUserId === undefined) delete process.env.ARCADE_USER_ID;
      else process.env.ARCADE_USER_ID = originalArcadeUserId;
    }
  });

  it("uses the configured Arcade user id when completing GitHub Connected App Authorization", async () => {
    const originalArcadeUserId = process.env.ARCADE_USER_ID;
    process.env.ARCADE_USER_ID = "arcade-project-user-1";
    try {
      const connectedAppAuthorizationClient = {
        authorize: vi.fn(),
        isAuthorized: vi.fn().mockResolvedValue(true)
      };
      const app = createApiApp({ chatStore: store, connectedAppAuthorizationClient });
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const completeResponse = await request(app)
        .post(`/api/agents/${agent.id}/connected-apps/github/complete`)
        .send({})
        .expect(201);

      expect(connectedAppAuthorizationClient.isAuthorized).toHaveBeenCalledWith({
        provider: "github",
        userId: "arcade-project-user-1",
        toolName: "Github.ListIssues"
      });
      expect(completeResponse.body.connectedAccount).toEqual(
        expect.objectContaining({
          accountLabel: "GitHub via Arcade",
          externalAccountId: "arcade-project-user-1"
        })
      );
    } finally {
      if (originalArcadeUserId === undefined) delete process.env.ARCADE_USER_ID;
      else process.env.ARCADE_USER_ID = originalArcadeUserId;
    }
  });

  it("marks failed Tool Configuration syncs and recovers on a later successful update", async () => {
    const arcadeToolConfigurationSyncer = {
      syncToolConfiguration: vi
        .fn()
        .mockRejectedValueOnce(new Error("Arcade gateway unavailable"))
        .mockResolvedValueOnce({ syncVersion: "arcade-sync-2" })
    };
    const app = createApiApp({ chatStore: store, arcadeToolConfigurationSyncer });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);

    const failedResponse = await request(app)
      .patch(`/api/agents/${agent.id}/tool-configurations/${toolConfiguration.id}`)
      .send({ mode: "disabled" })
      .expect(200);

    expect(failedResponse.body).toEqual(
      expect.objectContaining({
        id: toolConfiguration.id,
        mode: "disabled",
        syncStatus: "sync_failed",
        syncError: "Arcade gateway unavailable",
        lastSyncedMode: "ask_each_time"
      })
    );

    const policyResponse = await request(app)
      .get(`/api/agents/${agent.id}/tool-configurations`)
      .expect(200);
    expect(policyResponse.body[0]).toEqual(
      expect.objectContaining({
        mode: "disabled",
        syncStatus: "sync_failed"
      })
    );

    const recoveredResponse = await request(app)
      .put(`/api/agents/${agent.id}/tools/github_create_issue`)
      .send({ mode: "auto" })
      .expect(200);

    expect(recoveredResponse.body).toEqual(
      expect.objectContaining({
        id: toolConfiguration.id,
        mode: "auto",
        syncStatus: "synced",
        syncError: null,
        syncVersion: "arcade-sync-2",
        lastSyncedMode: "auto"
      })
    );
    expect(arcadeToolConfigurationSyncer.syncToolConfiguration).toHaveBeenCalledTimes(2);
  });

  it("connects GitHub for an Agent and returns Connected Account state with Tool Configuration modes", async () => {
    const connectedAppAuthorizationClient = {
      authorize: vi.fn(),
      isAuthorized: vi.fn().mockResolvedValue(true)
    };
    const app = createApiApp({ chatStore: store, connectedAppAuthorizationClient });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

    const emptyResponse = await request(app)
      .get(`/api/agents/${agent.id}/connected-apps`)
      .expect(200);

    expect(emptyResponse.body).toEqual([
      expect.objectContaining({
        appId: "mock-github",
        provider: "github",
        status: "available",
        connectedAccount: null,
        tools: []
      })
    ]);

    const completeResponse = await request(app)
      .post(`/api/agents/${agent.id}/connected-apps/github/complete`)
      .send({ accountLabel: "John's GitHub", externalAccountId: "github-user-1" })
      .expect(201);

    expect(completeResponse.body).toEqual(
      expect.objectContaining({
        appId: "mock-github",
        provider: "github",
        status: "connected",
        connectedAccount: expect.objectContaining({
          accountLabel: "GitHub via Arcade",
          externalAccountId: "demo-user",
          status: "connected"
        }),
        tools: expect.arrayContaining([
          expect.objectContaining({
            toolName: "github_create_issue",
            mode: "ask_each_time"
          }),
          expect.objectContaining({
            toolName: "github_search_issues",
            mode: "ask_each_time"
          })
        ])
      })
    );

    const toolConfigurationId = completeResponse.body.tools[0].id;
    await request(app)
      .put(`/api/agents/${agent.id}/tools/github_create_issue`)
      .send({ mode: "auto" })
      .expect(200);

    const connectedResponse = await request(app)
      .get(`/api/agents/${agent.id}/connected-apps`)
      .expect(200);

    expect(connectedResponse.body[0]).toEqual(
      expect.objectContaining({
        status: "connected",
        tools: expect.arrayContaining([
          expect.objectContaining({
            id: toolConfigurationId,
            toolName: "github_create_issue",
            mode: "auto"
          }),
          expect.objectContaining({
            toolName: "github_search_issues",
            mode: "ask_each_time"
          })
        ])
      })
    );
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

  it("issues an Agent Task Lease and passes the MCP gateway contract to the runner", async () => {
    process.env.API_PUBLIC_BASE_URL = "http://api.internal:4001";
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const app = createApiApp({ chatStore: store, runAgentTask });

    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP lease" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Run with product MCP gateway." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    expect(call.mcpGatewayUrl).toBe("http://api.internal:4001/mcp/agent-task");
    expect(call.agentTaskLeaseId).toEqual(expect.any(String));
    expect(call.agentTaskLeaseToken).toEqual(expect.any(String));
    expect(call.agentTaskLeaseToken.length).toBeGreaterThan(30);

    const leaseRows = await pool.query<{
      id: string;
      agent_task_id: string;
      token_hash: string;
      token_plaintext: string | null;
      issuer: string;
      audience: string;
      status: string;
    }>(`select id, agent_task_id, token_hash, null::text as token_plaintext, issuer, audience, status from agent_task_leases`);

    expect(leaseRows.rows).toHaveLength(1);
    expect(leaseRows.rows[0].id).toBe(call.agentTaskLeaseId);
    expect(leaseRows.rows[0].agent_task_id).toBe(call.taskId);
    expect(leaseRows.rows[0].token_hash).toHaveLength(64);
    expect(leaseRows.rows[0].token_hash).not.toBe(call.agentTaskLeaseToken);
    expect(leaseRows.rows[0].token_plaintext).toBeNull();
    expect(leaseRows.rows[0].issuer).toBe("agent-builder-api");
    expect(leaseRows.rows[0].audience).toBe("agent-builder-mcp-gateway");
    expect(leaseRows.rows[0].status).toBe("active");

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("serves MCP tools/list from persisted Tool Configuration through the Agent Task Lease bearer token", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const app = createApiApp({ chatStore: store, runAgentTask });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    const connectedAccount = await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP tools" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "List tools." })
      .expect(202);

    const leaseToken = runAgentTask.mock.calls[0]![0].agentTaskLeaseToken;
    await request(app)
      .post("/mcp/agent-task")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { agentTaskId: "untrusted" } })
      .expect(401);

    const response = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${leaseToken}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { agentTaskId: "untrusted" } })
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
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
          {
            name: "github_search_issues",
            description: "Search GitHub issues through the product MCP gateway.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              },
              required: ["query"]
            }
          }
        ]
      }
    });

    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    expect(toolConfiguration.connectedAccountId).toBe(connectedAccount.id);
    await store.updateToolConfigurationMode({
      agentId: agent.id,
      toolConfigurationId: toolConfiguration.id,
      mode: "disabled"
    });

    const disabledResponse = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${leaseToken}`)
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
      .expect(200);

    expect(disabledResponse.body.result.tools).toEqual([
      {
        name: "github_search_issues",
        description: "Search GitHub issues through the product MCP gateway.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"]
        }
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("verifies a Codex Agent Task can use the product MCP gateway end to end", async () => {
    const externalToolExecutor = {
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Search found issue #42" }]
      })
    };
    let app: import("express").Express;
    const runAgentTask = vi.fn(async (runnerRequest: Parameters<NonNullable<ApiDependencies["runAgentTask"]>>[0]) => {
      const toolsResponse = await request(app)
        .post("/mcp/agent-task")
        .set("authorization", `Bearer ${runnerRequest.agentTaskLeaseToken}`)
        .send({ jsonrpc: "2.0", id: 21, method: "tools/list" })
        .expect(200);

      expect(toolsResponse.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        "github_create_issue",
        "github_search_issues"
      ]);

      await request(app)
        .post("/mcp/agent-task")
        .set("authorization", `Bearer ${runnerRequest.agentTaskLeaseToken}`)
        .send({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: {
            name: "github_search_issues",
            arguments: { query: "repo:acme/widgets gateway" }
          }
        })
        .expect(200);

      const deniedCall = request(app)
        .post("/mcp/agent-task")
        .set("authorization", `Bearer ${runnerRequest.agentTaskLeaseToken}`)
        .send({
          jsonrpc: "2.0",
          id: 23,
          method: "tools/call",
          params: {
            name: "github_create_issue",
            arguments: { title: "Denied issue", body: "Do not create" }
          }
        })
        .then((response) => response);
      const deniedConfirmation = await waitForPendingConfirmation(pool);

      const activityDuringConfirmation = await request(app)
        .get(`/api/chat-sessions/${runnerRequest.chatSessionId}`)
        .expect(200);
      expect(activityDuringConfirmation.body.pendingToolConfirmations).toEqual([
        expect.objectContaining({
          id: deniedConfirmation.id,
          mcpToolName: "github_create_issue",
          status: "pending"
        })
      ]);

      await request(app).post(`/api/tool-confirmations/${deniedConfirmation.id}/deny`).expect(200);
      const deniedResponse = await deniedCall;
      expect(deniedResponse.body.result).toEqual({
        isError: true,
        content: [{ type: "text", text: "Tool call denied by user." }]
      });

      const expiredResponse = await request(app)
        .post("/mcp/agent-task")
        .set("authorization", `Bearer ${runnerRequest.agentTaskLeaseToken}`)
        .send({
          jsonrpc: "2.0",
          id: 24,
          method: "tools/call",
          params: {
            name: "github_create_issue",
            arguments: { title: "Expired issue", body: "Do not create either" }
          }
        })
        .expect(200);
      expect(expiredResponse.body.result).toEqual({
        isError: true,
        content: [{ type: "text", text: "Tool confirmation timed out." }]
      });

      return {
        status: "completed",
        finalMarkdown: "Gateway verification completed",
        rawOutputRedacted: "",
        sessionId: "codex-session-gateway",
        workDir: "sandbox-gateway",
        taskMessages: [
          { type: "status", tool: "mcp", content: "Listed product MCP gateway tools", inputJson: null, output: null },
          { type: "tool_use", tool: "github_search_issues", content: "Called auto GitHub search", inputJson: null, output: null },
          { type: "status", tool: "mcp", content: "Observed denied and expired Tool Confirmations", inputJson: null, output: null }
        ]
      } satisfies RunnerAgentTaskResponse;
    });
    app = createApiApp({
      chatStore: store,
      runAgentTask,
      externalToolExecutor,
      toolConfirmationTimeoutMs: 100
    });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const toolConfigurations = await store.listToolConfigurationsForAgent(agent.id);
    const searchToolConfiguration = toolConfigurations.find((tool) => tool.toolName === "github_search_issues");
    expect(searchToolConfiguration).toBeDefined();
    await store.updateToolConfigurationMode({
      agentId: agent.id,
      toolConfigurationId: searchToolConfiguration!.id,
      mode: "auto"
    });

    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Gateway verification" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Verify the product MCP gateway from Codex." })
      .expect(202);
    await drainPendingTaskExecutions(app);

    expect(externalToolExecutor.executeTool).toHaveBeenCalledTimes(1);
    expect(externalToolExecutor.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpToolName: "github_search_issues",
        args: { query: "repo:acme/widgets gateway" }
      })
    );

    const auditRows = await pool.query<{ mcp_tool_name: string; status: string; mode: string | null }>(
      `select mcp_tool_name, status, mode from tool_call_audit_logs order by created_at asc`
    );
    expect(auditRows.rows).toEqual([
      { mcp_tool_name: "github_search_issues", status: "executed", mode: "auto" },
      { mcp_tool_name: "github_create_issue", status: "confirmation_required", mode: "ask_each_time" },
      { mcp_tool_name: "github_create_issue", status: "denied", mode: "ask_each_time" },
      { mcp_tool_name: "github_create_issue", status: "confirmation_required", mode: "ask_each_time" },
      { mcp_tool_name: "github_create_issue", status: "timed_out", mode: "ask_each_time" }
    ]);

    const detailResponse = await request(app)
      .get(`/api/chat-sessions/${sessionResponse.body.id}`)
      .expect(200);
    expect(detailResponse.body.latestTask.status).toBe("completed");
    expect(detailResponse.body.taskMessages).toEqual([
      expect.objectContaining({ type: "status", tool: "mcp", content: "Listed product MCP gateway tools" }),
      expect.objectContaining({ type: "tool_use", tool: "github_search_issues", content: "Called auto GitHub search" }),
      expect.objectContaining({ type: "status", tool: "mcp", content: "Observed denied and expired Tool Confirmations" })
    ]);
  });

  it("executes auto-mode MCP tools/call through the external tool executor and records redacted audit", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const externalToolExecutor = {
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Created issue #123" }]
      })
    };
    const app = createApiApp({ chatStore: store, runAgentTask, externalToolExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    await store.updateToolConfigurationMode({
      agentId: agent.id,
      toolConfigurationId: toolConfiguration.id,
      mode: "auto"
    });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP call" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Create an issue." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    const response = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${call.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "github_create_issue",
          arguments: {
            title: "Ship gateway",
            body: "Use token sk-live-secret-value"
          }
        }
      })
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        content: [{ type: "text", text: "Created issue #123" }]
      }
    });
    expect(externalToolExecutor.executeTool).toHaveBeenCalledWith({
      arcadeUserId: "github-user-1",
      provider: "mock-github",
      mcpToolName: "github_create_issue",
      providerToolName: "github_create_issue",
      args: {
        title: "Ship gateway",
        body: "Use token sk-live-secret-value"
      }
    });

    const auditRows = await pool.query<{
      agent_task_id: string;
      chat_session_id: string;
      agent_id: string;
      connected_account_id: string;
      provider: string;
      mcp_tool_name: string;
      provider_tool_name: string;
      mode: string;
      args_redacted: unknown;
      status: string;
      error: string | null;
    }>(`select agent_task_id, chat_session_id, agent_id, connected_account_id, provider, mcp_tool_name, provider_tool_name, mode, args_redacted, status, error from tool_call_audit_logs`);

    expect(auditRows.rows).toEqual([
      {
        agent_task_id: call.taskId,
        chat_session_id: sessionResponse.body.id,
        agent_id: agent.id,
        connected_account_id: toolConfiguration.connectedAccountId,
        provider: "mock-github",
        mcp_tool_name: "github_create_issue",
        provider_tool_name: "github_create_issue",
        mode: "auto",
        args_redacted: {
          title: "Ship gateway",
          body: "Use token [REDACTED]"
        },
        status: "executed",
        error: null
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("rejects disabled MCP tools/call before execution and records denied audit", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const externalToolExecutor = {
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "should not run" }]
      })
    };
    const app = createApiApp({ chatStore: store, runAgentTask, externalToolExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    await store.updateToolConfigurationMode({
      agentId: agent.id,
      toolConfigurationId: toolConfiguration.id,
      mode: "disabled"
    });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP disabled call" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Create an issue." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    const response = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${call.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "github_create_issue",
          arguments: { title: "Nope" }
        }
      })
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: {
        code: -32602,
        message: "Tool is disabled for this Agent"
      }
    });
    expect(externalToolExecutor.executeTool).not.toHaveBeenCalled();

    const auditRows = await pool.query<{ status: string; error: string | null; args_redacted: unknown }>(
      `select status, error, args_redacted from tool_call_audit_logs`
    );
    expect(auditRows.rows).toEqual([
      {
        status: "denied",
        error: "Tool is disabled for this Agent",
        args_redacted: { title: "Nope" }
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("rejects unknown MCP tools/call before execution", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const externalToolExecutor = {
      executeTool: vi.fn()
    };
    const app = createApiApp({ chatStore: store, runAgentTask, externalToolExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP rejected calls" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Call tools." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    const unknownResponse = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${call.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "unknown_tool", arguments: { token: "secret-token" } }
      })
      .expect(200);

    expect(unknownResponse.body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "Tool is not available to this Agent Task" }
    });

    expect(externalToolExecutor.executeTool).not.toHaveBeenCalled();

    const auditRows = await pool.query<{ mcp_tool_name: string; status: string; mode: string | null; args_redacted: unknown }>(
      `select mcp_tool_name, status, mode, args_redacted from tool_call_audit_logs order by created_at asc`
    );
    expect(auditRows.rows).toEqual([
      {
        mcp_tool_name: "unknown_tool",
        status: "denied",
        mode: null,
        args_redacted: { token: "[REDACTED]" }
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("creates a pending confirmation for ask-each-time calls and executes the original args after approval", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const externalToolExecutor = {
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Created issue after approval" }]
      })
    };
    const app = createApiApp({ chatStore: store, runAgentTask, externalToolExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP approved call" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Create an issue after asking." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    const mcpCallPromise = request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${call.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "github_create_issue",
          arguments: { title: "Needs approval", body: "Use token sk-live-secret-value" }
        }
      })
      .then((response) => response);

    const confirmation = await waitForPendingConfirmation(pool);
    const approveResponse = await request(app)
      .post(`/api/tool-confirmations/${confirmation.id}/approve`)
      .expect(200);

    expect(approveResponse.body).toEqual(expect.objectContaining({ id: confirmation.id, status: "approved" }));

    const mcpResponse = await mcpCallPromise;
    expect(mcpResponse.status).toBe(200);
    expect(mcpResponse.body).toEqual({
      jsonrpc: "2.0",
      id: 8,
      result: {
        content: [{ type: "text", text: "Created issue after approval" }]
      }
    });
    expect(externalToolExecutor.executeTool).toHaveBeenCalledWith({
      arcadeUserId: "github-user-1",
      provider: "mock-github",
      mcpToolName: "github_create_issue",
      providerToolName: "github_create_issue",
      args: { title: "Needs approval", body: "Use token sk-live-secret-value" }
    });

    const rows = await pool.query<{
      status: string;
      args_redacted: unknown;
      confirmation_status: string;
      args_hash: string;
    }>(`
      select a.status, a.args_redacted, c.status as confirmation_status, c.args_hash
      from tool_call_audit_logs a
      join tool_confirmations c on c.agent_task_id = a.agent_task_id
    `);
    expect(rows.rows).toEqual([
      {
        status: "confirmation_required",
        args_redacted: { title: "Needs approval", body: "Use token [REDACTED]" },
        confirmation_status: "approved",
        args_hash: confirmation.args_hash
      },
      {
        status: "executed",
        args_redacted: { title: "Needs approval", body: "Use token [REDACTED]" },
        confirmation_status: "approved",
        args_hash: confirmation.args_hash
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("returns non-success MCP results for denied, timed-out, and mismatched confirmations", async () => {
    const deniedDeferred = createDeferred<RunnerAgentTaskResponse>();
    const deniedRun = vi.fn().mockReturnValue(deniedDeferred.promise);
    const deniedExecutor = { executeTool: vi.fn() };
    const deniedApp = createApiApp({ chatStore: store, runAgentTask: deniedRun, externalToolExecutor: deniedExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const sessionResponse = await request(deniedApp)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP denied call" })
      .expect(201);
    await request(deniedApp)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Create an issue." })
      .expect(202);

    const deniedCall = deniedRun.mock.calls[0]![0];
    const deniedMcpCallPromise = request(deniedApp)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${deniedCall.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "github_create_issue", arguments: { title: "Denied" } }
      })
      .then((response) => response);
    const deniedConfirmation = await waitForPendingConfirmation(pool);
    await request(deniedApp).post(`/api/tool-confirmations/${deniedConfirmation.id}/deny`).expect(200);
    const deniedResponse = await deniedMcpCallPromise;
    expect(deniedResponse.status).toBe(200);
    expect(deniedResponse.body).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool call denied by user." }]
      }
    });
    expect(deniedExecutor.executeTool).not.toHaveBeenCalled();

    const timeoutDeferred = createDeferred<RunnerAgentTaskResponse>();
    const timeoutRun = vi.fn().mockReturnValue(timeoutDeferred.promise);
    const timeoutExecutor = { executeTool: vi.fn() };
    const timeoutApp = createApiApp({
      chatStore: store,
      runAgentTask: timeoutRun,
      externalToolExecutor: timeoutExecutor,
      toolConfirmationTimeoutMs: 10
    });
    const timeoutSessionResponse = await request(timeoutApp)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP timed out call" })
      .expect(201);
    await request(timeoutApp)
      .post(`/api/chat-sessions/${timeoutSessionResponse.body.id}/messages`)
      .send({ message: "Create an issue." })
      .expect(202);
    const timeoutCall = timeoutRun.mock.calls[0]![0];
    const timeoutResponse = await request(timeoutApp)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${timeoutCall.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "github_create_issue", arguments: { title: "Timeout" } }
      })
      .expect(200);
    expect(timeoutResponse.body).toEqual({
      jsonrpc: "2.0",
      id: 10,
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool confirmation timed out." }]
      }
    });
    expect(timeoutExecutor.executeTool).not.toHaveBeenCalled();

    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    const mismatchConfirmation = await store.createToolConfirmation({
      agentTaskId: deniedCall.taskId,
      chatSessionId: sessionResponse.body.id,
      agentId: agent.id,
      connectedAccountId: toolConfiguration.connectedAccountId,
      provider: "mock-github",
      mcpToolName: "github_create_issue",
      providerToolName: "github_create_issue",
      args: { title: "Original" },
      expiresAt: new Date(Date.now() + 60 * 1000)
    });
    const mismatchResult = await store.resolveToolConfirmation(mismatchConfirmation.id, {
      status: "approved",
      expectedArgsHash: "different-hash"
    });
    expect(mismatchResult).toEqual({ status: "args_mismatch" });

    const timeoutResult = await store.expirePendingToolConfirmations(new Date(Date.now() + 10 * 60 * 1000));
    expect(timeoutResult).toBeGreaterThanOrEqual(0);

    deniedDeferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(deniedApp);
    timeoutDeferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(timeoutApp);
  });

  it("returns MCP-friendly errors and failed audit records when auto tool execution fails", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const externalToolExecutor = {
      executeTool: vi.fn().mockRejectedValue(new Error("Arcade execution failed"))
    };
    const app = createApiApp({ chatStore: store, runAgentTask, externalToolExecutor });

    const agent = await store.createAgent({ apiKey: "sk-test", spec: defaultAgentSpec });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "mock-github",
      accountLabel: "Mock GitHub",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);
    await store.updateToolConfigurationMode({
      agentId: agent.id,
      toolConfigurationId: toolConfiguration.id,
      mode: "auto"
    });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "MCP failed call" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Create an issue." })
      .expect(202);

    const call = runAgentTask.mock.calls[0]![0];
    const response = await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${call.agentTaskLeaseToken}`)
      .send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "github_create_issue",
          arguments: { title: "Retry later", authorization: "Bearer secret-token" }
        }
      })
      .expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: {
        code: -32603,
        message: "Arcade execution failed"
      }
    });

    const auditRows = await pool.query<{ status: string; error: string | null; args_redacted: unknown }>(
      `select status, error, args_redacted from tool_call_audit_logs`
    );
    expect(auditRows.rows).toEqual([
      {
        status: "failed",
        error: "Arcade execution failed",
        args_redacted: { title: "Retry later", authorization: "[REDACTED]" }
      }
    ]);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("binds an Agent Task Lease to one sandbox id exactly once", async () => {
    process.env.RUNNER_EVENT_TOKEN = "runner-token";
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const sessionResponse = await request(app)
      .post("/api/chat-sessions")
      .send({ agentId: agent.id, title: "Sandbox bind" })
      .expect(201);

    await request(app)
      .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
      .send({ message: "Bind sandbox." })
      .expect(202);

    const leaseId = runAgentTask.mock.calls[0]![0].agentTaskLeaseId;

    await request(app)
      .post(`/internal/agent-task-leases/${leaseId}/bind-sandbox`)
      .set("authorization", "Bearer runner-token")
      .send({ sandboxId: "sandbox-1" })
      .expect(202);

    await request(app)
      .post(`/internal/agent-task-leases/${leaseId}/bind-sandbox`)
      .set("authorization", "Bearer runner-token")
      .send({ sandboxId: "sandbox-1" })
      .expect(202);

    const conflict = await request(app)
      .post(`/internal/agent-task-leases/${leaseId}/bind-sandbox`)
      .set("authorization", "Bearer runner-token")
      .send({ sandboxId: "sandbox-2" })
      .expect(409);
    expect(conflict.body.error).toBe("Agent Task Lease is already bound to a different sandbox");

    await request(app)
      .post(`/internal/agent-task-leases/${leaseId}/bind-sandbox`)
      .send({ sandboxId: "sandbox-1" })
      .expect(401);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);
  });

  it("revokes the Agent Task Lease when the Agent Task reaches a terminal state", async () => {
    const deferred = createDeferred<RunnerAgentTaskResponse>();
    const runAgentTask = vi.fn().mockReturnValue(deferred.promise);
    const app = createApiApp({ chatStore: store, runAgentTask });
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const session = await store.createChatSession({ agentId: agent.id, title: "Revoke lease" });

    await request(app)
      .post(`/api/chat-sessions/${session.id}/messages`)
      .send({ message: "Finish task." })
      .expect(202);

    const leaseToken = runAgentTask.mock.calls[0]![0].agentTaskLeaseToken;
    await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${leaseToken}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);

    deferred.resolve(completedRunnerResult);
    await drainPendingTaskExecutions(app);

    await request(app)
      .post("/mcp/agent-task")
      .set("authorization", `Bearer ${leaseToken}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      .expect(401);
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
