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
  type AgentTask,
  type TaskMessage,
  type TaskMessageEvent,
  type TaskSnapshotEvent,
  type TaskTerminalEvent,
  type ToolConfirmation,
  type ToolConfirmationEvent
} from "@agent-builder/shared";
import { createExportPayload } from "./defaults";
import { formatRelativeTime } from "./relative-time";
import { redirectToExternalUrl } from "./browser-navigation";
import {
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  startGithubConnectedAppAuthorization,
  completeGithubConnectedApp,
  listConnectedApps,
  listToolConfigurations,
  updateToolConfigurationMode,
  listChatSessions,
  createChatSession,
  getChatSession,
  sendChatMessage,
  createTaskEventSource,
  approveToolConfirmation,
  denyToolConfirmation,
  type ConnectedAppState,
  type ToolConfiguration,
  type ToolConfigurationMode
} from "./api";

type WorkspaceView = "empty" | "agent-config" | "chat";
type SaveState = "idle" | "saving" | "saved" | "failed";
type SendState = "idle" | "sending" | "failed";
type ConfigTab = "profile" | "model" | "tools";
type ToolsTab = "apps" | "skills" | "abilities";

function taskMessageStreamKey(input: { taskId: string; seq: number }): string {
  return `${input.taskId}:${input.seq}`;
}

