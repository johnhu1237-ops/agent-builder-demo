export type E2BCodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  promptPath: string;
  sessionId: string | null;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCodexCommand(input: E2BCodexCommandInput): string {
  const execArgs = input.sessionId ? `exec resume ${shellQuote(input.sessionId)}` : "exec";
  return [
    "codex",
    "--search",
    "--ask-for-approval",
    "never",
    execArgs,
    "--json",
    "--model",
    shellQuote(input.modelName),
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--output-last-message",
    shellQuote(input.finalPath),
    "-C",
    shellQuote(input.workspacePath),
    `"$(cat ${shellQuote(input.promptPath)})"`
  ].join(" ");
}
