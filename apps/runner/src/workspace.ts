import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function resolveWorkspacePath(input: {
  requestedWorkDir: string | null;
  chatSessionId: string;
  rootDir: string;
}): Promise<string> {
  const workDir = input.requestedWorkDir?.trim()
    ? input.requestedWorkDir
    : join(input.rootDir, input.chatSessionId);
  const resolved = resolve(workDir);
  await mkdir(resolved, { recursive: true });
  return resolved;
}