function mergeTaskMessages(existing: TaskMessage[], incoming: TaskMessage[]): TaskMessage[] {
  const seen = new Set(existing.map(taskMessageStreamKey));
  const merged = [...existing];
  for (const message of incoming) {
    const key = taskMessageStreamKey(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  return merged.sort((a, b) => a.seq - b.seq);
}

function mergeToolConfirmations(existing: ToolConfirmation[] = [], incoming: ToolConfirmation[] = []): ToolConfirmation[] {
  const byId = new Map(existing.map((confirmation) => [confirmation.id, confirmation]));
  for (const confirmation of incoming) {
    byId.set(confirmation.id, confirmation);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function activityStatusLabel(status: AgentTask["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "timed_out":
      return "Timed out";
    case "cancelled":
      return "Cancelled";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
  }
}

function activitySummary(task: AgentTask, eventCount: number): string {
  const eventLabel = eventCount === 1 ? "event" : "events";
  if (task.status === "failed" || task.status === "timed_out") {
    return `${activityStatusLabel(task.status)} · ${eventCount} ${eventLabel}`;
  }
  return `Activity · ${activityStatusLabel(task.status)} · ${eventCount} ${eventLabel}`;
}

function toolConfigurationModeLabel(mode: ToolConfigurationMode): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "ask_each_time":
      return "Ask each time";
    case "disabled":
      return "Disabled";
  }
}

function toolConfirmationStatusLabel(status: ToolConfirmation["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
  }
}

function ActivityBlock({
  task,
  taskMessages,
  toolConfirmations,
  onApproveToolConfirmation,
  onDenyToolConfirmation
}: {
  task: AgentTask;
  taskMessages: TaskMessage[];
  toolConfirmations: ToolConfirmation[];
  onApproveToolConfirmation: (id: string) => void;
  onDenyToolConfirmation: (id: string) => void;
}) {
  const isRunning = !isTerminalTaskStatus(task.status);
  const [isOpen, setIsOpen] = useState(isRunning);

  useEffect(() => {
    setIsOpen(isRunning);
  }, [task.id, isRunning]);

  const eventCount = taskMessages.length + toolConfirmations.length;

  return (
    <details className="trace activity" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary>{activitySummary(task, eventCount)}</summary>
      <div className="activity-events">
        {eventCount > 0 ? (
          <>
            {toolConfirmations.map((confirmation) => (
              <div key={confirmation.id} className="trace-item trace-confirmation">
                <span className={`trace-type trace-${confirmation.status}`}>
                  {toolConfirmationStatusLabel(confirmation.status)}
                </span>
                <span className="trace-content">{confirmation.mcpToolName} needs approval</span>
                {confirmation.status === "pending" ? (
                  <span className="confirmation-actions">
                    <button type="button" onClick={() => onApproveToolConfirmation(confirmation.id)}>
                      Approve
                    </button>
                    <button type="button" onClick={() => onDenyToolConfirmation(confirmation.id)}>
                      Deny
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
            {taskMessages.map((taskMessage) => (
              <div key={taskMessageStreamKey(taskMessage)} className="trace-item">
                <span className={`trace-type trace-${taskMessage.type}`}>{taskMessage.type}</span>
                <span className="trace-content">{taskMessage.content.slice(0, 200)}</span>
              </div>
            ))}
          </>
        ) : (
          <div className="trace-empty">No activity events yet.</div>
        )}
      </div>
    </details>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [activeSession, setActiveSession] = useState<ChatSessionDetail | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("empty");

  const [agentsOpen, setAgentsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);

  const [editingSpec, setEditingSpec] = useState<AgentSpec>(defaultAgentSpec);
  const [connectedApps, setConnectedApps] = useState<ConnectedAppState[]>([]);
  const [toolConfigurations, setToolConfigurations] = useState<ToolConfiguration[]>([]);
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
  const pollingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (pollingTimerRef.current != null) {
        window.clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname !== "/oauth/arcade/github/callback") {
      return;
    }

    const agentId = new URLSearchParams(window.location.search).get("agentId");
    if (!agentId) {
      setError("Failed to connect GitHub");
      window.history.replaceState({}, "", "/");
      return;
    }
    const callbackAgentId = agentId;

    let cancelled = false;
    async function completeCallback() {
      try {
        await completeGithubConnectedApp(callbackAgentId);
        const [agent, nextConnectedApps, nextToolConfigurations] = await Promise.all([
          getAgent(callbackAgentId),
          listConnectedApps(callbackAgentId).catch(() => []),
          listToolConfigurations(callbackAgentId).catch(() => [])
        ]);
        if (cancelled) return;
        setActiveAgent(agent);
        setEditingSpec(agent.spec);
        setConnectedApps(nextConnectedApps);
        setToolConfigurations(nextToolConfigurations);
        setActiveSession(null);
        setWorkspaceView("agent-config");
        setActiveConfigTab("tools");
        setActiveToolsTab("apps");
        setError(null);
      } catch {
        if (!cancelled) {
          try {
            const [agent, nextConnectedApps, nextToolConfigurations] = await Promise.all([
              getAgent(callbackAgentId),
              listConnectedApps(callbackAgentId).catch(() => []),
              listToolConfigurations(callbackAgentId).catch(() => [])
            ]);
            if (!cancelled) {
              setActiveAgent(agent);
              setEditingSpec(agent.spec);
              setConnectedApps(nextConnectedApps);
              setToolConfigurations(nextToolConfigurations);
              setActiveSession(null);
              setWorkspaceView("agent-config");
              setActiveConfigTab("tools");
              setActiveToolsTab("apps");
            }
          } catch {
            // The connection error below is the user-facing failure for this path.
          }
          if (!cancelled) {
            setError("Failed to connect GitHub");
          }
        }
      } finally {
        if (!cancelled) {
          window.history.replaceState({}, "", "/");
        }
      }
    }

    completeCallback();
    return () => {
      cancelled = true;
    };
  }, []);

  function stopPolling() {
    if (pollingTimerRef.current != null) {
      window.clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }

  function refreshSessionsList() {
    listChatSessions()
      .then((list) => setSessions(list))
      .catch(() => undefined);
  }

  function refreshActiveSession(sessionId: string) {
    return getChatSession(sessionId).then((detail) => {
      setActiveSession((prev) => (prev && prev.id === sessionId ? detail : prev));
      return detail;
    });
  }

  function startPollingSession(sessionId: string) {
    stopPolling();
    const poll = () => {
      refreshActiveSession(sessionId)
        .then((detail) => {
          if (detail.latestTask && isTerminalTaskStatus(detail.latestTask.status)) {
            stopPolling();
            refreshSessionsList();
            return;
          }
          pollingTimerRef.current = window.setTimeout(poll, 1500);
        })
        .catch(() => {
          pollingTimerRef.current = window.setTimeout(poll, 1500);
        });
    };
    poll();
  }

  function updateToolConfirmationState(confirmation: ToolConfirmation) {
    setActiveSession((prev) => {
      if (!prev || prev.id !== confirmation.chatSessionId) return prev;
      return {
        ...prev,
        pendingToolConfirmations: mergeToolConfirmations(prev.pendingToolConfirmations, [confirmation])
      };
    });
  }

  function handleApproveToolConfirmation(id: string) {
    approveToolConfirmation(id)
      .then(updateToolConfirmationState)
      .catch(() => setError("Failed to approve tool call"));
  }

  function handleDenyToolConfirmation(id: string) {
    denyToolConfirmation(id)
      .then(updateToolConfirmationState)
      .catch(() => setError("Failed to deny tool call"));
  }

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
      const [agent, nextConnectedApps, nextToolConfigurations] = await Promise.all([
        getAgent(agentId),
        listConnectedApps(agentId).catch(() => []),
        listToolConfigurations(agentId).catch(() => [])
      ]);
      setActiveAgent(agent);
      setEditingSpec(agent.spec);
      setConnectedApps(nextConnectedApps);
      setToolConfigurations(nextToolConfigurations);
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
      const [nextConnectedApps, nextToolConfigurations] = await Promise.all([
        listConnectedApps(agent.id).catch(() => []),
        listToolConfigurations(agent.id).catch(() => [])
      ]);
      setAgents((prev) => [...prev, agent]);
      setActiveAgent(agent);
      setEditingSpec(agent.spec);
      setConnectedApps(nextConnectedApps);
      setToolConfigurations(nextToolConfigurations);
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

  async function handleToolConfigurationModeChange(
    toolConfigurationId: string,
    mode: ToolConfigurationMode
  ) {
    if (!activeAgent) return;
    const previous = toolConfigurations;
    setToolConfigurations((current) =>
      current.map((toolConfiguration) =>
        toolConfiguration.id === toolConfigurationId ? { ...toolConfiguration, mode } : toolConfiguration
      )
    );
    try {
      const updated = await updateToolConfigurationMode(activeAgent.id, toolConfigurationId, mode);
      setToolConfigurations((current) =>
        current.map((toolConfiguration) =>
          toolConfiguration.id === updated.id ? updated : toolConfiguration
        )
      );
      setConnectedApps((current) =>
        current.map((connectedApp) => ({
          ...connectedApp,
          tools: connectedApp.tools.map((toolConfiguration) =>
            toolConfiguration.id === updated.id ? updated : toolConfiguration
          )
        }))
      );
      setError(null);
    } catch {
      setToolConfigurations(previous);
      setError("Failed to update Tool Configuration");
    }
  }

  async function handleConnectGithub() {
    if (!activeAgent) return;
    try {
      const returnUrl = `${window.location.origin}/oauth/arcade/github/callback?agentId=${encodeURIComponent(activeAgent.id)}`;
      const authorization = await startGithubConnectedAppAuthorization(activeAgent.id, returnUrl);
      setError(null);
      redirectToExternalUrl(authorization.authorizationUrl);
    } catch {
      setError("Failed to connect GitHub");
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
              taskMessages: [],
              pendingToolConfirmations: []
            }
          : prev
      );
      setMessage("");
      setSendState("idle");

      eventSourceRef.current?.close();
      stopPolling();
      if (typeof EventSource !== "function") {
        startPollingSession(sessionId);
        return;
      }

      const source = createTaskEventSource(scheduled.eventsUrl);
      eventSourceRef.current = source;
      let receivedUsableSseEvent = false;
      let sseFailureCount = 0;

      const markSseUsable = () => {
        receivedUsableSseEvent = true;
        sseFailureCount = 0;
      };

      const fallBackToPolling = () => {
        source.close();
        if (eventSourceRef.current === source) {
          eventSourceRef.current = null;
        }
        startPollingSession(sessionId);
      };

      const handleSnapshot = (rawEvent: MessageEvent) => {
        try {
          const data = JSON.parse(rawEvent.data) as TaskSnapshotEvent;
          markSseUsable();
          setActiveSession((prev) => {
            if (!prev || prev.id !== sessionId) return prev;
            return {
              ...prev,
              latestTask: data.task ?? prev.latestTask,
              taskMessages: mergeTaskMessages(prev.taskMessages, data.taskMessages),
              pendingToolConfirmations: mergeToolConfirmations(
                prev.pendingToolConfirmations,
                data.pendingToolConfirmations ?? []
              )
            };
          });
        } catch {
          // ignore malformed events
        }
      };

      const handleTaskMessage = (rawEvent: MessageEvent) => {
        try {
          const data = JSON.parse(rawEvent.data) as TaskMessageEvent;
          markSseUsable();
          setActiveSession((prev) => {
            if (!prev || prev.id !== sessionId) return prev;
            return { ...prev, taskMessages: mergeTaskMessages(prev.taskMessages, [data.taskMessage]) };
          });
        } catch {
          // ignore malformed events
        }
      };

      const handleToolConfirmation = (rawEvent: MessageEvent) => {
        try {
          const data = JSON.parse(rawEvent.data) as ToolConfirmationEvent;
          markSseUsable();
          updateToolConfirmationState(data.confirmation);
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
        markSseUsable();
        source.close();
        if (eventSourceRef.current === source) {
          eventSourceRef.current = null;
        }
        refreshActiveSession(sessionId).catch(() => undefined);
        refreshSessionsList();
      };

      source.onerror = () => {
        sseFailureCount += 1;
        if (receivedUsableSseEvent && sseFailureCount < 3) {
          return;
        }
        fallBackToPolling();
      };

      source.addEventListener("task_snapshot", handleSnapshot as EventListener);
      source.addEventListener("task_message", handleTaskMessage as EventListener);
      source.addEventListener("tool_confirmation_pending", handleToolConfirmation as EventListener);
      source.addEventListener("tool_confirmation_resolved", handleToolConfirmation as EventListener);
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
                      {connectedApps.map((connectedApp) => (
                        <div key={connectedApp.appId} className="connected-app-row">
                          <div>
                            <strong>{connectedApp.label}</strong>
                            <small>
                              {connectedApp.connectedAccount
                                ? `${connectedApp.connectedAccount.accountLabel} · ${connectedApp.connectedAccount.status}`
                                : connectedApp.description}
                            </small>
                          </div>
                          {connectedApp.status === "connected" ? (
                            <span className="status-ok">Connected</span>
                          ) : (
                            <button type="button" className="button compact" onClick={handleConnectGithub}>
                              Connect GitHub
                            </button>
                          )}
                        </div>
                      ))}

                      {toolConfigurations.length > 0 ? (
                        toolConfigurations.map((toolConfiguration) => {
                          const item = appRegistry.find((registryEntry) => registryEntry.id === toolConfiguration.appId);
                          const appLabel = item?.label ?? toolConfiguration.appId;
                          return (
                            <label key={toolConfiguration.id} className="toggle-row">
                              <span>
                                {appLabel}
                                <small>{toolConfiguration.toolName}</small>
                              </span>
                              <select
                                aria-label={`${appLabel} ${toolConfiguration.toolName} mode`}
                                value={toolConfiguration.mode}
                                onChange={(event) =>
                                  handleToolConfigurationModeChange(
                                    toolConfiguration.id,
                                    event.target.value as ToolConfigurationMode
                                  )
                                }
                              >
                                {(["auto", "ask_each_time", "disabled"] as const).map((mode) => (
                                  <option key={mode} value={mode}>
                                    {toolConfigurationModeLabel(mode)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          );
                        })
                      ) : (
                        editingSpec.apps.map((app) => {
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
                        })
                      )}
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
              {activeSession.latestTask ? (
                <ActivityBlock
                  task={activeSession.latestTask}
                  taskMessages={activeSession.taskMessages}
                  toolConfirmations={activeSession.pendingToolConfirmations ?? []}
                  onApproveToolConfirmation={handleApproveToolConfirmation}
                  onDenyToolConfirmation={handleDenyToolConfirmation}
                />
              ) : null}
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

          </div>
        ) : null}
        {error ? <div className="error-banner">{error}</div> : null}
      </section>
    </main>
  );
}
