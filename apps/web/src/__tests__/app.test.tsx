import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import App from "../App";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function agentFixture(overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  return {
    id: "agent_1",
    name: "Research Agent",
    description: "Researches companies",
    spec: defaultAgentSpec,
    createdAt: ts,
    updatedAt: ts,
    ...overrides
  };
}

function sessionFixture(overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  return {
    id: "chat_1",
    agentId: "agent_1",
    agentName: "Research Agent",
    agentSpecSnapshot: null,
    lastMessagePreview: null,
    title: "New Conversation",
    sessionId: null,
    workDir: null,
    status: "active",
    createdAt: ts,
    updatedAt: ts,
    ...overrides
  };
}

function sessionDetailFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...sessionFixture(),
    messages: [],
    latestTask: null,
    taskMessages: [],
    ...overrides
  };
}

beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";

    if (url.endsWith("/api/agents") && method === "POST") {
      return jsonResponse(agentFixture(), 201);
    }
    if (url.endsWith("/api/agents") && method === "GET") {
      return jsonResponse([agentFixture()]);
    }
    if (/\/api\/agents\/[^/]+$/.test(url) && method === "PUT") {
      return jsonResponse(agentFixture({ name: "Updated", description: "Updated desc" }));
    }
    if (/\/api\/agents\/[^/]+$/.test(url) && method === "GET") {
      return jsonResponse(agentFixture());
    }

    if (url.endsWith("/api/chat-sessions") && method === "POST") {
      return jsonResponse(sessionFixture(), 201);
    }
    if (url.endsWith("/api/chat-sessions") && method === "GET") {
      return jsonResponse([]);
    }
    if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
      return jsonResponse(sessionDetailFixture());
    }
    if (/\/api\/chat-sessions\/[^/]+\/messages$/.test(url) && method === "POST") {
      const body = options?.body ? JSON.parse(options.body as string) : {};
      return jsonResponse(
        sessionDetailFixture({
          messages: [
            {
              id: "msg_1",
              chatSessionId: "chat_1",
              role: "user",
              contentMarkdown: body.message ?? "",
              taskId: "task_1",
              createdAt: new Date().toISOString()
            },
            {
              id: "msg_2",
              chatSessionId: "chat_1",
              role: "assistant",
              contentMarkdown: "# Result\n\nDone.",
              taskId: "task_1",
              createdAt: new Date().toISOString()
            }
          ],
          latestTask: {
            id: "task_1",
            chatSessionId: "chat_1",
            triggerMessageId: "msg_1",
            agentSpecSnapshot: defaultAgentSpec,
            status: "completed",
            sessionId: null,
            workDir: null,
            resultMarkdown: "# Result\n\nDone.",
            rawOutputRedacted: "raw",
            error: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          },
          taskMessages: [
            {
              id: "tm_1",
              taskId: "task_1",
              seq: 1,
              type: "status",
              tool: null,
              content: "Completed",
              inputJson: null,
              output: null,
              createdAt: new Date().toISOString()
            }
          ]
        }),
        201
      );
    }

    if (url.endsWith("/api/agent/default")) {
      return jsonResponse(defaultAgentSpec);
    }
    return jsonResponse(null, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("multi-agent UI", () => {
  it("shows an accordion sidebar with Agents and Chats sections", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Agents/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Chats/ })).toBeInTheDocument();
    });
  });

  it("shows the empty workspace state when no agent or chat is selected", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/select an agent to get started/i)).toBeInTheDocument();
    });
  });

  it("lists agents in the sidebar and allows selecting one", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Agent name")).toBeInTheDocument();
    });
  });

  it("creates a new chat for the selected agent", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);

    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    await waitFor(() => {
      expect(screen.getByLabelText("Message")).toBeInTheDocument();
    });
  });

  it("sends a message without agentSpec in the request body", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    await user.type(screen.getByLabelText("API Key"), "sk-test");

    const sendBtn = screen.getByRole("button", { name: /^Send$/ });
    await user.click(sendBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const messageCall = calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/messages") && c[1]?.method === "POST"
      );
      expect(messageCall).toBeTruthy();
      const body = JSON.parse(messageCall![1]!.body as string);
      expect(body.agentSpec).toBeUndefined();
      expect(body.runtimeSecrets.apiKey).toBe("sk-test");
    });
  });

  it("switches between agent config and chat views", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    await waitFor(() => expect(screen.getByLabelText("Agent name")).toBeInTheDocument());

    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument());

    const agentButtonAgain = screen.getByRole("button", { name: /Research Agent/ });
    await user.click(agentButtonAgain);
    await waitFor(() => expect(screen.getByLabelText("Agent name")).toBeInTheDocument());
  });
});
