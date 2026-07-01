import { describe, expect, it } from "vitest";

import { findProductToolDefinition, listProductToolDefinitionsForConnectedApp } from "../product-tool-registry";

describe("Product Tool Registry", () => {
  it("contains the GitHub issue search Tool Definition", () => {
    expect(
      findProductToolDefinition({
        connectedAppId: "github",
        mcpToolName: "github_search_issues"
      })
    ).toEqual({
      provider: "github",
      connectedAppId: "github",
      mcpToolName: "github_search_issues",
      providerToolName: "Github.SearchIssues",
      displayName: "Search issues",
      description: "Search GitHub issues through the product MCP gateway.",
      defaultMode: "ask_each_time",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      },
      previewFields: ["query"]
    });
  });

  it("lists Tool Definitions by connected app without assuming a single provider", () => {
    expect(listProductToolDefinitionsForConnectedApp("github").map((definition) => definition.mcpToolName)).toEqual([
      "github_search_issues",
      "github_create_issue"
    ]);
    expect(listProductToolDefinitionsForConnectedApp("mock-slack").map((definition) => definition.mcpToolName)).toEqual([
      "slack_post_message"
    ]);
  });
});
