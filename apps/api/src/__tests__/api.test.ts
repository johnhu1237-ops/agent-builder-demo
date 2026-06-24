import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { createApiApp } from "../index";

describe("API orchestrator", () => {
  it("returns the default agent without an API key", async () => {
    const app = createApiApp();
    const response = await request(app).get("/api/agent/default").expect(200);

    expect(response.body.identity.name).toBe("Research Agent");
    expect(JSON.stringify(response.body)).not.toContain("apiKey");
  });

  it("rejects run creation without an API key", async () => {
    const app = createApiApp();
    const response = await request(app)
      .post("/api/runs")
      .send({ agentSpec: defaultAgentSpec, runtimeSecrets: { apiKey: "" }, task: "Research Acme." })
      .expect(400);

    expect(response.body.error).toBe("API key is required");
  });

  it("creates a run and stores final Markdown from the runner", async () => {
    const app = createApiApp({
      runAgent: vi.fn().mockResolvedValue({
        finalMarkdown: "# Research Report\n\nDone.",
        rawOutput: "raw fake output",
        events: [{ type: "completed", message: "Run completed" }]
      })
    });

    const createResponse = await request(app)
      .post("/api/runs")
      .send({ agentSpec: defaultAgentSpec, runtimeSecrets: { apiKey: "sk-test" }, task: "Research Acme." })
      .expect(201);

    expect(createResponse.body.status).toBe("succeeded");
    expect(createResponse.body.finalMarkdown).toContain("# Research Report");
    expect(JSON.stringify(createResponse.body.agentSpecSnapshot)).not.toContain("sk-test");

    const getResponse = await request(app).get(`/api/runs/${createResponse.body.id}`).expect(200);
    expect(getResponse.body.finalMarkdown).toContain("Done.");
  });
});
