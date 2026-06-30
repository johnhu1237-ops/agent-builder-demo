import type { ToolConfigurationMode } from "./chat-store";

export type ArcadeToolConfigurationSyncResult = {
  syncVersion?: string | null;
};

export type ArcadeToolConfigurationSyncer = {
  syncToolConfiguration(input: {
    agentId: string;
    toolConfigurationId: string;
    connectedAccountId: string;
    connectedAccountExternalId: string;
    appId: string;
    toolName: string;
    desiredMode: ToolConfigurationMode;
  }): Promise<ArcadeToolConfigurationSyncResult>;
};

export class NoopArcadeToolConfigurationSyncer implements ArcadeToolConfigurationSyncer {
  async syncToolConfiguration(): Promise<ArcadeToolConfigurationSyncResult> {
    return { syncVersion: "noop" };
  }
}
