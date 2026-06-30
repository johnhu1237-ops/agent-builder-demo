export type ConnectedAppProvider = "github";

export const githubConnectedAppProvider = {
  provider: "github",
  appId: "mock-github",
  arcadeUserId: "demo-user",
  authorizationProbeTool: "Github.ListIssues",
  connectedAccountLabel: "GitHub via Arcade",
  connectedAccountExternalId: "demo-user"
} as const;

export type ConnectedAppAuthorizationClient = {
  authorize(input: {
    provider: ConnectedAppProvider;
    userId: string;
    toolName: string;
    returnUrl: string;
  }): Promise<{ authorizationUrl: string }>;

  isAuthorized(input: {
    provider: ConnectedAppProvider;
    userId: string;
    toolName: string;
  }): Promise<boolean>;
};

export class ArcadeConnectedAppAuthorizationClient implements ConnectedAppAuthorizationClient {
  private readonly apiKey = process.env.ARCADE_API_KEY?.trim() ?? "";

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("ARCADE_API_KEY is required for Arcade Connected App Authorization");
    }
  }

  async authorize(): Promise<{ authorizationUrl: string }> {
    this.assertConfigured();
    throw new Error("Arcade Connected App Authorization client is not configured");
  }

  async isAuthorized(): Promise<boolean> {
    this.assertConfigured();
    throw new Error("Arcade Connected App Authorization client is not configured");
  }
}
