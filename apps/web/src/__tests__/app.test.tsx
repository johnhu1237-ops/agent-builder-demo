import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import App from "../App";

const fetchMock = vi.fn();

type EventSourceListener = (event: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  private listeners = new Map<string, EventSourceListener[]>();

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: EventSourceListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener)
    );
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

(global as Record<string, unknown>).EventSource = FakeEventSource;

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
    hasApiKey: true,
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
        {
          chatSessionId: "chat_1",
          userMessage: {
            id: "msg_1",
            chatSessionId: "chat_1",
            role: "user",
            contentMarkdown: body.message ?? "",
            taskId: "task_1",
            createdAt: new Date().toISOString()
          },
          task: {
            id: "task_1",
            chatSessionId: "chat_1",
            triggerMessageId: "msg_1",
            agentSpecSnapshot: defaultAgentSpec,
            status: "running",
            sessionId: null,
            workDir: null,
            resultMarkdown: null,
            rawOutputRedacted: null,
            error: null,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: null
          },
          eventsUrl: "/api/chat-sessions/chat_1/events"
        },
        202
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
  FakeEventSource.reset();
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

  it("sends a message with no API Key field in the chat panel", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    const sendBtn = screen.getByRole("button", { name: /^Send$/ });
    await user.click(sendBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const messageCall = calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/messages") && c[1]?.method === "POST"
      );
      expect(messageCall).toBeTruthy();
      const body = JSON.parse(messageCall![1]!.body as string);
      expect(body).toEqual({ message: "Hello" });
    });
  });

  it("shows the agent API Key field only in the Model tab", async () => {
    render(<App />);
    const user = userEvent.setup();
    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    await waitFor(() => expect(screen.getByLabelText("Agent name")).toBeInTheDocument());

    expect(screen.queryByLabelText("Agent API Key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Model" }));

    await waitFor(() => expect(screen.getByLabelText("Agent API Key")).toBeInTheDocument());
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

  it("disables the composer while a task is running and re-enables after the task terminates", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Long task");

    const sendBtn = screen.getByRole("button", { name: /^Send$/ });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByLabelText("Message")).toBeDisabled();
    });
    expect(
      screen.getByRole("button", { name: /Running|Sending|Send/i })
    ).toBeDisabled();

    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(
          sessionDetailFixture({
            messages: [
              {
                id: "msg_1",
                chatSessionId: "chat_1",
                role: "user",
                contentMarkdown: "Long task",
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
              resultMarkdown: "Done",
              rawOutputRedacted: "",
              error: null,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            },
            taskMessages: []
          })
        );
      }
      if (url.endsWith("/api/chat-sessions") && method === "GET") {
        return jsonResponse([sessionFixture()]);
      }
      return jsonResponse(null, 404);
    });

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    act(() => {
      source.emit("task_completed", { taskId: "task_1", status: "completed" });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Message")).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled();
  });

  it("surfaces a clear error when the API rejects a send with a 409 conflict", async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (url.endsWith("/api/agents") && method === "GET") {
        return jsonResponse([agentFixture()]);
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
        return jsonResponse(
          { error: "A task is already running in this chat session." },
          409
        );
      }
      return jsonResponse(null, 404);
    });

    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Hello");

    const sendBtn = screen.getByRole("button", { name: /^Send$/ });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText(/already running/i)).toBeInTheDocument();
    });
  });

  it("optimistically appends user message, streams task events, and refetches on terminal", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Research Acme");

    const sendBtn = screen.getByRole("button", { name: /^Send$/ });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(screen.getByText("Research Acme")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });

    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];

    act(() => {
      source.emit("task_message", {
        taskId: "task_1",
        seq: 0,
        taskMessage: {
          id: "tm_live_1",
          taskId: "task_1",
          seq: 0,
          type: "status",
          tool: null,
          content: "Searching...",
          inputJson: null,
          output: null,
          createdAt: new Date().toISOString()
        }
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Searching...")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity · Running · 1 event")).toBeVisible();
    expect(screen.getByText("Searching...")).toBeVisible();

    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(
          sessionDetailFixture({
            messages: [
              {
                id: "msg_1",
                chatSessionId: "chat_1",
                role: "user",
                contentMarkdown: "Research Acme",
                taskId: "task_1",
                createdAt: new Date().toISOString()
              },
              {
                id: "msg_2",
                chatSessionId: "chat_1",
                role: "assistant",
                contentMarkdown: "Acme report complete.",
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
              resultMarkdown: "Acme report complete.",
              rawOutputRedacted: "",
              error: null,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            },
            taskMessages: []
          })
        );
      }
      if (url.endsWith("/api/chat-sessions") && method === "GET") {
        return jsonResponse([sessionFixture()]);
      }
      return jsonResponse(null, 404);
    });

    act(() => {
      source.emit("task_completed", { taskId: "task_1", status: "completed" });
    });

    await waitFor(() => {
      expect(screen.getByText("Acme report complete.")).toBeInTheDocument();
    });
    expect(source.readyState).toBe(2);
  });

  it("collapses completed Activity to a summary and lets users expand it", async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (url.endsWith("/api/agents") && method === "GET") {
        return jsonResponse([agentFixture()]);
      }
      if (/\/api\/agents\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(agentFixture());
      }
      if (url.endsWith("/api/chat-sessions") && method === "GET") {
        return jsonResponse([sessionFixture({ title: "Completed chat" })]);
      }
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(
          sessionDetailFixture({
            title: "Completed chat",
            messages: [
              {
                id: "msg_1",
                chatSessionId: "chat_1",
                role: "user",
                contentMarkdown: "Research Acme",
                taskId: "task_1",
                createdAt: new Date().toISOString()
              },
              {
                id: "msg_2",
                chatSessionId: "chat_1",
                role: "assistant",
                contentMarkdown: "Acme report complete.",
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
              resultMarkdown: "Acme report complete.",
              rawOutputRedacted: "",
              error: null,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            },
            taskMessages: [
              {
                id: "tm_1",
                taskId: "task_1",
                seq: 0,
                type: "status",
                tool: null,
                content: "Started research",
                inputJson: null,
                output: null,
                createdAt: new Date().toISOString()
              },
              {
                id: "tm_2",
                taskId: "task_1",
                seq: 1,
                type: "tool_result",
                tool: "search",
                content: "Found source",
                inputJson: null,
                output: null,
                createdAt: new Date().toISOString()
              }
            ]
          })
        );
      }
      return jsonResponse(null, 404);
    });

    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    await user.click(await screen.findByRole("button", { name: /Completed chat/ }));

    const activitySummary = await screen.findByText("Activity · Completed · 2 events");
    expect(activitySummary).toBeVisible();
    expect(screen.getByText("Started research")).not.toBeVisible();

    await user.click(activitySummary);

    expect(screen.getByText("Started research")).toBeVisible();
    expect(screen.getByText("Found source")).toBeVisible();
  });

  it("deduplicates replayed activity events by task id and sequence", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Research Acme");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });

    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    const taskMessage = {
      taskId: "task_1",
      seq: 1,
      type: "status",
      tool: null,
      content: "Replayed update",
      inputJson: null,
      output: null,
      createdAt: new Date().toISOString()
    };

    act(() => {
      source.emit("task_message", {
        taskId: "task_1",
        seq: 1,
        taskMessage: { ...taskMessage, id: "tm_first" }
      });
      source.emit("task_message", {
        taskId: "task_1",
        seq: 1,
        taskMessage: { ...taskMessage, id: "tm_replayed" }
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText("Replayed update")).toHaveLength(1);
    });
  });
});
