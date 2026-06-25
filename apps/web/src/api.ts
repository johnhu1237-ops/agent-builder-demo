import type { Agent, ChatSession, ChatSessionDetail } from "@agent-builder/shared";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers as Record<string, string> | undefined)
    }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with status ${response.status}`);
  }
  return body as T;
}

// Agent CRUD

export async function createAgent(input?: { spec?: unknown }): Promise<Agent> {
  return requestJson<Agent>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input ?? {})
  });
}

export async function listAgents(): Promise<Agent[]> {
  return requestJson<Agent[]>("/api/agents");
}

export async function getAgent(id: string): Promise<Agent> {
  return requestJson<Agent>(`/api/agents/${encodeURIComponent(id)}`);
}

export async function updateAgent(id: string, input: { spec: unknown }): Promise<Agent> {
  return requestJson<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

// Default agent (kept for backward compat)

export async function getDefaultAgent(): Promise<unknown> {
  return requestJson<unknown>("/api/agent/default");
}

export async function saveDefaultAgent(agentSpec: unknown): Promise<unknown> {
  return requestJson<unknown>("/api/agent/default", {
    method: "PUT",
    body: JSON.stringify(agentSpec)
  });
}

// Chat Sessions

export async function listChatSessions(): Promise<ChatSession[]> {
  return requestJson<ChatSession[]>("/api/chat-sessions");
}

export async function createChatSession(input: { agentId: string; title?: string }): Promise<ChatSession> {
  return requestJson<ChatSession>("/api/chat-sessions", {
    method: "POST",
    body: JSON.stringify({ agentId: input.agentId, title: input.title })
  });
}

export async function getChatSession(id: string): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${encodeURIComponent(id)}`);
}

// Message sending — no longer sends agentSpec (API fetches live spec from DB)

export async function sendChatMessage(input: {
  chatSessionId: string;
  apiKey: string;
  message: string;
}): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${encodeURIComponent(input.chatSessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message: input.message,
      runtimeSecrets: { apiKey: input.apiKey }
    })
  });
}
