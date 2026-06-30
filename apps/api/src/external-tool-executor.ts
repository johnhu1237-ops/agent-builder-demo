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

export class ArcadeApiToolExecutor implements ExternalToolExecutor {
  async executeTool(): Promise<ExternalToolExecutionResult> {
    throw new Error("Arcade API tool executor is not configured");
  }
}
