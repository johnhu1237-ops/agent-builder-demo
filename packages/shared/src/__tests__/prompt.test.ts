import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import { materializePrompt } from "../prompt";

describe("prompt materialization", () => {
  it("includes identity, system prompt, enabled skills, enabled abilities, mock app context, and task", () => {
    const prompt = materializePrompt({
      agentSpec: {
        ...defaultAgentSpec,
        apps: defaultAgentSpec.apps.map((app) =>
          app.id === "mock-github" ? { ...app, enabled: true } : app
        )
      },
      task: "Research Acme Corp."
    });

    expect(prompt).toContain("Research Agent");
    expect(prompt).toContain(defaultAgentSpec.systemPrompt);
    expect(prompt).toContain("Research synthesis");
    expect(prompt).toContain("Web Research");
    expect(prompt).toContain("GitHub");
    expect(prompt).toContain("configuration-only");
    expect(prompt).toContain("Research Acme Corp.");
    expect(prompt).toContain("Markdown");
  });

  it("excludes disabled skills and apps", () => {
    const prompt = materializePrompt({
      agentSpec: {
        ...defaultAgentSpec,
        apps: defaultAgentSpec.apps.map((app) => ({ ...app, enabled: false })),
        skills: defaultAgentSpec.skills.map((skill) =>
          skill.id === "executive-summary" ? { ...skill, enabled: false } : skill
        )
      },
      task: "Research Globex."
    });

    expect(prompt).not.toContain("GitHub");
    expect(prompt).not.toContain("Executive summary");
  });
});
