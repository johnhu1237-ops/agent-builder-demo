import type { AgentSpec } from "./agent-spec";

export type Agent = {
  id: string;
  name: string;
  description: string;
  spec: AgentSpec;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentRequest = {
  spec?: AgentSpec;
};

export type UpdateAgentRequest = {
  spec: AgentSpec;
};
