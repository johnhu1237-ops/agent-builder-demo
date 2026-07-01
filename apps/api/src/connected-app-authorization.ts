import Arcade from "@arcadeai/arcadejs";

export type ConnectedAppProvider = "github";

export function getArcadeUserId(): string {
  return process.env.ARCADE_USER_ID?.trim() || "demo-user";
}

export const githubConnectedAppProvider = {
  provider: "github",
  appId: "github",
  get arcadeUserId() {
    return getArcadeUserId();
  },
  authorizationProbeTool: "Github.ListIssues",
  connectedAccountLabel: "GitHub via Arcade",
  get connectedAccountExternalId() {
    return getArcadeUserId();
  }
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
  private readonly baseUrl = process.env.ARCADE_BASE_URL?.trim() ?? "";
  private readonly githubProviderId = process.env.ARCADE_GITHUB_PROVIDER_ID?.trim() ?? "";

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("ARCADE_API_KEY is required for Arcade Connected App Authorization");
    }
    if (!this.githubProviderId) {
      throw new Error("ARCADE_GITHUB_PROVIDER_ID is required for Arcade GitHub authorization");
    }
  }

  private createClient(): Arcade {
    return new Arcade({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {})
    });
  }

  private githubAuthRequirement() {
    return {
      provider_id: this.githubProviderId,
      provider_type: "oauth2",
      oauth2: {
        scopes: []
      }
    };
  }

  async authorize(input: {
    provider: ConnectedAppProvider;
    userId: string;
    toolName: string;
    returnUrl: string;
  }): Promise<{ authorizationUrl: string }> {
    this.assertConfigured();
    const client = this.createClient();
    const authorization = await client.auth.authorize({
      auth_requirement: this.githubAuthRequirement(),
      user_id: input.userId,
      next_uri: input.returnUrl
    });
    if (authorization.url) {
      return { authorizationUrl: authorization.url };
    }
    if (authorization.status === "completed") {
      return { authorizationUrl: input.returnUrl };
    }
    throw new Error("Arcade did not provide a GitHub authorization URL");
  }

  async isAuthorized(input: {
    provider: ConnectedAppProvider;
    userId: string;
    toolName: string;
  }): Promise<boolean> {
    this.assertConfigured();
    const client = this.createClient();
    const authorization = await client.auth.authorize({
      auth_requirement: this.githubAuthRequirement(),
      user_id: input.userId
    });
    return authorization.status === "completed";
  }
}
