import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  createChatSession,
  sendChatMessage,
  startGithubConnectedAppAuthorization,
  completeGithubConnectedApp,
  listConnectedApps,
  listToolConfigurations,
  updateToolConfigurationMode
} = await import("../api");

const fetchMock = vi.fn();
let lastFetchBody: unknown = null;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("api client", () => {
  beforeEach(() => {
    global.fetch = fetchMock;
    lastFetchBody = null;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.body) lastFetchBody = JSON.parse(options.body as string);
      if (url.includes("/api/agents")) {
        if (url.includes("/tool-configurations")) {
          if (options?.method === "PATCH") {
            return jsonResponse({
              id: "tool_config_1",
              agentId: "agent_1",
              connectedAccountId: "connected_account_1",
              appId: "github",
              toolName: "github_create_issue",
              mode: "disabled",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }
          return jsonResponse([
            {
              id: "tool_config_1",
              agentId: "agent_1",
              connectedAccountId: "connected_account_1",
              appId: "github",
              toolName: "github_create_issue",
              mode: "ask_each_time",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ]);
        }
        if (url.includes("/connected-apps/github/authorize") && options?.method === "POST") {
          return jsonResponse({
            provider: "github",
            arcadeUserId: "demo-user",
            authorizationUrl: "https://arcade.dev/authorize/github/demo",
            status: "authorization_required"
          }, 202);
        }
        if (url.includes("/connected-apps/github/complete") && options?.method === "POST") {
          return jsonResponse({
            appId: "github",
            provider: "github",
            label: "GitHub",
            description: "Connect GitHub issues.",
            status: "connected",
            connectedAccount: {
              id: "connected_account_1",
              workspaceId: "workspace_demo",
              appId: "github",
              accountLabel: "John's GitHub",
              externalAccountId: "github-user-1",
              status: "connected",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            tools: []
          }, 201);
        }
        if (url.includes("/connected-apps")) {
          return jsonResponse([
            {
              appId: "github",
              provider: "github",
              label: "GitHub",
              description: "Connect GitHub issues.",
              status: "available",
              connectedAccount: null,
              tools: []
            }
          ]);
        }
        if (options?.method === "POST") {
          return jsonResponse({
            id: "agent_1",
            name: "Research Agent",
            description: "Test agent",
            spec: { version: "0.1", identity: { name: "Research Agent", description: "Test agent" } },
            hasApiKey: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }, 201);
        }
        if (options?.method === "PUT") {
          return jsonResponse({
            id: "agent_1",
            name: "Updated",
            description: "Updated desc",
            spec: { version: "0.1", identity: { name: "Updated", description: "Updated desc" } },
            hasApiKey: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        if (url.includes("/api/agents/agent_1")) {
          return jsonResponse({
            id: "agent_1",
            name: "Research Agent",
            description: "Test agent",
            spec: { version: "0.1", identity: { name: "Research Agent", description: "Test agent" } },
            hasApiKey: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        return jsonResponse([], 200);
      }
      if (url.includes("/api/chat-sessions") && options?.method === "POST") {
        return jsonResponse({
          id: "chat_1",
          agentId: "agent_1",
          agentName: "Research Agent",
          agentSpecSnapshot: null,
          title: "Test chat",
          status: "active",
          sessionId: null,
          workDir: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }, 201);
      }
      if (url.includes("/messages") && options?.method === "POST") {
        return jsonResponse({
          id: "chat_1",
          messages: [],
          latestTask: null,
          taskMessages: []
        }, 201);
      }
      return jsonResponse(null, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("agent CRUD", () => {
    it("creates an agent with a spec and api key", async () => {
      const agent = await createAgent({ apiKey: "sk-test" });
      expect(lastFetchBody).toEqual({ apiKey: "sk-test" });
      expect(agent.id).toBe("agent_1");
    });

    it("lists agents", async () => {
      const agents = await listAgents();
      expect(Array.isArray(agents)).toBe(true);
    });

    it("gets an agent by id", async () => {
      const agent = await getAgent("agent_1");
      expect(agent.name).toBe("Research Agent");
    });

    it("updates an agent", async () => {
      const agent = await updateAgent("agent_1", {
        spec: {
          version: "0.1",
          identity: { name: "Updated", description: "Updated desc" },
          systemPrompt: "test",
          model: { provider: "openai-compatible", name: "gpt-5", apiEndpoint: "https://api.openai.com/v1" },
          apps: [], skills: [], abilities: [], output: { format: "markdown" }
        }
      });
      expect(agent.name).toBe("Updated");
    });

    it("reads and updates Tool Configuration modes", async () => {
      const toolConfigurations = await listToolConfigurations("agent_1");
      expect(toolConfigurations[0].mode).toBe("ask_each_time");

      const updated = await updateToolConfigurationMode("agent_1", "tool_config_1", "disabled");

      expect(updated.mode).toBe("disabled");
      expect(lastFetchBody).toEqual({ mode: "disabled" });
    });

    it("starts and completes GitHub Connected App Authorization", async () => {
      const connectedApps = await listConnectedApps("agent_1");
      expect(connectedApps[0].status).toBe("available");

      const authorization = await startGithubConnectedAppAuthorization(
        "agent_1",
        "http://localhost:5173/oauth/arcade/github/callback?agentId=agent_1"
      );
      expect(authorization.authorizationUrl).toBe("https://arcade.dev/authorize/github/demo");
      expect(lastFetchBody).toEqual({
        returnUrl: "http://localhost:5173/oauth/arcade/github/callback?agentId=agent_1"
      });

      const connected = await completeGithubConnectedApp("agent_1");

      expect(connected.status).toBe("connected");
      expect(lastFetchBody).toEqual({});
    });
  });

  describe("updated session and message calls", () => {
    it("creates a chat session with agentId (no agentSpec)", async () => {
      const session = await createChatSession({ agentId: "agent_1", title: "Test chat" });
      expect(lastFetchBody).toEqual({ agentId: "agent_1", title: "Test chat" });
      expect(session.title).toBe("Test chat");
    });

    it("sends a message with only the message in the body", async () => {
      await sendChatMessage({ chatSessionId: "chat_1", message: "Hello" });
      expect(lastFetchBody).toEqual({ message: "Hello" });
      expect((lastFetchBody as Record<string, unknown>).runtimeSecrets).toBeUndefined();
      expect((lastFetchBody as Record<string, unknown>).agentSpec).toBeUndefined();
    });
  });
});
