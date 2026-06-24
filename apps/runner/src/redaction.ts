export function redactRunnerOutput(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets.filter(Boolean)) {
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(/OPENAI_API_KEY=([^\s]+)/g, "OPENAI_API_KEY=[REDACTED]");
  output = output.replace(/sk-[A-Za-z0-9_-]{4,}/g, "[REDACTED]");
  return output;
}
