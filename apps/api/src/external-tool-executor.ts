import Arcade from "@arcadeai/arcadejs";

export type ExternalToolExecutionResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
};

export type ExternalToolExecutor = {
  executeTool(input: {
    arcadeUserId: string;
    provider: string;
    mcpToolName: string;
    providerToolName: string;
    args: unknown;
  }): Promise<ExternalToolExecutionResult>;
};

function redactArcadeCredential(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[REDACTED]") : message;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeGithubListIssuesArgs(args: unknown): Record<string, unknown> {
  const input = toRecord(args);
  if (typeof input.owner === "string" && input.owner && typeof input.repo === "string" && input.repo) {
    return input;
  }

  if (typeof input.query !== "string") {
    return input;
  }

  const repoMatch = input.query.match(/\brepo:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!repoMatch) {
    return input;
  }

  const normalized: Record<string, unknown> = {
    ...input,
    owner: repoMatch[1],
    repo: repoMatch[2]
  };
  delete normalized.query;
  return normalized;
}

function normalizeProviderToolArgs(input: {
  providerToolName: string;
  args: unknown;
}): Record<string, unknown> {
  if (input.providerToolName === "Github.ListIssues") {
    return normalizeGithubListIssuesArgs(input.args);
  }
  return toRecord(input.args);
}

export class ArcadeApiToolExecutor implements ExternalToolExecutor {
  private readonly apiKey = process.env.ARCADE_API_KEY?.trim() ?? "";
  private readonly baseUrl = process.env.ARCADE_BASE_URL?.trim() ?? "";

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("ARCADE_API_KEY is required for Arcade tool execution");
    }
  }

  private createClient(): Arcade {
    return new Arcade({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {})
    });
  }

  async executeTool(input: Parameters<ExternalToolExecutor["executeTool"]>[0]): Promise<ExternalToolExecutionResult> {
    this.assertConfigured();
    const client = this.createClient();
    let execution: Awaited<ReturnType<Arcade["tools"]["execute"]>>;
    try {
      execution = await client.tools.execute({
        user_id: input.arcadeUserId,
        tool_name: input.providerToolName,
        input: normalizeProviderToolArgs(input)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Arcade tool execution failed";
      return {
        isError: true,
        content: [{ type: "text", text: redactArcadeCredential(message, this.apiKey) }]
      };
    }

    if (execution.success === false || execution.output?.error) {
      const message = execution.output?.error?.message ?? "Arcade tool execution failed";
      return {
        isError: true,
        content: [{ type: "text", text: redactArcadeCredential(message, this.apiKey) }]
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(execution.output?.value ?? execution, null, 2)
        }
      ]
    };
  }
}
