import Arcade from "@arcadeai/arcadejs";

import type { ProviderToolDefinition } from "./product-tool-registry";

export type ProviderToolDefinitionClient = {
  getToolDefinition(input: {
    arcadeUserId?: string;
    providerToolName: string;
  }): Promise<ProviderToolDefinition | null>;
};

export class ArcadeProviderToolDefinitionClient implements ProviderToolDefinitionClient {
  private readonly apiKey = process.env.ARCADE_API_KEY?.trim() ?? "";
  private readonly baseUrl = process.env.ARCADE_BASE_URL?.trim() ?? "";

  private createClient(): Arcade | null {
    if (!this.apiKey) {
      return null;
    }
    return new Arcade({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {})
    });
  }

  async getToolDefinition(input: {
    arcadeUserId?: string;
    providerToolName: string;
  }): Promise<ProviderToolDefinition | null> {
    const client = this.createClient();
    if (!client) {
      return null;
    }
    return client.tools.get(input.providerToolName, input.arcadeUserId ? { user_id: input.arcadeUserId } : {});
  }
}
