import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { createAgent, listAgents, getAgent, updateAgent, createChatSession, sendChatMessage } = await import("../api");

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
        if (options?.method === "POST") {
          return jsonResponse({
            id: "agent_1",
            name: "Research Agent",
            description: "Test agent",
            spec: { version: "0.1", identity: { name: "Research Agent", description: "Test agent" } },
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
    it("creates an agent with a default spec", async () => {
      const agent = await createAgent({});
      expect(agent.id).toBe("agent_1");
      expect(agent.name).toBe("Research Agent");
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
  });

  describe("updated session and message calls", () => {
    it("creates a chat session with agentId (no agentSpec)", async () => {
      const session = await createChatSession({ agentId: "agent_1", title: "Test chat" });
      expect(lastFetchBody).toEqual({ agentId: "agent_1", title: "Test chat" });
      expect(session.title).toBe("Test chat");
    });

    it("sends a message without agentSpec in the body", async () => {
      await sendChatMessage({ chatSessionId: "chat_1", apiKey: "sk-test", message: "Hello" });
      expect(lastFetchBody).toEqual({
        message: "Hello",
        runtimeSecrets: { apiKey: "sk-test" }
      });
      // agentSpec should NOT be in the body
      expect((lastFetchBody as Record<string, unknown>).agentSpec).toBeUndefined();
    });
  });
});
