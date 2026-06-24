import { Sandbox } from "e2b";
import type { E2BSandboxFactory, E2BSandboxLike } from "./e2b-types";

export type ResolvedSandbox =
  | { kind: "created"; sandbox: E2BSandboxLike; resumeError: null }
  | { kind: "resumed"; sandbox: E2BSandboxLike; resumeError: null }
  | { kind: "workspace_lost"; sandbox: E2BSandboxLike; resumeError: Error };

export function createE2BSandboxFactory(input: { apiKey: string }): E2BSandboxFactory {
  return {
    async create(templateId) {
      return Sandbox.create(templateId, { apiKey: input.apiKey }) as unknown as Promise<E2BSandboxLike>;
    },
    async connect(sandboxId) {
      return Sandbox.connect(sandboxId, { apiKey: input.apiKey }) as unknown as Promise<E2BSandboxLike>;
    }
  };
}

export async function resolveSandbox(input: {
  workDir: string | null;
  templateId: string;
  factory: E2BSandboxFactory;
}): Promise<ResolvedSandbox> {
  if (!input.workDir) {
    return { kind: "created", sandbox: await input.factory.create(input.templateId), resumeError: null };
  }

  try {
    return { kind: "resumed", sandbox: await input.factory.connect(input.workDir), resumeError: null };
  } catch (error) {
    const resumeError = error instanceof Error ? error : new Error("Sandbox resume failed");
    return {
      kind: "workspace_lost",
      sandbox: await input.factory.create(input.templateId),
      resumeError
    };
  }
}
