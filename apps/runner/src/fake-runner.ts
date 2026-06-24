import { createAssistantTaskMessage, createStatusTaskMessage, type CreateAgentTaskRequest, type RunnerAgentTaskResponse } from "@agent-builder/shared";

export async function runFakeAgentTask(request: CreateAgentTaskRequest): Promise<RunnerAgentTaskResponse> {
  const sessionId = request.sessionId ?? `fake-session-${request.chatSessionId}`;
  const workDir = request.workDir ?? `/tmp/agent-builder-demo/fake-workspaces/${request.chatSessionId}`;
  const finalMarkdown = [
    "# Research Report",
    "",
    "## Executive Summary",
    `This is a deterministic demo response for: ${request.message}`,
    "",
    "## Session",
    request.sessionId ? "Session resumed." : "Fresh session started.",
    "",
    "## Recommendation",
    "Use Codex mode after deployment credentials and persistent runner storage are configured."
  ].join("\n");

  return {
    status: "completed",
    finalMarkdown,
    rawOutputRedacted: "fake runner completed successfully",
    sessionId,
    workDir,
    taskMessages: [
      createStatusTaskMessage(request.sessionId ? "Resuming fake session" : "Starting fake session"),
      createAssistantTaskMessage(finalMarkdown),
      createStatusTaskMessage("Task completed")
    ]
  };
}
