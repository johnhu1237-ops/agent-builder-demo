import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  abilityRegistry,
  appRegistry,
  skillRegistry,
  type AgentSpec,
  type ChatSession,
  type ChatSessionDetail
} from "@agent-builder/shared";
import { createChatSession, getDefaultAgent, listChatSessions, saveDefaultAgent, sendChatMessage } from "./api";
import { createExportPayload, defaultUiAgentSpec } from "./defaults";

type SendState = "idle" | "sending" | "failed";
type SaveState = "idle" | "saving" | "saved" | "failed";
type ConfigTab = "profile" | "model" | "tools";
type ToolsTab = "apps" | "skills" | "abilities";

const configTabs: Array<{ id: ConfigTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" }
];

const toolsTabs: Array<{ id: ToolsTab; label: string }> = [
  { id: "apps", label: "Apps" },
  { id: "skills", label: "Skills" },
  { id: "abilities", label: "Abilities" }
];

export default function App() {
  const [agentSpec, setAgentSpec] = useState<AgentSpec>(defaultUiAgentSpec);
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("Research RunwayML and produce a concise company profile.");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [activeConfigTab, setActiveConfigTab] = useState<ConfigTab>("profile");
  const [activeToolsTab, setActiveToolsTab] = useState<ToolsTab>("apps");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabledAppCount = useMemo(
    () => agentSpec.apps.filter((app) => app.enabled).length,
    [agentSpec.apps]
  );

  useEffect(() => {
    let cancelled = false;
    getDefaultAgent()
      .then((savedAgentSpec) => {
        if (!cancelled) setAgentSpec(savedAgentSpec);
      })
      .catch(() => undefined);
    listChatSessions()
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function updateAgent(patch: Partial<AgentSpec>) {
    setSaveState("idle");
    setAgentSpec((current) => ({ ...current, ...patch }));
  }

  function updateIdentity(field: keyof AgentSpec["identity"], value: string) {
    setSaveState("idle");
    setAgentSpec((current) => ({
      ...current,
      identity: { ...current.identity, [field]: value }
    }));
  }

  function toggleApp(id: string) {
    setSaveState("idle");
    setAgentSpec((current) => ({
      ...current,
      apps: current.apps.map((app) => (app.id === id ? { ...app, enabled: !app.enabled } : app))
    }));
  }

  function toggleSkill(id: string) {
    setSaveState("idle");
    setAgentSpec((current) => ({
      ...current,
      skills: current.skills.map((skill) =>
        skill.id === id ? { ...skill, enabled: !skill.enabled } : skill
      )
    }));
  }

  async function saveAgentConfig() {
    setError(null);
    setSaveState("saving");
    try {
      const savedSpec = await saveDefaultAgent(agentSpec);
      setAgentSpec(savedSpec);
      setSaveState("saved");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Agent configuration failed to save");
      setSaveState("failed");
    }
  }

  async function sendMessage() {
    setError(null);

    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }

    if (!message.trim()) {
      setError("Message is required");
      return;
    }

    setSendState("sending");
    try {
      const session = activeSession ?? (await createChatSession({ agentSpec, title: agentSpec.identity.name }));
      const detail = await sendChatMessage({
        chatSessionId: session.id,
        agentSpec,
        apiKey,
        message
      });
      setActiveSession(detail);
      setSessions((current) => {
        const withoutCurrent = current.filter((item) => item.id !== detail.id);
        return [detail, ...withoutCurrent];
      });
      setMessage("");
      setSendState("idle");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message failed");
      setSendState("failed");
    }
  }

  function exportSpec() {
    const payload = JSON.stringify(createExportPayload({ agentSpec }), null, 2);
    navigator.clipboard?.writeText(payload).catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Agent navigation">
        <div className="brand-mark">AB</div>
        <div>
          <p className="eyebrow">Agent Builder</p>
          <h1>Research Agent</h1>
        </div>
        <div className="agent-pill">{sessions.length} chat sessions</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>Agent Builder</h2>
          </div>
          <button className="button ghost" type="button" onClick={exportSpec}>
            Export Agent Spec
          </button>
        </header>

        <div className="content-grid">
          <section className="config-surface" aria-label="Agent configuration">
            <div className="config-toolbar">
              <div className="config-tabs" role="tablist" aria-label="Configuration sections">
                {configTabs.map((tab) => (
                  <button
                    aria-controls={`config-panel-${tab.id}`}
                    aria-selected={activeConfigTab === tab.id}
                    className="config-tab"
                    id={`config-tab-${tab.id}`}
                    key={tab.id}
                    onClick={() => setActiveConfigTab(tab.id)}
                    role="tab"
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <button
                className="button compact"
                type="button"
                onClick={saveAgentConfig}
                disabled={saveState === "saving"}
              >
                {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved" : "Save"}
              </button>
            </div>

            {activeConfigTab === "profile" ? (
              <div
                aria-labelledby="config-tab-profile"
                className="tab-panel"
                id="config-panel-profile"
                role="tabpanel"
              >
                <div className="panel-heading">
                  <p className="eyebrow">Profile</p>
                  <h3>Agent identity</h3>
                </div>
                <label>
                  Agent name
                  <input
                    value={agentSpec.identity.name}
                    onChange={(event) => updateIdentity("name", event.target.value)}
                  />
                </label>
                <label>
                  Description
                  <input
                    value={agentSpec.identity.description}
                    onChange={(event) => updateIdentity("description", event.target.value)}
                  />
                </label>
                <label>
                  System prompt
                  <textarea
                    rows={6}
                    value={agentSpec.systemPrompt}
                    onChange={(event) => updateAgent({ systemPrompt: event.target.value })}
                  />
                </label>
              </div>
            ) : null}

            {activeConfigTab === "model" ? (
              <div
                aria-labelledby="config-tab-model"
                className="tab-panel"
                id="config-panel-model"
                role="tabpanel"
              >
                <div className="panel-heading">
                  <p className="eyebrow">Model</p>
                  <h3>Runtime connection</h3>
                </div>
                <label>
                  Provider
                  <select
                    value={agentSpec.model.provider}
                    onChange={(event) =>
                      updateAgent({
                        model: {
                          ...agentSpec.model,
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
                    value={agentSpec.model.name}
                    onChange={(event) =>
                      updateAgent({ model: { ...agentSpec.model, name: event.target.value } })
                    }
                  />
                </label>
                <label>
                  API endpoint
                  <input
                    value={agentSpec.model.apiEndpoint}
                    onChange={(event) =>
                      updateAgent({ model: { ...agentSpec.model, apiEndpoint: event.target.value } })
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Used for this message only"
                  />
                </label>
                <p className="hint">API keys are runtime-only in v0.1.1 and are not exported or persisted.</p>
              </div>
            ) : null}

            {activeConfigTab === "tools" ? (
              <div
                aria-labelledby="config-tab-tools"
                className="tab-panel"
                id="config-panel-tools"
                role="tabpanel"
              >
                <div className="panel-heading">
                  <p className="eyebrow">Tools</p>
                  <h3>Apps, skills, abilities</h3>
                </div>

                <div className="config-tabs compact-tabs" role="tablist" aria-label="Tool sections">
                  {toolsTabs.map((tab) => (
                    <button
                      aria-controls={`tools-panel-${tab.id}`}
                      aria-selected={activeToolsTab === tab.id}
                      className="config-tab"
                      id={`tools-tab-${tab.id}`}
                      key={tab.id}
                      onClick={() => setActiveToolsTab(tab.id)}
                      role="tab"
                      type="button"
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {activeToolsTab === "apps" ? (
                  <div
                    aria-labelledby="tools-tab-apps"
                    className="tools-panel"
                    id="tools-panel-apps"
                    role="tabpanel"
                  >
                    <div className="tools-heading">
                      <h4>Apps</h4>
                      <div className="mini-stat">{enabledAppCount} mock apps enabled</div>
                    </div>
                    {appRegistry.map((app) => {
                      const selected = agentSpec.apps.find((item) => item.id === app.id);
                      return (
                        <label className="toggle-row" key={app.id}>
                          <span>
                            <strong>{app.label}</strong>
                            <small>{app.description} Configuration-only.</small>
                          </span>
                          <input
                            aria-checked={Boolean(selected?.enabled)}
                            className="switch-input"
                            role="switch"
                            type="checkbox"
                            checked={Boolean(selected?.enabled)}
                            onChange={() => toggleApp(app.id)}
                          />
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                {activeToolsTab === "skills" ? (
                  <div
                    aria-labelledby="tools-tab-skills"
                    className="tools-panel"
                    id="tools-panel-skills"
                    role="tabpanel"
                  >
                    <div className="tools-heading">
                      <h4>Skills</h4>
                    </div>
                    {skillRegistry.map((skill) => {
                      const selected = agentSpec.skills.find((item) => item.id === skill.id);
                      return (
                        <label className="toggle-row" key={skill.id}>
                          <span>
                            <strong>{skill.label}</strong>
                            <small>{skill.description}</small>
                          </span>
                          <input
                            aria-checked={Boolean(selected?.enabled)}
                            className="switch-input"
                            role="switch"
                            type="checkbox"
                            checked={Boolean(selected?.enabled)}
                            onChange={() => toggleSkill(skill.id)}
                          />
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                {activeToolsTab === "abilities" ? (
                  <div
                    aria-labelledby="tools-tab-abilities"
                    className="tools-panel"
                    id="tools-panel-abilities"
                    role="tabpanel"
                  >
                    <div className="tools-heading">
                      <h4>Abilities</h4>
                    </div>
                    {abilityRegistry.map((ability) => (
                      <div className="ability-row" key={ability.id}>
                        <span>
                          <strong>{ability.label}</strong>
                          <small>{ability.description}</small>
                        </span>
                        <span className="status-dot">Enabled</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="run-surface" aria-label="Chat workbench">
            <div className="workbench-header">
              <div>
                <p className="eyebrow">Workbench</p>
                <h3>Chat with Research Agent</h3>
              </div>
              <span className="task-status">
                {sendState === "sending" ? "Running" : activeSession?.latestTask?.status ?? "Ready"}
              </span>
            </div>

            <div className="message-list" aria-label="Messages">
              {(activeSession?.messages ?? []).map((chatMessage) => (
                <article className={`message ${chatMessage.role}`} key={chatMessage.id}>
                  <p className="message-role">{chatMessage.role === "user" ? "You" : agentSpec.identity.name}</p>
                  <ReactMarkdown>{chatMessage.contentMarkdown}</ReactMarkdown>
                </article>
              ))}
              {!activeSession?.messages.length ? (
                <p className="hint">Start the conversation with the configured Research Agent.</p>
              ) : null}
            </div>

            <label>
              Message
              <textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} />
            </label>
            <button className="button primary" type="button" onClick={sendMessage} disabled={sendState === "sending"}>
              {sendState === "sending" ? "Sending..." : "Send"}
            </button>
            {error ? <div className="error-banner">{error}</div> : null}

            <div className="trace">
              <p className="eyebrow">Task Timeline</p>
              {(activeSession?.taskMessages ?? []).map((event) => (
                <div className="trace-item" key={event.id}>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  <span>{event.content}</span>
                </div>
              ))}
              {!activeSession?.taskMessages.length ? <p className="hint">Task events appear after a message runs.</p> : null}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
