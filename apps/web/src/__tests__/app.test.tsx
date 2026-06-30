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
  onerror: (() => void) | null = null;
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

  fail(): void {
    this.onerror?.();
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

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
  (global as Record<string, unknown>).EventSource = FakeEventSource;
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
    if (/\/api\/agents\/[^/]+\/tool-configurations\/[^/]+$/.test(url) && method === "PATCH") {
      const body = options?.body ? JSON.parse(options.body as string) : {};
      return jsonResponse({
        id: "tool_config_1",
        agentId: "agent_1",
        connectedAccountId: "connected_account_1",
        appId: "mock-github",
        toolName: "github_create_issue",
        mode: body.mode ?? "disabled",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    if (/\/api\/agents\/[^/]+\/connected-apps\/github\/complete$/.test(url) && method === "POST") {
      return jsonResponse(
        {
          appId: "mock-github",
          provider: "github",
          label: "GitHub",
          description: "Connect GitHub issues.",
          status: "connected",
          connectedAccount: {
            id: "connected_account_1",
            workspaceId: "workspace_demo",
            appId: "mock-github",
            accountLabel: "Demo GitHub",
            externalAccountId: "demo-user",
            status: "connected",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          tools: [
            {
              id: "tool_config_1",
              agentId: "agent_1",
              connectedAccountId: "connected_account_1",
              appId: "mock-github",
              toolName: "github_create_issue",
              mode: "ask_each_time",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ]
        },
        201
      );
    }
    if (/\/api\/agents\/[^/]+\/connected-apps$/.test(url) && method === "GET") {
      return jsonResponse([
        {
          appId: "mock-github",
          provider: "github",
          label: "GitHub",
          description: "Connect GitHub issues.",
          status: "available",
          connectedAccount: null,
          tools: []
        }
      ]);
    }
    if (/\/api\/agents\/[^/]+\/tool-configurations$/.test(url) && method === "GET") {
      return jsonResponse([
        {
          id: "tool_config_1",
          agentId: "agent_1",
          connectedAccountId: "connected_account_1",
          appId: "mock-github",
          toolName: "github_create_issue",
          mode: "ask_each_time",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]);
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

  it("shows and updates persisted Tool Configuration modes", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    await user.click(await screen.findByRole("tab", { name: "Tools" }));

    const modeSelect = await screen.findByLabelText("GitHub github_create_issue mode");
    expect(modeSelect).toHaveValue("ask_each_time");

    await user.selectOptions(modeSelect, "disabled");

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const patchCall = calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("/tool-configurations/tool_config_1") &&
          c[1]?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall![1]!.body as string)).toEqual({ mode: "disabled" });
    });
    expect(modeSelect).toHaveValue("disabled");
  });

  it("connects GitHub, configures a tool, and approves a pending Tool Confirmation", async () => {
    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Research Agent/ }));
    await user.click(await screen.findByRole("tab", { name: "Tools" }));

    const connectButton = await screen.findByRole("button", { name: "Connect GitHub" });
    await user.click(connectButton);

    const modeSelect = await screen.findByLabelText("GitHub github_create_issue mode");
    await user.selectOptions(modeSelect, "auto");

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      expect(
        calls.some(
          ([url, options]) =>
            typeof url === "string" &&
            url.includes("/connected-apps/github/complete") &&
            options?.method === "POST"
        )
      ).toBe(true);
      expect(
        calls.some(
          ([url, options]) =>
            typeof url === "string" &&
            url.includes("/tool-configurations/tool_config_1") &&
            options?.method === "PATCH" &&
            JSON.parse(options.body as string).mode === "auto"
        )
      ).toBe(true);
    });

    await user.click(await screen.findByRole("button", { name: /\+ New chat/ }));
    await user.clear(await screen.findByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Create an issue");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });

    const confirmation = {
      id: "confirmation_1",
      agentTaskId: "task_1",
      chatSessionId: "chat_1",
      agentId: "agent_1",
      connectedAccountId: "connected_account_1",
      provider: "mock-github",
      mcpToolName: "github_create_issue",
      providerToolName: "github_create_issue",
      argsHash: "hash_1",
      previewJson: { title: "Ship gateway" },
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resolvedAt: null,
      createdAt: new Date().toISOString()
    };
    act(() => {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].emit("tool_confirmation_pending", {
        confirmation
      });
    });

    await user.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      expect(
        calls.some(
          ([url, options]) =>
            typeof url === "string" &&
            url.endsWith("/api/tool-confirmations/confirmation_1/approve") &&
            options?.method === "POST"
        )
      ).toBe(true);
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

  it("shows failed historical activity collapsed with a concise assistant failure message", async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (url.endsWith("/api/agents") && method === "GET") {
        return jsonResponse([agentFixture()]);
      }
      if (/\/api\/agents\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(agentFixture());
      }
      if (url.endsWith("/api/chat-sessions") && method === "GET") {
        return jsonResponse([sessionFixture()]);
      }
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        return jsonResponse(
          sessionDetailFixture({
            messages: [
              {
                id: "msg_1",
                chatSessionId: "chat_1",
                role: "user",
                contentMarkdown: "Please run this",
                taskId: "task_1",
                createdAt: new Date().toISOString()
              },
              {
                id: "msg_2",
                chatSessionId: "chat_1",
                role: "assistant",
                contentMarkdown: "Task failed: Codex exited with code 1",
                taskId: "task_1",
                createdAt: new Date().toISOString()
              }
            ],
            latestTask: {
              id: "task_1",
              chatSessionId: "chat_1",
              triggerMessageId: "msg_1",
              agentSpecSnapshot: defaultAgentSpec,
              status: "failed",
              sessionId: null,
              workDir: null,
              resultMarkdown: null,
              rawOutputRedacted: "",
              error: "Codex exited with code 1",
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            },
            taskMessages: [
              {
                id: "tm_1",
                taskId: "task_1",
                seq: 0,
                type: "error",
                tool: null,
                content: "Detailed stack trace",
                inputJson: null,
                output: null,
                createdAt: new Date().toISOString()
              },
              {
                id: "tm_2",
                taskId: "task_1",
                seq: 1,
                type: "log",
                tool: null,
                content: "Command output",
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
    const chatButton = await screen.findByRole("button", { name: /New Conversation/ });
    await user.click(chatButton);

    await waitFor(() => {
      expect(screen.getByText("Task failed: Codex exited with code 1")).toBeInTheDocument();
    });

    const activity = screen.getByText("Failed · 2 events").closest("details");
    expect(activity).toBeInTheDocument();
    expect(activity).not.toHaveAttribute("open");
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

  it("shows pending and resolved tool confirmations from SSE", async () => {
    render(<App />);
    const user = userEvent.setup();

    const agentButton = await screen.findByRole("button", { name: /Research Agent/ });
    await user.click(agentButton);
    const newChatBtn = await screen.findByRole("button", { name: /\+ New chat/ });
    await user.click(newChatBtn);

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Create an issue");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });

    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    const confirmation = {
      id: "confirmation_1",
      agentTaskId: "task_1",
      chatSessionId: "chat_1",
      agentId: "agent_1",
      connectedAccountId: "connected_account_1",
      provider: "mock-github",
      mcpToolName: "github_create_issue",
      providerToolName: "github_create_issue",
      argsHash: "hash_1",
      previewJson: { title: "Ship gateway" },
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resolvedAt: null,
      createdAt: new Date().toISOString()
    };

    act(() => {
      source.emit("tool_confirmation_pending", { confirmation });
    });

    await waitFor(() => {
      expect(screen.getByText("github_create_issue needs approval")).toBeInTheDocument();
    });
    expect(screen.getByText("Pending")).toBeInTheDocument();

    act(() => {
      source.emit("tool_confirmation_resolved", {
        confirmation: { ...confirmation, status: "approved", resolvedAt: new Date().toISOString() }
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Approved")).toBeInTheDocument();
    });
  });

  it("opens the SSE connection from the scheduled response eventsUrl", async () => {
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
            eventsUrl: "/api/custom-streams/chat_1"
          },
          202
        );
      }
      return jsonResponse(null, 404);
    });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Research Agent/ }));
    await user.click(await screen.findByRole("button", { name: /\+ New chat/ }));

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Research Acme");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    expect(FakeEventSource.instances.at(-1)?.url).toBe("http://localhost:4001/api/custom-streams/chat_1");
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

  it("hydrates Activity from the SSE task_snapshot replay", async () => {
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

    act(() => {
      source.emit("task_snapshot", {
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
        taskMessages: [
          {
            id: "tm_snapshot_1",
            taskId: "task_1",
            seq: 0,
            type: "status",
            tool: null,
            content: "Queued work",
            inputJson: null,
            output: null,
            createdAt: new Date().toISOString()
          }
        ]
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Queued work")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity · Running · 1 event")).toBeVisible();
  });

  it("falls back to polling session detail when EventSource is unavailable", async () => {
    (global as Record<string, unknown>).EventSource = undefined;
    let detailRequests = 0;
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
        return jsonResponse([sessionFixture({ id: "chat_list" })]);
      }
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        detailRequests += 1;
        if (detailRequests === 1) {
          return jsonResponse(sessionDetailFixture());
        }
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
                contentMarkdown: "Polling found the final answer.",
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
              resultMarkdown: "Polling found the final answer.",
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
                content: "Polled activity",
                inputJson: null,
                output: null,
                createdAt: new Date().toISOString()
              }
            ]
          })
        );
      }
      if (/\/api\/chat-sessions\/[^/]+\/messages$/.test(url) && method === "POST") {
        return jsonResponse(
          {
            chatSessionId: "chat_1",
            userMessage: {
              id: "msg_1",
              chatSessionId: "chat_1",
              role: "user",
              contentMarkdown: "Research Acme",
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
      return jsonResponse(null, 404);
    });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Research Agent/ }));
    await user.click(await screen.findByRole("button", { name: /\+ New chat/ }));

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Research Acme");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => {
      expect(screen.getByText("Polling found the final answer.")).toBeInTheDocument();
    });
    expect(screen.getByText("Activity · Completed · 1 event")).toBeVisible();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("falls back to polling after repeated SSE failures without duplicating Activity rows", async () => {
    let detailRequests = 0;
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
        return jsonResponse([sessionFixture({ id: "chat_list" })]);
      }
      if (/\/api\/chat-sessions\/[^/]+$/.test(url) && method === "GET") {
        detailRequests += 1;
        if (detailRequests === 1) {
          return jsonResponse(sessionDetailFixture());
        }
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
                contentMarkdown: "Fallback completed.",
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
              resultMarkdown: "Fallback completed.",
              rawOutputRedacted: "",
              error: null,
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            },
            taskMessages: [
              {
                id: "tm_live_1",
                taskId: "task_1",
                seq: 0,
                type: "status",
                tool: null,
                content: "Live before fallback",
                inputJson: null,
                output: null,
                createdAt: new Date().toISOString()
              }
            ]
          })
        );
      }
      if (/\/api\/chat-sessions\/[^/]+\/messages$/.test(url) && method === "POST") {
        return jsonResponse(
          {
            chatSessionId: "chat_1",
            userMessage: {
              id: "msg_1",
              chatSessionId: "chat_1",
              role: "user",
              contentMarkdown: "Research Acme",
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
      return jsonResponse(null, 404);
    });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Research Agent/ }));
    await user.click(await screen.findByRole("button", { name: /\+ New chat/ }));

    const textarea = await screen.findByLabelText("Message");
    await user.clear(textarea);
    await user.type(textarea, "Research Acme");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));

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
          content: "Live before fallback",
          inputJson: null,
          output: null,
          createdAt: new Date().toISOString()
        }
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Live before fallback")).toBeInTheDocument();
    });

    act(() => {
      source.fail();
      source.fail();
      source.fail();
    });

    await waitFor(() => {
      expect(screen.getByText("Fallback completed.")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Live before fallback")).toHaveLength(1);
    expect(screen.getByText("Activity · Completed · 1 event")).toBeVisible();
    expect(source.readyState).toBe(2);
  });
});
