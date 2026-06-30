import Arcade from "@arcadeai/arcadejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcadeConnectedAppAuthorizationClient } from "../connected-app-authorization";

const authAuthorizeMock = vi.fn();

vi.mock("@arcadeai/arcadejs", () => ({
  default: vi.fn(() => ({
    auth: {
      authorize: authAuthorizeMock
    }
  }))
}));

describe("Arcade Connected App Authorization client", () => {
  const originalArcadeApiKey = process.env.ARCADE_API_KEY;
  const originalArcadeGithubProviderId = process.env.ARCADE_GITHUB_PROVIDER_ID;

  beforeEach(() => {
    process.env.ARCADE_API_KEY = "arcade-api-key";
    process.env.ARCADE_GITHUB_PROVIDER_ID = "github-provider-id";
    authAuthorizeMock.mockReset();
    vi.mocked(Arcade).mockClear();
  });

  afterEach(() => {
    process.env.ARCADE_API_KEY = originalArcadeApiKey;
    process.env.ARCADE_GITHUB_PROVIDER_ID = originalArcadeGithubProviderId;
  });

  it("starts GitHub authorization through the configured Arcade GitHub provider", async () => {
    authAuthorizeMock.mockResolvedValue({
      status: "pending",
      url: "https://arcade.dev/authorize/github/demo"
    });
    const client = new ArcadeConnectedAppAuthorizationClient();

    const authorization = await client.authorize({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues",
      returnUrl: "http://localhost:5173/oauth/arcade/github/callback?agentId=agent_1"
    });

    expect(Arcade).toHaveBeenCalledWith({ apiKey: "arcade-api-key" });
    expect(authAuthorizeMock).toHaveBeenCalledWith({
      auth_requirement: {
        provider_id: "github-provider-id",
        provider_type: "oauth2",
        oauth2: {
          scopes: []
        }
      },
      user_id: "demo-user",
      next_uri: "http://localhost:5173/oauth/arcade/github/callback?agentId=agent_1"
    });
    expect(authorization).toEqual({
      authorizationUrl: "https://arcade.dev/authorize/github/demo"
    });
  });

  it("returns the frontend callback URL when GitHub is already authorized in Arcade", async () => {
    authAuthorizeMock.mockResolvedValue({
      id: "ac_1",
      user_id: "demo-user",
      provider_id: "github-provider-id",
      status: "completed",
      context: {
        token: "ghu_secret",
        user_info: {
          login: "johnhu1237-ops"
        }
      }
    });
    const client = new ArcadeConnectedAppAuthorizationClient();
    const returnUrl = "http://localhost:5173/oauth/arcade/github/callback?agentId=agent_1";

    const authorization = await client.authorize({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues",
      returnUrl
    });

    expect(authorization).toEqual({ authorizationUrl: returnUrl });
    expect(JSON.stringify(authorization)).not.toContain("ghu_secret");
  });

  it("checks GitHub authorization through the configured Arcade GitHub provider status", async () => {
    authAuthorizeMock.mockResolvedValue({
      status: "completed"
    });
    const client = new ArcadeConnectedAppAuthorizationClient();

    const isAuthorized = await client.isAuthorized({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues"
    });

    expect(authAuthorizeMock).toHaveBeenCalledWith({
      auth_requirement: {
        provider_id: "github-provider-id",
        provider_type: "oauth2",
        oauth2: {
          scopes: []
        }
      },
      user_id: "demo-user"
    });
    expect(isAuthorized).toBe(true);
  });

  it("treats incomplete Arcade authorization as not authorized", async () => {
    authAuthorizeMock.mockResolvedValue({
      status: "pending",
      url: "https://arcade.dev/authorize/github/demo"
    });
    const client = new ArcadeConnectedAppAuthorizationClient();

    const isAuthorized = await client.isAuthorized({
      provider: "github",
      userId: "demo-user",
      toolName: "Github.ListIssues"
    });

    expect(isAuthorized).toBe(false);
  });
});
