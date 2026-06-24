import type { AgentSpec, RunRecord } from "@agent-builder/shared";

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

export function createRun(input: {
  agentSpec: AgentSpec;
  apiKey: string;
  task: string;
}): Promise<RunRecord> {
  return requestJson<RunRecord>("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      agentSpec: input.agentSpec,
      runtimeSecrets: { apiKey: input.apiKey },
      task: input.task
    })
  });
}
