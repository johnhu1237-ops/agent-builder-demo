import { defaultAgentSpec, exportAgentSpec, type AgentSpec } from "@agent-builder/shared";

export const defaultUiAgentSpec: AgentSpec = defaultAgentSpec;

export function createExportPayload(input: { agentSpec: AgentSpec }): AgentSpec {
  return exportAgentSpec(input.agentSpec);
}
