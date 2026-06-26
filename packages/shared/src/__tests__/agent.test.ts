import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from "../agent";
import type { ChatSession, CreateChatSessionRequest, SendChatMessageRequest } from "../chat";

describe("agent contracts", () => {
  it("models an Agent record with derived name, description, and hasApiKey", () => {
    const agent: Agent = {
      id: "agent_1",
      name: defaultAgentSpec.identity.name,
      description: defaultAgentSpec.identity.description,
      spec: defaultAgentSpec,
      hasApiKey: true,
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z"
    };

    expect(agent.name).toBe(defaultAgentSpec.identity.name);
    expect(agent.hasApiKey).toBe(true);
  });

  it("requires apiKey on create and allows optional apiKey on update", () => {
    const create: CreateAgentRequest = { apiKey: "sk-test" };
    const createWithSpec: CreateAgentRequest = { spec: defaultAgentSpec, apiKey: "sk-test" };
    const update: UpdateAgentRequest = { spec: defaultAgentSpec };
    const updateWithKey: UpdateAgentRequest = { spec: defaultAgentSpec, apiKey: "sk-new" };

    expect(create.apiKey).toBe("sk-test");
    expect(createWithSpec.spec).toBe(defaultAgentSpec);
    expect(update.apiKey).toBeUndefined();
    expect(updateWithKey.apiKey).toBe("sk-new");
  });

  it("sends a chat message without runtime secrets", () => {
    const session: ChatSession = {
      id: "chat_1",
      agentId: "agent_1",
      agentName: "Research Agent",
      agentSpecSnapshot: null,
      lastMessagePreview: "Research Acme.",
      title: "Acme research",
      sessionId: null,
      workDir: null,
      status: "active",
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z"
    };
    const createSession: CreateChatSessionRequest = { agentId: "agent_1", title: "Acme research" };
    const sendMessage: SendChatMessageRequest = { message: "Hi" };

    expect(session.agentId).toBe("agent_1");
    expect(createSession.agentId).toBe("agent_1");
    expect(sendMessage.message).toBe("Hi");
    expect((sendMessage as Record<string, unknown>).runtimeSecrets).toBeUndefined();
  });
});
