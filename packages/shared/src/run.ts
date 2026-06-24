import type { AgentSpec } from "./agent-spec";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled";

export type RunEventType = "queued" | "starting" | "researching" | "generating_report" | "completed" | "failed";

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  message: string;
  createdAt: string;
};

export type RunRecord = {
  id: string;
  task: string;
  status: RunStatus;
  agentSpecSnapshot: AgentSpec;
  traceEvents: RunEvent[];
  finalMarkdown: string | null;
  rawOutput: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type CreateRunRequest = {
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
  task: string;
};

export type RunnerResponse = {
  finalMarkdown: string;
  rawOutput: string;
  events: Omit<RunEvent, "id" | "runId" | "createdAt">[];
};
