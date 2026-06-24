import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { runFakeAgent } from "../fake-runner";
import { createCodexCommand } from "../codex-runner";

describe("runner adapters", () => {
  it("fake runner returns deterministic Markdown and events", async () => {
    const result = await runFakeAgent({
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      task: "Research Acme Corp."
    });

    expect(result.finalMarkdown).toContain("# Research Report");
    expect(result.finalMarkdown).toContain("Research Acme Corp.");
    expect(result.rawOutput).toContain("fake runner");
    expect(result.events.map((event) => event.type)).toEqual([
      "starting",
      "researching",
      "generating_report",
      "completed"
    ]);
  });

  it("Codex command hides runtime details from the materialized prompt but includes required CLI flags", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/run-1",
      finalPath: "/tmp/run-1/final.md",
      prompt: "Return Markdown."
    });

    expect(command.command).toBe("codex");
    expect(command.args).toContain("--search");
    expect(command.args).toContain("--ask-for-approval");
    expect(command.args).toContain("never");
    expect(command.args).toContain("exec");
    expect(command.args).toContain("--json");
    expect(command.args).toContain("--model");
    expect(command.args).toContain("gpt-5");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("danger-full-access");
    expect(command.args).toContain("--output-last-message");
  });
});
