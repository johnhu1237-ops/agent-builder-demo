export type E2BCodexCommandInput = {
  modelName: string;
  apiEndpoint: string;
  workspacePath: string;
  finalPath: string;
  promptPath: string;
  sessionId: string | null;
};

const MODEL_PROVIDER_NAME = "agent_builder_openai_compatible";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCodexCommand(input: E2BCodexCommandInput): string {
  const execArgs = input.sessionId ? `exec resume ${shellQuote(input.sessionId)}` : "exec";
  return [
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
    shellQuote(input.finalPath),
    "-C",
    shellQuote(input.workspacePath),
    `"$(cat ${shellQuote(input.promptPath)})"`
  ].join(" ");
}
