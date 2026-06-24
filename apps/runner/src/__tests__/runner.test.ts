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

import { createRunnerEventEmitter } from "../runner-events-client";

describe("runner event client", () => {
  it("posts redacted incremental task events when runnerEvents is configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const emitEvent = createRunnerEventEmitter({
      taskId: "task-1",
      runnerEvents: {
        endpoint: "http://api.internal/internal/runner/task-events",
        token: "runner-token"
      },
      secretValues: ["sk-test"],
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
    });

    await emitEvent({ type: "status", tool: null, content: "started sk-test", inputJson: null, output: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api.internal/internal/runner/task-events");
    expect(calls[0].init.headers).toEqual({
      authorization: "Bearer runner-token",
      "content-type": "application/json"
    });
    expect(String(calls[0].init.body)).not.toContain("sk-test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      taskId: "task-1",
      messages: [{ type: "status", tool: null, content: "started [REDACTED]", inputJson: null, output: null }]
    });
  });

  it("no-ops incremental task events without runnerEvents or taskId", async () => {
    const emitEvent = createRunnerEventEmitter({
      taskId: undefined,
      runnerEvents: null,
      secretValues: ["sk-test"],
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });

    await expect(
      emitEvent({ type: "status", tool: null, content: "local only", inputJson: null, output: null })
    ).resolves.toBeUndefined();
  });
});
