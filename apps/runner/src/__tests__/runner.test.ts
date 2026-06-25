import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { DEFAULT_RUN_TIMEOUT_MS } from "../e2b-runner";
import { runFakeAgentTask } from "../fake-runner";
import { redactRunnerOutput } from "../redaction";

describe("runner adapters", () => {
  it("defaults E2B command timeout to 90 seconds", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(90000);
  });

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

  it("redacts runtime API keys from raw output", () => {
    expect(redactRunnerOutput("OPENAI_API_KEY=sk-test secret", ["sk-test"])).toBe("OPENAI_API_KEY=[REDACTED] secret");
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
      apiEndpoint: "https://api.deepseek.com",
      workspacePath: "/home/user/workspace",
      finalPath: "/home/user/workspace/final.md",
      promptPath: "/home/user/workspace/prompt.md",
      sessionId: null
    });

    expect(command).toContain("codex exec --full-auto --skip-git-repo-check --json");
    expect(command).toContain("--model 'gpt-5'");
    expect(command).toContain("-c 'model_provider=agent_builder_openai_compatible'");
    expect(command).toContain("-c 'model_providers.agent_builder_openai_compatible.base_url=https://api.deepseek.com'");
    expect(command).toContain("-c 'model_providers.agent_builder_openai_compatible.wire_api=responses'");
    expect(command).toContain("-c 'model_providers.agent_builder_openai_compatible.requires_openai_auth=true'");
    expect(command).toContain("--output-last-message '/home/user/workspace/final.md'");
    expect(command).toContain("-C '/home/user/workspace'");
    expect(command).toContain("$(cat '/home/user/workspace/prompt.md')");
    expect(command).not.toContain("sk-test");
  });

  it("builds resumed E2B Codex command", () => {
    const command = buildCodexCommand({
      modelName: "gpt-5",
      apiEndpoint: "https://api.openai.com/v1",
      workspacePath: "/home/user/workspace",
      finalPath: "/home/user/workspace/final.md",
      promptPath: "/home/user/workspace/prompt.md",
      sessionId: "codex-session-1"
    });

    expect(command).toContain("exec resume 'codex-session-1' --full-auto --skip-git-repo-check --json");
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
    const created: Array<{ templateId: string; envs?: Record<string, string> }> = [];
    const factory = {
      create: async (templateId: string, runtime?: { envs?: Record<string, string> }) => {
        created.push({ templateId, envs: runtime?.envs });
        return fakeSandbox("sandbox-new");
      },
      connect: async () => {
        throw new Error("connect should not be called");
      }
    };

    const result = await resolveSandbox({ workDir: null, templateId: "template-1", factory, envs: { CODEX_API_KEY: "sk-test" } });

    expect(result.kind).toBe("created");
    expect(result.sandbox.sandboxId).toBe("sandbox-new");
    expect(created).toEqual([{ templateId: "template-1", envs: { CODEX_API_KEY: "sk-test" } }]);
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

    const result = await resolveSandbox({
      workDir: "sandbox-existing",
      templateId: "template-1",
      factory,
      envs: { CODEX_API_KEY: "sk-test" }
    });

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

import { runE2BAgentTask } from "../e2b-runner";

it("keeps fake runner deterministic after runner contract expansion", async () => {
  const result = await runFakeAgentTask({
    chatSessionId: "chat-session-1",
    taskId: "task-1",
    agentSpec: defaultAgentSpec,
    runtimeSecrets: { apiKey: "sk-test" },
    message: "Research Acme Corp.",
    sessionId: null,
    workDir: null,
    runnerEvents: null
  });

  expect(result.status).toBe("completed");
  expect(result.sessionId).toBe("fake-session-chat-session-1");
  expect(JSON.stringify(result)).not.toContain("sk-test");
});

describe("e2b runner", () => {
  it("runs a first-turn E2B task with command-scoped model envs and pauses the sandbox", async () => {
    const emitted: string[] = [];
    const sandbox = fakeSandbox("sandbox-1");
    const runCalls: Array<{ command: string; opts: any }> = [];
    const createCalls: Array<{ templateId: string; envs?: Record<string, string> }> = [];
    sandbox.commands.run = async (command, opts) => {
      runCalls.push({ command, opts });
      await opts?.onStdout?.(JSON.stringify({ session_id: "codex-session-1" }) + "\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    sandbox.files.read = async (path) => {
      expect(path).toBe("/home/user/workspace/final.md");
      return "# Final answer";
    };
    sandbox.pause = async () => {
      emitted.push("paused");
    };

    const result = await runE2BAgentTask(
      {
        chatSessionId: "chat-session-1",
        taskId: "task-1",
        message: "Research Acme.",
        agentSpec: defaultAgentSpec,
        runtimeSecrets: { apiKey: "sk-test" },
        sessionId: null,
        workDir: null,
        runnerEvents: null
      },
      {
        timeoutMs: 120000,
        templateId: "template-1",
        factory: {
          create: async (templateId, runtime) => {
            createCalls.push({ templateId, envs: runtime?.envs });
            return sandbox;
          },
          connect: async () => {
            throw new Error("connect should not run");
          }
        },
        emitEvent: async (event) => {
          emitted.push(event.content);
        }
      }
    );

    expect(result.status).toBe("completed");
    expect(result.finalMarkdown).toBe("# Final answer");
    expect(result.sessionId).toBe("codex-session-1");
    expect(result.workDir).toBe("sandbox-1");
    expect(createCalls).toEqual([{ templateId: "template-1", envs: { CODEX_API_KEY: "sk-test" } }]);
    expect(runCalls[0].opts.envs).toEqual({
      CODEX_API_KEY: "sk-test"
    });
    expect(runCalls[0].opts.envs).not.toHaveProperty("OPENAI_API_KEY");
    expect(runCalls[0].opts.envs).not.toHaveProperty("E2B_API_KEY");
    expect(emitted).toContain("Codex session established");
    expect(emitted).toContain("paused");
  });

  it("resets session pointer when workspace loss creates a fresh sandbox", async () => {
    const sandbox = fakeSandbox("sandbox-fresh");
    sandbox.commands.run = async (_command, opts) => {
      await opts?.onStdout?.(JSON.stringify({ session_id: "codex-session-fresh" }) + "\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await runE2BAgentTask(
      {
        chatSessionId: "chat-session-1",
        taskId: "task-1",
        message: "Continue.",
        agentSpec: defaultAgentSpec,
        runtimeSecrets: { apiKey: "sk-test" },
        sessionId: "codex-session-old",
        workDir: "sandbox-lost",
        runnerEvents: null
      },
      {
        timeoutMs: 120000,
        templateId: "template-1",
        factory: {
          create: async () => sandbox,
          connect: async () => {
            throw new Error("sandbox not found");
          }
        },
        emitEvent: async () => undefined
      }
    );

    expect(result.sessionId).toBe("codex-session-fresh");
    expect(result.workDir).toBe("sandbox-fresh");
    expect(JSON.stringify(result)).not.toContain("codex-session-old");
  });
});
