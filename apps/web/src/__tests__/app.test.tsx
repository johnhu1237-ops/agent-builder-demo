import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import App from "../App";

const fetchMock = vi.fn();

beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/chat-sessions") && options?.method !== "POST") {
      return jsonResponse([]);
    }
    if (url.endsWith("/api/chat-sessions") && options?.method === "POST") {
      return jsonResponse({
        id: "chat-session-1",
        agentSpecSnapshot: defaultAgentSpec,
        title: "Research Agent",
        sessionId: null,
        workDir: null,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, 201);
    }
    if (url.endsWith("/api/chat-sessions/chat-session-1/messages")) {
      return jsonResponse({
        id: "chat-session-1",
        agentSpecSnapshot: defaultAgentSpec,
        title: "Research Agent",
        sessionId: "fake-session-chat-session-1",
        workDir: "/tmp/fake",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "m1", chatSessionId: "chat-session-1", role: "user", contentMarkdown: "Research Acme.", taskId: "t1", createdAt: new Date().toISOString() },
          { id: "m2", chatSessionId: "chat-session-1", role: "assistant", contentMarkdown: "# Research Report\n\nDone.", taskId: "t1", createdAt: new Date().toISOString() }
        ],
        latestTask: {
          id: "t1",
          chatSessionId: "chat-session-1",
          triggerMessageId: "m1",
          agentSpecSnapshot: defaultAgentSpec,
          status: "completed",
          sessionId: "fake-session-chat-session-1",
          workDir: "/tmp/fake",
          resultMarkdown: "# Research Report\n\nDone.",
          rawOutputRedacted: "raw",
          error: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        },
        taskMessages: [{ id: "tm1", taskId: "t1", seq: 1, type: "status", tool: null, content: "Completed", inputJson: null, output: null, createdAt: new Date().toISOString() }]
      }, 201);
    }
    return jsonResponse(defaultAgentSpec);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App chat workbench", () => {
  it("sends a chat message and renders assistant Markdown", async () => {
    render(<App />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("API key"), "sk-test");
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Research Acme.");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Research Acme.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Research Report" })).toBeInTheDocument();
      expect(screen.getByText("Completed")).toBeInTheDocument();
    });
  });

  it("shows validation errors before sending", async () => {
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("API key is required")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}
