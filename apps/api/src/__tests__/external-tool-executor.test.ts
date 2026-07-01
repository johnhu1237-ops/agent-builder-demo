import Arcade from "@arcadeai/arcadejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcadeApiToolExecutor } from "../external-tool-executor";

const toolsExecuteMock = vi.fn();

vi.mock("@arcadeai/arcadejs", () => ({
  default: vi.fn(() => ({
    tools: {
      execute: toolsExecuteMock
    }
  }))
}));

describe("Arcade API Tool Executor", () => {
  const originalArcadeApiKey = process.env.ARCADE_API_KEY;
  const originalArcadeBaseUrl = process.env.ARCADE_BASE_URL;

  beforeEach(() => {
    process.env.ARCADE_API_KEY = "arcade-api-key";
    delete process.env.ARCADE_BASE_URL;
    toolsExecuteMock.mockReset();
    vi.mocked(Arcade).mockClear();
  });

  afterEach(() => {
    process.env.ARCADE_API_KEY = originalArcadeApiKey;
    process.env.ARCADE_BASE_URL = originalArcadeBaseUrl;
  });

  it("executes the registry provider tool name through Arcade and returns output value as MCP JSON text", async () => {
    toolsExecuteMock.mockResolvedValue({
      id: "exec_1",
      output: {
        value: {
          issues: [{ number: 37, title: "Execute github_list_issues" }]
        }
      },
      success: true
    });
    const executor = new ArcadeApiToolExecutor();

    const result = await executor.executeTool({
      arcadeUserId: "github-user-1",
      provider: "github",
      mcpToolName: "github_list_issues",
      providerToolName: "Github.ListIssues",
      args: { query: "repo:johnhu1237-ops/agent-builder-demo issue 37" }
    });

    expect(Arcade).toHaveBeenCalledWith({ apiKey: "arcade-api-key" });
    expect(toolsExecuteMock).toHaveBeenCalledWith({
      user_id: "github-user-1",
      tool_name: "Github.ListIssues",
      input: { owner: "johnhu1237-ops", repo: "agent-builder-demo" }
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ issues: [{ number: 37, title: "Execute github_list_issues" }] }, null, 2)
        }
      ]
    });
  });

  it("passes explicit Github.ListIssues owner and repo arguments through to Arcade", async () => {
    toolsExecuteMock.mockResolvedValue({
      output: {
        value: {
          issues: [{ number: 39, title: "List explicit repo issues" }]
        }
      },
      success: true
    });
    const executor = new ArcadeApiToolExecutor();

    await executor.executeTool({
      arcadeUserId: "github-user-1",
      provider: "github",
      mcpToolName: "github_list_issues",
      providerToolName: "Github.ListIssues",
      args: { owner: "johnhu1237-ops", repo: "agent-builder-demo", state: "open" }
    });

    expect(toolsExecuteMock).toHaveBeenCalledWith({
      user_id: "github-user-1",
      tool_name: "Github.ListIssues",
      input: { owner: "johnhu1237-ops", repo: "agent-builder-demo", state: "open" }
    });
  });

  it("returns Arcade execution failures as MCP error content without leaking the API key", async () => {
    toolsExecuteMock.mockResolvedValue({
      output: {
        error: {
          message: "Arcade failed while using arcade-api-key"
        }
      },
      success: false
    });
    const executor = new ArcadeApiToolExecutor();

    const result = await executor.executeTool({
      arcadeUserId: "github-user-1",
      provider: "github",
      mcpToolName: "github_list_issues",
      providerToolName: "Github.ListIssues",
      args: { query: "repo:johnhu1237-ops/agent-builder-demo issue 37" }
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Arcade failed while using [REDACTED]" }]
    });
  });

  it("returns Arcade SDK exceptions as MCP error content without leaking the API key", async () => {
    toolsExecuteMock.mockRejectedValue(new Error("Request failed with arcade-api-key"));
    const executor = new ArcadeApiToolExecutor();

    const result = await executor.executeTool({
      arcadeUserId: "github-user-1",
      provider: "github",
      mcpToolName: "github_list_issues",
      providerToolName: "Github.ListIssues",
      args: { query: "repo:johnhu1237-ops/agent-builder-demo issue 37" }
    });

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Request failed with [REDACTED]" }]
    });
  });
});
