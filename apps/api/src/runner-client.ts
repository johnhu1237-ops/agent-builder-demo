import type { CreateRunRequest, RunnerResponse } from "@agent-builder/shared";

export type RunnerClient = {
  runAgent(request: CreateRunRequest): Promise<RunnerResponse>;
};

export function createHttpRunnerClient(baseUrl: string): RunnerClient {
  return {
    async runAgent(request) {
      const response = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Runner request failed with ${response.status}`);
      }

      return (await response.json()) as RunnerResponse;
    }
  };
}
