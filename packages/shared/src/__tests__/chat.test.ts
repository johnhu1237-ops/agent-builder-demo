import { describe, expect, it } from "vitest";
import { defaultAgentSpec, exportAgentSpec } from "../agent-spec";
import { createAssistantTaskMessage, createStatusTaskMessage, type CreateAgentTaskRequest } from "../chat";

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
