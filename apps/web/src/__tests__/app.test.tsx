import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
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

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the builder workspace, not a landing page", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Agent Builder" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent name")).toHaveValue("Research Agent");
    expect(screen.getByText("Web Research")).toBeInTheDocument();
  });

  it("validates missing API key before running", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Run agent" }));
    expect(await screen.findByText("API key is required")).toBeInTheDocument();
  });

  it("renders Markdown final output after a run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "run-1",
          task: "Research Acme.",
          status: "succeeded",
          agentSpecSnapshot: defaultUiAgentSpec,
          traceEvents: [],
          finalMarkdown: "# Research Report\n\nAcme is interesting.",
          rawOutput: null,
          error: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        })
      })
    );

    render(<App />);
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "Run agent" }));

    expect(await screen.findByRole("heading", { name: "Research Report" })).toBeInTheDocument();
  });
});
