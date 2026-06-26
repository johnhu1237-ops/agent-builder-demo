import type { AgentSpec } from "./agent-spec";

export type Agent = {
  id: string;
  name: string;
  description: string;
  spec: AgentSpec;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentRequest = {
  spec?: AgentSpec;
  apiKey: string;
};

export type UpdateAgentRequest = {
  spec: AgentSpec;
  apiKey?: string;
};
