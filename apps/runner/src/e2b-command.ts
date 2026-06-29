export type E2BCodexCommandInput = {
  modelName: string;
  apiEndpoint: string;
  workspacePath: string;
  finalPath: string;
  promptPath: string;
  sessionId: string | null;
  registerMcpGateway?: boolean;
};

const MODEL_PROVIDER_NAME = "agent_builder_openai_compatible";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCodexCommand(input: E2BCodexCommandInput): string {
  const isResume = Boolean(input.sessionId);
  const execArgs = isResume ? `exec resume ${shellQuote(input.sessionId!)}` : "exec";
  const parts = [
    "codex",
    execArgs,
    "--full-auto",
    "--skip-git-repo-check",
    "--json",
    "-c",
    shellQuote(`model_provider=${MODEL_PROVIDER_NAME}`),
    "-c",
    shellQuote(`model_providers.${MODEL_PROVIDER_NAME}.name=${MODEL_PROVIDER_NAME}`),
    "-c",
    shellQuote(`model_providers.${MODEL_PROVIDER_NAME}.base_url=${input.apiEndpoint}`),
    "-c",
    shellQuote(`model_providers.${MODEL_PROVIDER_NAME}.wire_api=responses`),
    "-c",
    shellQuote(`model_providers.${MODEL_PROVIDER_NAME}.requires_openai_auth=true`),
    "--model",
    shellQuote(input.modelName),
    "--output-last-message",
    shellQuote(input.finalPath)
  ];
  if (!isResume) {
    parts.push("-C", shellQuote(input.workspacePath));
  }
  parts.push(`"$(cat ${shellQuote(input.promptPath)})"`);
  const execCommand = parts.join(" ");
  if (!input.registerMcpGateway) {
    return execCommand;
  }

  return [
    "codex mcp remove agent-builder >/dev/null 2>&1 || true",
    'codex mcp add agent-builder --url "$AGENT_BUILDER_MCP_GATEWAY_URL" --bearer-token-env-var AGENT_BUILDER_AGENT_TASK_LEASE',
    execCommand
  ].join("\n");
}
