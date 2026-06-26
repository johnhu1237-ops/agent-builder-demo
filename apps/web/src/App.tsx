import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  abilityRegistry,
  appRegistry,
  skillRegistry,
  defaultAgentSpec,
  isTerminalTaskStatus,
  type Agent,
  type AgentSpec,
  type ChatSession,
  type ChatSessionDetail,
  type TaskMessageEvent,
  type TaskTerminalEvent
} from "@agent-builder/shared";
import { createExportPayload } from "./defaults";
import { formatRelativeTime } from "./relative-time";
import {
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  listChatSessions,
  createChatSession,
  getChatSession,
  sendChatMessage,
  createTaskEventSource
} from "./api";

type WorkspaceView = "empty" | "agent-config" | "chat";
type SaveState = "idle" | "saving" | "saved" | "failed";
type SendState = "idle" | "sending" | "failed";
type ConfigTab = "profile" | "model" | "tools";
type ToolsTab = "apps" | "skills" | "abilities";

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [activeSession, setActiveSession] = useState<ChatSessionDetail | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("empty");

  const [agentsOpen, setAgentsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);

  const [editingSpec, setEditingSpec] = useState<AgentSpec>(defaultAgentSpec);
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTab>("profile");
  const [activeToolsTab, setActiveToolsTab] = useState<ToolsTab>("apps");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const [editAgentApiKey, setEditAgentApiKey] = useState("");
  const [message, setMessage] = useState("Research RunwayML and produce a concise company profile.");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);

  const loadingIdRef = useRef<string | null>(null);
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [agentList, sessionList] = await Promise.all([listAgents(), listChatSessions()]);
        if (cancelled) return;
        setAgents(agentList);
        setSessions(sessionList);
      } catch {
        // silent
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function selectAgent(agentId: string) {
    try {
      const agent = await getAgent(agentId);
      setActiveAgent(agent);
      setEditingSpec(agent.spec);
      setActiveSession(null);
      setWorkspaceView("agent-config");
      setError(null);
    } catch {
      setError("Failed to load agent");
    }
  }

  async function handleCreateAgent() {
    try {
      const agent = await createAgent({ spec: defaultAgentSpec, apiKey: "sk-replace-me" });
      setAgents((prev) => [...prev, agent]);
      setActiveAgent(agent);
      setEditingSpec(agent.spec);
      setEditAgentApiKey("");
      setActiveSession(null);
      setWorkspaceView("agent-config");
      setError(null);
    } catch {
      setError("Failed to create agent");
    }
  }

  async function handleSaveAgent() {
    if (!activeAgent) return;
    setSaveState("saving");
    try {
      const updated = await updateAgent(activeAgent.id, {
        spec: editingSpec,
        ...(editAgentApiKey.trim() ? { apiKey: editAgentApiKey.trim() } : {})
      });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setActiveAgent(updated);
      setEditingSpec(updated.spec);
      setEditAgentApiKey("");
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("failed");
    }
  }

  async function selectSession(sessionId: string) {
    setLoadingChatId(sessionId);
    loadingIdRef.current = sessionId;
    try {
      const detail = await getChatSession(sessionId);
      if (loadingIdRef.current !== sessionId) return;
      setActiveSession(detail);
      if (!activeAgent || activeAgent.id !== detail.agentId) {
        setActiveAgent({
          id: detail.agentId,
          name: detail.agentName,
          description: "",
          spec: defaultAgentSpec,
          hasApiKey: false,
          createdAt: "",
          updatedAt: ""
        });
      }
      setWorkspaceView("chat");
      setError(null);
    } catch {
      if (loadingIdRef.current === sessionId) {
        setError("Failed to load session");
      }
    } finally {
      if (loadingIdRef.current === sessionId) {
        setLoadingChatId(null);
        loadingIdRef.current = null;
      }
    }
  }

  async function handleNewChat() {
    if (!activeAgent) return;
    try {
      const session = await createChatSession({ agentId: activeAgent.id });
      setSessions((prev) => [session, ...prev]);
      const detail = await getChatSession(session.id);
      setActiveSession(detail);
      setWorkspaceView("chat");
      setError(null);
    } catch {
      setError("Failed to create chat");
    }
  }

  async function handleSendMessage() {
    const trimmed = message.trim();
    if (!trimmed) return;
    if (!activeSession) return;
    if (activeSession.latestTask && !isTerminalTaskStatus(activeSession.latestTask.status)) return;

    setSendState("sending");
    setError(null);

    try {
      const scheduled = await sendChatMessage({
        chatSessionId: activeSession.id,
        message: trimmed
      });

      const sessionId = scheduled.chatSessionId;
      setActiveSession((prev) =>
        prev && prev.id === sessionId
          ? {
              ...prev,
              messages: [...prev.messages, scheduled.userMessage],
              latestTask: scheduled.task,
              taskMessages: []
            }
          : prev
      );
      setMessage("");
      setSendState("idle");

      eventSourceRef.current?.close();
      const source = createTaskEventSource(sessionId);
      eventSourceRef.current = source;

      const handleTaskMessage = (rawEvent: MessageEvent) => {
        try {
          const data = JSON.parse(rawEvent.data) as TaskMessageEvent;
          setActiveSession((prev) => {
            if (!prev || prev.id !== sessionId) return prev;
            if (prev.taskMessages.some((m) => m.id === data.taskMessage.id)) return prev;
            return { ...prev, taskMessages: [...prev.taskMessages, data.taskMessage] };
          });
        } catch {
          // ignore malformed events
        }
      };

      const handleTerminal = (rawEvent: MessageEvent) => {
        try {
          JSON.parse(rawEvent.data) as TaskTerminalEvent;
        } catch {
          // continue with refetch anyway
        }
        source.close();
        if (eventSourceRef.current === source) {
          eventSourceRef.current = null;
        }
        getChatSession(sessionId)
          .then((detail) => {
            setActiveSession((prev) => (prev && prev.id === sessionId ? detail : prev));
          })
          .catch(() => undefined);
        listChatSessions()
          .then((list) => setSessions(list))
          .catch(() => undefined);
      };

      source.addEventListener("task_message", handleTaskMessage as EventListener);
      source.addEventListener("task_completed", handleTerminal as EventListener);
      source.addEventListener("task_failed", handleTerminal as EventListener);
      source.addEventListener("task_timed_out", handleTerminal as EventListener);
      source.addEventListener("task_cancelled", handleTerminal as EventListener);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      setSendState("failed");
    }
  }

  const chatAgentName = activeSession?.agentName ?? activeAgent?.name ?? "Agent";

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Agent navigation">
        <div className="brand-mark">AB</div>
        <h2 className="sidebar-heading">Agent Builder</h2>

        <div className="sidebar-section">
          <button
            className="accordion-header"
            type="button"
            onClick={() => setAgentsOpen((open) => !open)}
            aria-expanded={agentsOpen}
          >
            <span className="accordion-chevron">{agentsOpen ? "v" : ">"}</span>
            <span>Agents</span>
          </button>
          {agentsOpen ? (
            <div className="section-body">
              <ul className="item-list">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className={`item-btn${activeAgent?.id === agent.id ? " item-active" : ""}`}
                      aria-current={activeAgent?.id === agent.id ? "true" : undefined}
                      onClick={() => selectAgent(agent.id)}
                    >
                      <span className="item-name">{agent.name}</span>
                      {agent.description ? <span className="item-desc">{agent.description}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <button className="add-btn" type="button" onClick={handleCreateAgent}>
                + Add agent
              </button>
            </div>
          ) : null}
        </div>

        <div className="sidebar-section">
          <button
            className="accordion-header"
            type="button"
            onClick={() => setChatsOpen((open) => !open)}
            aria-expanded={chatsOpen}
          >
            <span className="accordion-chevron">{chatsOpen ? "v" : ">"}</span>
            <span>Chats</span>
          </button>
          {chatsOpen ? (
            <div className="section-body">
              {activeAgent ? (
                <>
                  <ul className="item-list">
                    {sessions
                      .filter((session) => session.agentId === activeAgent.id)
                      .map((session) => (
                        <li key={session.id}>
                          <button
                            type="button"
                            className={`item-btn${activeSession?.id === session.id ? " item-active" : ""}`}
                            aria-current={activeSession?.id === session.id ? "true" : undefined}
                            onClick={() => selectSession(session.id)}
                            disabled={loadingChatId === session.id}
                          >
                            <span className="item-name">
                              {loadingChatId === session.id ? "Loading…" : session.title || session.agentName}
                            </span>
                            <span className="item-meta">
                              {formatRelativeTime(session.updatedAt)}
                              {session.lastMessagePreview ? ` · ${session.lastMessagePreview.slice(0, 40)}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                  <button className="add-btn" type="button" onClick={handleNewChat}>
                    + New chat
                  </button>
                </>
              ) : (
                <p className="section-hint">Select an agent to see chats</p>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="workspace">
        {workspaceView === "empty" ? (
          <div className="empty-state">
            <h2>Agent Builder</h2>
            <p>Select an agent to get started, or create a new one from the sidebar.</p>
          </div>
        ) : null}

        {workspaceView === "agent-config" && activeAgent ? (
          <div className="agent-config-view">
            <header className="topbar">
              <h1>{activeAgent.name}</h1>
              <span className={activeAgent.hasApiKey ? "status-ok" : "status-warning"}>
                {activeAgent.hasApiKey ? "API Key: Configured" : "API Key: Not Set"}
              </span>
              <button
                className="button ghost compact export-btn"
                type="button"
                onClick={() => {
                  const payload = createExportPayload({ agentSpec: editingSpec });
                  navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).catch(() => undefined);
                }}
              >
                Export Spec
              </button>
            </header>

            <div className="config-body">
              <div className="config-toolbar">
                <nav className="config-tabs" role="tablist" aria-label="Configuration sections">
                  {(["profile", "model", "tools"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={activeConfigTab === tab}
                      className={`tab-btn${activeConfigTab === tab ? " tab-active" : ""}`}
                      onClick={() => setActiveConfigTab(tab)}
                    >
                      {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </nav>
                <button
                  className="save-btn"
                  type="button"
                  onClick={handleSaveAgent}
                  disabled={saveState === "saving"}
                >
                  {saveState === "saving"
                    ? "Saving…"
                    : saveState === "saved"
                      ? "Saved"
                      : saveState === "failed"
                        ? "Failed"
                        : "Save"}
                </button>
              </div>

              {activeConfigTab === "profile" ? (
                <div className="config-panel" role="tabpanel">
                  <label>
                    Agent name
                    <input
                      aria-label="Agent name"
                      value={editingSpec.identity.name}
                      onChange={(event) =>
                        setEditingSpec({
                          ...editingSpec,
                          identity: { ...editingSpec.identity, name: event.target.value }
                        })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <input
                      aria-label="Agent description"
                      value={editingSpec.identity.description}
                      onChange={(event) =>
                        setEditingSpec({
                          ...editingSpec,
                          identity: { ...editingSpec.identity, description: event.target.value }
                        })
                      }
                    />
                  </label>
                  <label>
                    System prompt
                    <textarea
                      aria-label="System prompt"
                      rows={6}
                      value={editingSpec.systemPrompt}
                      onChange={(event) =>
                        setEditingSpec({ ...editingSpec, systemPrompt: event.target.value })
                      }
                    />
                  </label>
                </div>
              ) : null}

              {activeConfigTab === "model" ? (
                <div className="config-panel" role="tabpanel">
                  <label>
                    Provider
                    <select
                      value={editingSpec.model.provider}
                      onChange={(event) =>
                        setEditingSpec({
                          ...editingSpec,
                          model: {
                            ...editingSpec.model,
                            provider: event.target.value as AgentSpec["model"]["provider"]
                          }
                        })
                      }
                    >
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="openai">OpenAI</option>
                    </select>
                  </label>
                  <label>
                    Model name
                    <input
                      value={editingSpec.model.name}
                      onChange={(event) =>
                        setEditingSpec({
                          ...editingSpec,
                          model: { ...editingSpec.model, name: event.target.value }
                        })
                      }
                    />
                  </label>
                  <label>
                    API endpoint
                    <input
                      value={editingSpec.model.apiEndpoint}
                      onChange={(event) =>
                        setEditingSpec({
                          ...editingSpec,
                          model: { ...editingSpec.model, apiEndpoint: event.target.value }
                        })
                      }
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      type="password"
                      aria-label="Agent API Key"
                      value={editAgentApiKey}
                      onChange={(event) => setEditAgentApiKey(event.target.value)}
                      placeholder={activeAgent.hasApiKey ? "Configured — leave blank to keep" : "sk-…"}
                    />
                  </label>
                </div>
              ) : null}

              {activeConfigTab === "tools" ? (
                <div className="config-panel" role="tabpanel">
                  <nav className="tools-subtabs" role="tablist" aria-label="Tool sections">
                    {(["apps", "skills", "abilities"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={activeToolsTab === tab}
                        className={`tab-btn${activeToolsTab === tab ? " tab-active" : ""}`}
                        onClick={() => setActiveToolsTab(tab)}
                      >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                      </button>
                    ))}
                  </nav>

                  {activeToolsTab === "apps" ? (
                    <div className="toggle-list">
                      {editingSpec.apps.map((app) => {
                        const item = appRegistry.find((registryEntry) => registryEntry.id === app.id);
                        return (
                          <label key={app.id} className="toggle-row">
                            <span>{item?.label ?? app.id}</span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={app.enabled}
                              onClick={() =>
                                setEditingSpec({
                                  ...editingSpec,
                                  apps: editingSpec.apps.map((entry) =>
                                    entry.id === app.id ? { ...entry, enabled: !entry.enabled } : entry
                                  )
                                })
                              }
                            >
                              {app.enabled ? "ON" : "OFF"}
                            </button>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  {activeToolsTab === "skills" ? (
                    <div className="toggle-list">
                      {editingSpec.skills.map((skill) => {
                        const item = skillRegistry.find((registryEntry) => registryEntry.id === skill.id);
                        return (
                          <label key={skill.id} className="toggle-row">
                            <span>{item?.label ?? skill.id}</span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={skill.enabled}
                              onClick={() =>
                                setEditingSpec({
                                  ...editingSpec,
                                  skills: editingSpec.skills.map((entry) =>
                                    entry.id === skill.id ? { ...entry, enabled: !entry.enabled } : entry
                                  )
                                })
                              }
                            >
                              {skill.enabled ? "ON" : "OFF"}
                            </button>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  {activeToolsTab === "abilities" ? (
                    <div className="ability-pills">
                      {editingSpec.abilities.map((ability) => {
                        const item = abilityRegistry.find((registryEntry) => registryEntry.id === ability.id);
                        return (
                          <span key={ability.id} className="pill pill-enabled">
                            {item?.label ?? ability.id}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {workspaceView === "chat" && activeSession ? (
          <div className="chat-view">
            <header className="topbar">
              <h1>{activeSession.title || activeSession.agentName}</h1>
              <span className="status-badge">{activeSession.status}</span>
            </header>

            <div className="message-list">
              {activeSession.messages.length === 0 ? (
                <div className="empty-hint">
                  <p>Start a conversation with {chatAgentName}.</p>
                </div>
              ) : null}
              {activeSession.messages.map((chatMessage) => (
                <article key={chatMessage.id} className={`message message-${chatMessage.role}`}>
                  <span className="message-role">{chatMessage.role === "user" ? "You" : chatAgentName}</span>
                  <ReactMarkdown>{chatMessage.contentMarkdown}</ReactMarkdown>
                </article>
              ))}
            </div>

            {(() => {
              const isTaskRunning = Boolean(
                activeSession.latestTask && !isTerminalTaskStatus(activeSession.latestTask.status)
              );
              const composerDisabled = sendState === "sending" || isTaskRunning;
              const buttonLabel = isTaskRunning
                ? "Running…"
                : sendState === "sending"
                  ? "Sending…"
                  : "Send";
              return (
                <div className="message-input-area">
                  <textarea
                    rows={5}
                    aria-label="Message"
                    placeholder={isTaskRunning ? "Waiting for the current task to finish…" : "Type your message…"}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    disabled={composerDisabled}
                    onKeyDown={(event) => {
                      if (composerDisabled) return;
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        handleSendMessage();
                      }
                    }}
                  />
                  <button
                    className="send-btn"
                    type="button"
                    onClick={handleSendMessage}
                    disabled={composerDisabled}
                  >
                    {buttonLabel}
                  </button>
                </div>
              );
            })()}

            {error ? <div className="error-banner">{error}</div> : null}

            {activeSession.latestTask && activeSession.taskMessages.length > 0 ? (
              <details className="trace" open={activeSession.latestTask.status === "running"}>
                <summary>
                  Task Timeline
                  {activeSession.latestTask.status === "running" ? " (running)" : ""}
                </summary>
                {activeSession.taskMessages.map((taskMessage) => (
                  <div key={taskMessage.id} className="trace-item">
                    <span className={`trace-type trace-${taskMessage.type}`}>{taskMessage.type}</span>
                    <span className="trace-content">{taskMessage.content.slice(0, 200)}</span>
                  </div>
                ))}
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
