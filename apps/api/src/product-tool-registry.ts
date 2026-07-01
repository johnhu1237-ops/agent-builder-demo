import type { ToolConfigurationMode } from "./chat-store";

export type ProductToolDefinition = {
  provider: string;
  connectedAppId: string;
  mcpToolName: string;
  providerToolName: string;
  displayName: string;
  description: string;
  defaultMode: Extract<ToolConfigurationMode, "ask_each_time">;
  inputSchema: unknown;
  previewFields: string[];
};

const productToolDefinitions = [
  {
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
  }
] as const satisfies ProductToolDefinition[];

const legacyToolDefinitions = [
  {
    provider: "github",
    connectedAppId: "github",
    mcpToolName: "github_create_issue",
    providerToolName: "github_create_issue",
    displayName: "Create issue",
    description: "Create a GitHub issue through the product MCP gateway.",
    defaultMode: "ask_each_time",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" }
      },
      required: ["title"]
    },
    previewFields: ["title"]
  },
  {
    provider: "slack",
    connectedAppId: "mock-slack",
    mcpToolName: "slack_post_message",
    providerToolName: "slack_post_message",
    displayName: "Post message",
    description: "Post a Slack message through the product MCP gateway.",
    defaultMode: "ask_each_time",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        text: { type: "string" }
      },
      required: ["channel", "text"]
    },
    previewFields: ["channel", "text"]
  },
  {
    provider: "notion",
    connectedAppId: "mock-notion",
    mcpToolName: "notion_create_page",
    providerToolName: "notion_create_page",
    displayName: "Create page",
    description: "Create a Notion page through the product MCP gateway.",
    defaultMode: "ask_each_time",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" }
      },
      required: ["title"]
    },
    previewFields: ["title"]
  }
] as const satisfies ProductToolDefinition[];

export const productToolRegistry = [...productToolDefinitions, ...legacyToolDefinitions];

export function listProductToolDefinitionsForConnectedApp(connectedAppId: string): ProductToolDefinition[] {
  return productToolRegistry.filter((definition) => definition.connectedAppId === connectedAppId);
}

export function findProductToolDefinition(input: {
  connectedAppId: string;
  mcpToolName: string;
}): ProductToolDefinition | null {
  return (
    productToolRegistry.find(
      (definition) =>
        definition.connectedAppId === input.connectedAppId && definition.mcpToolName === input.mcpToolName
    ) ?? null
  );
}

export function toMcpTool(definition: ProductToolDefinition) {
  return {
    name: definition.mcpToolName,
    description: definition.description,
    inputSchema: definition.inputSchema
  };
}
