import type { CreateAgentTaskRequest, RunnerAgentTaskResponse } from "@agent-builder/shared";

export type RunnerClient = {
  runAgentTask(request: CreateAgentTaskRequest): Promise<RunnerAgentTaskResponse>;
};

export function createHttpRunnerClient(baseUrl: string): RunnerClient {
  return {
    async runAgentTask(request) {
      const response = await fetch(`${baseUrl}/agent-tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error ?? `Runner request failed with ${response.status}`);
      }

      return body as RunnerAgentTaskResponse;
    }
  };
}
