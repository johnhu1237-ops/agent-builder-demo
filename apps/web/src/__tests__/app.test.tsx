import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { defaultUiAgentSpec, createExportPayload } from "../defaults";

describe("web defaults", () => {
  it("uses a single Research Agent without a goal field", () => {
    expect(defaultUiAgentSpec.identity.name).toBe("Research Agent");
    expect("goal" in defaultUiAgentSpec.identity).toBe(false);
  });

  it("exports Agent Spec without runtime API key", () => {
    const payload = createExportPayload({
      agentSpec: {
        ...defaultUiAgentSpec,
        model: { ...defaultUiAgentSpec.model, apiKey: "sk-test" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("sk-test");
    expect(payload.model.apiKeyRef).toBe("runtime-only");
  });
});
