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

export type ProviderToolDefinition = {
  input?: {
    parameters?: Array<{
      name: string;
      description?: string;
      required?: boolean;
      value_schema?: {
        val_type?: string;
        enum?: string[];
        inner_val_type?: string;
      };
    }>;
  };
};

const productToolDefinitions = [
  {
    provider: "github",
    connectedAppId: "github",
    mcpToolName: "github_list_issues",
    providerToolName: "Github.ListIssues",
    displayName: "List issues",
    description: "List GitHub issues through the product MCP gateway.",
    defaultMode: "ask_each_time",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] }
      },
      required: ["owner", "repo"]
    },
    previewFields: ["owner", "repo", "state"]
  }
] as const satisfies ProductToolDefinition[];

const legacyToolDefinitions = [
  {
    provider: "github",
    connectedAppId: "github",
    mcpToolName: "github_create_issue",
    providerToolName: "GitHub.CreateIssue",
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

function valueSchemaToJsonSchema(valueSchema: NonNullable<NonNullable<ProviderToolDefinition["input"]>["parameters"]>[number]["value_schema"]) {
  const valType = valueSchema?.val_type?.toLowerCase();
  const jsonSchema: Record<string, unknown> = {};

  if (valueSchema?.enum?.length) {
    jsonSchema.enum = valueSchema.enum;
  }

  if (valType === "integer" || valType === "int") {
    return { type: "integer", ...jsonSchema };
  }
  if (valType === "number" || valType === "float") {
    return { type: "number", ...jsonSchema };
  }
  if (valType === "boolean" || valType === "bool") {
    return { type: "boolean", ...jsonSchema };
  }
  if (valType === "array" || valType === "list") {
    const innerType = valueSchema?.inner_val_type?.toLowerCase();
    return {
      type: "array",
      items: { type: innerType === "integer" || innerType === "int" ? "integer" : innerType || "string" },
      ...jsonSchema
    };
  }
  if (valType === "object" || valType === "dict") {
    return { type: "object", ...jsonSchema };
  }
  return { type: "string", ...jsonSchema };
}

export function toMcpToolWithProviderDefinition(
  definition: ProductToolDefinition,
  providerDefinition: ProviderToolDefinition | null
) {
  const parameters = providerDefinition?.input?.parameters;
  if (!parameters?.length) {
    return toMcpTool(definition);
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    properties[parameter.name] = {
      ...valueSchemaToJsonSchema(parameter.value_schema),
      ...(parameter.description ? { description: parameter.description } : {})
    };
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  return {
    name: definition.mcpToolName,
    description: definition.description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {})
    }
  };
}
