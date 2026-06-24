import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import { materializeChatPrompt, materializePrompt } from "../prompt";

describe("chat prompt materialization", () => {
  it("includes agent config and current user message on the first turn", () => {
    const prompt = materializeChatPrompt({
      agentSpec: defaultAgentSpec,
      message: "Research Acme Corp.",
      isResume: false
    });

    expect(prompt).toContain("Research Agent");
    expect(prompt).toContain("Research Acme Corp.");
    expect(prompt).toContain("Return the final answer as Markdown");
  });

  it("renders enabled apps and skills, including skill instructions", () => {
    const agentSpec = {
      ...defaultAgentSpec,
      apps: [{ ...defaultAgentSpec.apps[0], enabled: true }]
    };
    const prompt = materializeChatPrompt({
      agentSpec,
      message: "Research Acme Corp.",
      isResume: false
    });

    expect(prompt).toContain("## Enabled Apps");
    expect(prompt).toContain("- GitHub: Mock repository context for future MCP integration. (configuration-only)");
    expect(prompt).toContain("## Enabled Skills");
    expect(prompt).toContain(
      "- Research synthesis: Synthesize findings into a concise report with clear sections and no unsupported claims."
    );
    expect(prompt).toContain(
      "- Source citation: Cite sources when available. If a fact cannot be verified, mark it as unknown or uncertain."
    );
    expect(prompt).toContain(
      "- Executive summary: Begin the final report with a short executive summary and then provide supporting details."
    );
  });

  it("keeps the legacy materializePrompt(agentSpec, task) first-turn contract", () => {
    const prompt = materializePrompt({
      agentSpec: defaultAgentSpec,
      task: "Research Acme Corp."
    });

    expect(prompt).toContain("# Agent: Research Agent");
    expect(prompt).toContain("Persona: Careful research analyst");
    expect(prompt).toContain("Description: Researches companies, products, or markets and writes concise Markdown reports.");
    expect(prompt).toContain("## System Instructions");
    expect(prompt).toContain("## Enabled Apps");
    expect(prompt).toContain("## Enabled Skills");
    expect(prompt).toContain("## Enabled Abilities");
    expect(prompt).toContain("## Output Contract");
    expect(prompt).toContain("## User Task");
    expect(prompt).toContain("Research Acme Corp.");
    expect(prompt).not.toContain("## Session Instruction");
    expect(prompt).not.toContain("## Current User Message");
  });

  it("preserves product instructions when resuming an existing Codex session", () => {
    const prompt = materializeChatPrompt({
      agentSpec: defaultAgentSpec,
      message: "Now summarize competitors.",
      isResume: true
    });

    expect(prompt).toContain("You are continuing an existing Research Agent chat session.");
    expect(prompt).toContain("Now summarize competitors.");
    expect(prompt).toContain("Do not expose internal runner details");
  });
});
