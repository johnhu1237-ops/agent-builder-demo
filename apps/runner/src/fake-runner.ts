import type { CreateRunRequest, RunnerResponse } from "@agent-builder/shared";

export async function runFakeAgent(request: CreateRunRequest): Promise<RunnerResponse> {
  const finalMarkdown = [
    "# Research Report",
    "",
    "## Executive Summary",
    `This is a deterministic demo report for: ${request.task}`,
    "",
    "## Findings",
    "- The configured Research Agent received the task.",
    "- Web Research is enabled as the real v0.1 ability.",
    "- Mock apps remain configuration-only.",
    "",
    "## Recommendation",
    "Use the Codex runner smoke path after deployment credentials are configured."
  ].join("\n");

  return {
    finalMarkdown,
    rawOutput: "fake runner completed successfully",
    events: [
      { type: "starting", message: "Starting runner" },
      { type: "researching", message: "Researching task context" },
      { type: "generating_report", message: "Generating Markdown report" },
      { type: "completed", message: "Run completed" }
    ]
  };
}
