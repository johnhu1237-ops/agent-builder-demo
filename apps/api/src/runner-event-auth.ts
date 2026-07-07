import type { Request } from "express";

export function getRunnerEventToken(): string | null {
  const token = process.env.RUNNER_EVENT_TOKEN?.trim();
  return token ? token : null;
}

export function requireRunnerEventAuth(req: Request): boolean {
  const expected = getRunnerEventToken();
  if (!expected) {
    return false;
  }
  const header = req.header("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export function runnerEventEndpoint(): string {
  const baseUrl =
    process.env.API_INTERNAL_BASE_URL?.trim() ||
    process.env.API_PUBLIC_BASE_URL?.trim() ||
    "http://localhost:4001";
  return `${baseUrl.replace(/\/$/, "")}/internal/runner/task-events`;
}

export function agentTaskMcpGatewayEndpoint(): string {
  const baseUrl = process.env.API_PUBLIC_BASE_URL?.trim() || "http://localhost:4001";
  return `${baseUrl.replace(/\/$/, "")}/mcp/agent-task`;
}
