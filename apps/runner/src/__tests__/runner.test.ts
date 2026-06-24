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

import { buildCodexCommand } from "../e2b-command";
import { parseCodexJsonLine, extractSessionIdFromCodexEvent } from "../e2b-events";

describe("e2b command", () => {
  it("builds first-turn E2B Codex command without leaking secrets in args", () => {
    const command = buildCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/home/user/workspace",
      finalPath: "/home/user/workspace/final.md",
      promptPath: "/home/user/workspace/prompt.md",
      sessionId: null
    });

    expect(command).toContain("codex --search --ask-for-approval never exec --json");
    expect(command).toContain("--model 'gpt-5'");
    expect(command).toContain("--output-last-message '/home/user/workspace/final.md'");
    expect(command).toContain("-C '/home/user/workspace'");
    expect(command).toContain("$(cat '/home/user/workspace/prompt.md')");
    expect(command).not.toContain("sk-test");
  });

  it("builds resumed E2B Codex command", () => {
    const command = buildCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/home/user/workspace",
      finalPath: "/home/user/workspace/final.md",
      promptPath: "/home/user/workspace/prompt.md",
      sessionId: "codex-session-1"
    });

    expect(command).toContain("exec resume 'codex-session-1' --json");
  });
});

describe("e2b events", () => {
  it("parses Codex JSONL events into runner task messages", () => {
    expect(parseCodexJsonLine(JSON.stringify({ type: "session", session_id: "codex-session-1" }))).toEqual({
      message: { type: "status", tool: "codex", content: "Codex session established", inputJson: null, output: null },
      sessionId: "codex-session-1"
    });
    expect(parseCodexJsonLine(JSON.stringify({ type: "tool_call", tool: "web_search", arguments: { q: "Acme" } }))).toEqual({
      message: { type: "tool_use", tool: "web_search", content: "Tool call: web_search", inputJson: { q: "Acme" }, output: null },
      sessionId: null
    });
    expect(parseCodexJsonLine("not json")).toEqual({
      message: { type: "log", tool: "codex", content: "not json", inputJson: null, output: null },
      sessionId: null
    });
  });

  it("extracts session ids from known Codex event variants", () => {
    expect(extractSessionIdFromCodexEvent({ session_id: "snake" })).toBe("snake");
    expect(extractSessionIdFromCodexEvent({ sessionId: "camel" })).toBe("camel");
    expect(extractSessionIdFromCodexEvent({ type: "other" })).toBeNull();
  });
});

import { createE2BSandboxFactory, resolveSandbox } from "../e2b-sandbox";
import type { E2BSandboxLike } from "../e2b-types";

function fakeSandbox(id: string): E2BSandboxLike {
  return {
    sandboxId: id,
    commands: {
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 })
    },
    files: {
      write: async () => undefined,
      read: async () => "# Done"
    },
    pause: async () => undefined,
    kill: async () => undefined
  };
}

describe("e2b sandbox", () => {
  it("creates a new E2B sandbox when workDir is missing", async () => {
    const created: string[] = [];
    const factory = {
      create: async (templateId: string) => {
        created.push(templateId);
        return fakeSandbox("sandbox-new");
      },
      connect: async () => {
        throw new Error("connect should not be called");
      }
    };

    const result = await resolveSandbox({ workDir: null, templateId: "template-1", factory });

    expect(result.kind).toBe("created");
    expect(result.sandbox.sandboxId).toBe("sandbox-new");
    expect(created).toEqual(["template-1"]);
  });

  it("resumes an existing E2B sandbox when workDir is present", async () => {
    const connected: string[] = [];
    const factory = {
      create: async () => {
        throw new Error("create should not be called");
      },
      connect: async (sandboxId: string) => {
        connected.push(sandboxId);
        return fakeSandbox(sandboxId);
      }
    };

    const result = await resolveSandbox({ workDir: "sandbox-existing", templateId: "template-1", factory });

    expect(result.kind).toBe("resumed");
    expect(result.sandbox.sandboxId).toBe("sandbox-existing");
    expect(connected).toEqual(["sandbox-existing"]);
  });

  it("creates a fresh sandbox when resume fails", async () => {
    const factory = {
      create: async () => fakeSandbox("sandbox-fresh"),
      connect: async () => {
        throw new Error("sandbox not found");
      }
    };

    const result = await resolveSandbox({ workDir: "sandbox-lost", templateId: "template-1", factory });

    expect(result.kind).toBe("workspace_lost");
    expect(result.sandbox.sandboxId).toBe("sandbox-fresh");
    expect(result.resumeError?.message).toContain("sandbox not found");
  });
});
