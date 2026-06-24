import { describe, expect, it } from "vitest";
import { defaultAgentSpec, exportAgentSpec } from "../agent-spec";
import { createAssistantTaskMessage, createStatusTaskMessage, type CreateAgentTaskRequest, type RunnerTaskEventRequest } from "../chat";

describe("chat contracts", () => {
  it("models a follow-up task request without storing runtime secrets in snapshots", () => {
    const request: CreateAgentTaskRequest = {
      chatSessionId: "chat_session_1",
      message: "Continue with pricing.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-runtime-only" },
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-builder-demo/chat_session_1"
    };

    expect(request.chatSessionId).toBe("chat_session_1");
    expect(request.sessionId).toBe("codex-session-1");
    expect(JSON.stringify(exportAgentSpec(request.agentSpec))).not.toContain("sk-runtime-only");
    expect(JSON.stringify(exportAgentSpec(request.agentSpec))).toContain('"apiKeyRef":"runtime-only"');
  });

  it("creates task messages with product vocabulary", () => {
    expect(createStatusTaskMessage("Running Codex").type).toBe("status");
    expect(createAssistantTaskMessage("# Done").content).toBe("# Done");
  });
});

describe("runner chat contracts", () => {
  it("allows runner-internal event metadata on agent task requests", () => {
    const request = {
      chatSessionId: "chat-session-1",
      taskId: "task-1",
      message: "Research Acme.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      sessionId: null,
      workDir: null,
      runnerEvents: {
        endpoint: "http://localhost:4001/internal/runner/task-events",
        token: "runner-token"
      }
    } satisfies CreateAgentTaskRequest;

    expect(request.taskId).toBe("task-1");
    expect(request.runnerEvents?.endpoint).toContain("/internal/runner/task-events");
  });

  it("models incremental runner task event payloads", () => {
    const payload = {
      taskId: "task-1",
      messages: [
        {
          type: "status",
          tool: null,
          content: "E2B sandbox resumed",
          inputJson: null,
          output: null
        }
      ]
    } satisfies RunnerTaskEventRequest;

    expect(payload.messages[0].type).toBe("status");
  });
});
