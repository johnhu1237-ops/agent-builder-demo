import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import type { Agent, CreateAgentRequest, UpdateAgentRequest } from "../agent";
import type { ChatSession, CreateChatSessionRequest, SendChatMessageRequest } from "../chat";

describe("agent contracts", () => {
  it("models an Agent record with derived name and description", () => {
    const agent: Agent = {
      id: "agent_1",
      name: defaultAgentSpec.identity.name,
      description: defaultAgentSpec.identity.description,
      spec: defaultAgentSpec,
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z"
    };

    expect(agent.name).toBe(defaultAgentSpec.identity.name);
    expect(agent.spec.identity.description).toBe(agent.description);
  });

  it("allows creating an agent with an optional spec and updating with a required spec", () => {
    const create: CreateAgentRequest = {};
    const createWithSpec: CreateAgentRequest = { spec: defaultAgentSpec };
    const update: UpdateAgentRequest = { spec: defaultAgentSpec };

    expect(create.spec).toBeUndefined();
    expect(createWithSpec.spec).toBe(defaultAgentSpec);
    expect(update.spec).toBe(defaultAgentSpec);
  });

  it("binds chat sessions to an agent and carries sidebar display fields", () => {
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
    const sendMessage: SendChatMessageRequest = { message: "Hi", runtimeSecrets: { apiKey: "sk-test" } };

    expect(session.agentId).toBe("agent_1");
    expect(session.agentSpecSnapshot).toBeNull();
    expect(createSession.agentId).toBe("agent_1");
    expect(sendMessage.runtimeSecrets.apiKey).toBe("sk-test");
  });
});
