import type { AgentSpec, ChatSession, ChatSessionDetail } from "@agent-builder/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {})
    }
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return body as T;
}

export function getDefaultAgent(): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default");
}

export function saveDefaultAgent(agentSpec: AgentSpec): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default", {
    method: "PUT",
    body: JSON.stringify(agentSpec)
  });
}

export function listChatSessions(): Promise<ChatSession[]> {
  return requestJson<ChatSession[]>("/api/chat-sessions");
}

export function createChatSession(input: { agentSpec: AgentSpec; title?: string }): Promise<ChatSession> {
  return requestJson<ChatSession>("/api/chat-sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getChatSession(id: string): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${id}`);
}

export function sendChatMessage(input: {
  chatSessionId: string;
  agentSpec: AgentSpec;
  apiKey: string;
  message: string;
}): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${input.chatSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      agentSpec: input.agentSpec,
      runtimeSecrets: { apiKey: input.apiKey },
      message: input.message
    })
  });
}
