import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { createCodexCommand } from "../codex-runner";
import { runFakeAgentTask } from "../fake-runner";
import { redactRunnerOutput } from "../redaction";
import { resolveWorkspacePath } from "../workspace";

describe("runner adapters", () => {
  it("fake runner returns deterministic session metadata and task messages", async () => {
    const result = await runFakeAgentTask({
      chatSessionId: "chat-session-1",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      message: "Research Acme Corp.",
      sessionId: null,
      workDir: null
    });

    expect(result.status).toBe("completed");
    expect(result.finalMarkdown).toContain("Research Acme Corp.");
    expect(result.sessionId).toBe("fake-session-chat-session-1");
    expect(result.workDir).toContain("fake-workspaces/chat-session-1");
    expect(result.taskMessages.map((event) => event.type)).toEqual(["status", "text", "status"]);
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("Codex command supports first-turn execution", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/work",
      finalPath: "/tmp/work/final.md",
      prompt: "Return Markdown.",
      sessionId: null
    });

    expect(command.args).toContain("exec");
    expect(command.args).not.toContain("resume");
    expect(command.args).toContain("--output-last-message");
  });

  it("Codex command supports resumed execution", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/work",
      finalPath: "/tmp/work/final.md",
      prompt: "Continue.",
      sessionId: "codex-session-1"
    });

    expect(command.args).toContain("resume");
    expect(command.args).toContain("codex-session-1");
    expect(command.args).toContain("Continue.");
  });

  it("redacts runtime API keys from raw output", () => {
    expect(redactRunnerOutput("OPENAI_API_KEY=sk-test secret", ["sk-test"])).toBe("OPENAI_API_KEY=[REDACTED] secret");
  });

  it("resolves a stable workspace path per chat session", async () => {
    const workDir = await resolveWorkspacePath({
      requestedWorkDir: null,
      chatSessionId: "chat-session-1",
      rootDir: "/tmp/agent-builder-demo-runner"
    });

    expect(workDir).toBe("/tmp/agent-builder-demo-runner/chat-session-1");
  });
});
