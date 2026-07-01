import Arcade from "@arcadeai/arcadejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArcadeProviderToolDefinitionClient } from "../provider-tool-definition-client";

const toolsGetMock = vi.fn();

vi.mock("@arcadeai/arcadejs", () => ({
  default: vi.fn(() => ({
    tools: {
      get: toolsGetMock
    }
  }))
}));

describe("Arcade Provider Tool Definition client", () => {
  const originalArcadeApiKey = process.env.ARCADE_API_KEY;
  const originalArcadeBaseUrl = process.env.ARCADE_BASE_URL;

  beforeEach(() => {
    process.env.ARCADE_API_KEY = "arcade-api-key";
    delete process.env.ARCADE_BASE_URL;
    toolsGetMock.mockReset();
    vi.mocked(Arcade).mockClear();
  });

  afterEach(() => {
    process.env.ARCADE_API_KEY = originalArcadeApiKey;
    process.env.ARCADE_BASE_URL = originalArcadeBaseUrl;
  });

  it("loads the current Arcade tool definition for a connected account user", async () => {
    toolsGetMock.mockResolvedValue({
      input: {
        parameters: [{ name: "owner", required: true, value_schema: { val_type: "string" } }]
      }
    });
    const client = new ArcadeProviderToolDefinitionClient();

    await expect(
      client.getToolDefinition({
        arcadeUserId: "github-user-1",
        providerToolName: "Github.ListIssues"
      })
    ).resolves.toEqual({
      input: {
        parameters: [{ name: "owner", required: true, value_schema: { val_type: "string" } }]
      }
    });
    expect(Arcade).toHaveBeenCalledWith({ apiKey: "arcade-api-key" });
    expect(toolsGetMock).toHaveBeenCalledWith("Github.ListIssues", { user_id: "github-user-1" });
  });

  it("falls back when Arcade is not configured", async () => {
    delete process.env.ARCADE_API_KEY;
    const client = new ArcadeProviderToolDefinitionClient();

    await expect(
      client.getToolDefinition({
        arcadeUserId: "github-user-1",
        providerToolName: "Github.ListIssues"
      })
    ).resolves.toBeNull();
    expect(Arcade).not.toHaveBeenCalled();
  });
});
