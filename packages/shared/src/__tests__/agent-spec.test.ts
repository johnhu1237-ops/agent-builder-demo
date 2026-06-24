import { describe, expect, it } from "vitest";
import { defaultAgentSpec, exportAgentSpec, validateAgentSpec } from "../agent-spec";

describe("Agent Spec validation", () => {
  it("accepts the default Research Agent spec", () => {
    const result = validateAgentSpec(defaultAgentSpec);
    expect(result.success).toBe(true);
  });

  it("does not include persona in the default agent identity", () => {
    expect("persona" in defaultAgentSpec.identity).toBe(false);
  });

  it("strips legacy persona fields from persisted specs", () => {
    const result = validateAgentSpec({
      ...defaultAgentSpec,
      identity: {
        ...defaultAgentSpec.identity,
        persona: "Legacy persona"
      }
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect("persona" in result.data.identity).toBe(false);
    }
  });

  it("rejects unknown plugin ids", () => {
    const result = validateAgentSpec({
      ...defaultAgentSpec,
      apps: [{ id: "unknown-app", enabled: true, mode: "configuration-only" }]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Unknown app id: unknown-app");
    }
  });

  it("exports specs without API keys", () => {
    const exported = exportAgentSpec({
      ...defaultAgentSpec,
      model: {
        ...defaultAgentSpec.model,
        apiKey: "sk-secret"
      }
    });
    expect(JSON.stringify(exported)).not.toContain("sk-secret");
    expect(JSON.stringify(exported)).not.toContain("persona");
    expect(exported.model.apiKeyRef).toBe("runtime-only");
  });
});
