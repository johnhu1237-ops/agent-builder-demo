import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  abilityRegistry,
  appRegistry,
  skillRegistry,
  type AgentSpec,
  type RunRecord
} from "@agent-builder/shared";
import { createRun } from "./api";
import { createExportPayload, defaultUiAgentSpec } from "./defaults";

type RunState = "idle" | "running" | "succeeded" | "failed";

export default function App() {
  const [agentSpec, setAgentSpec] = useState<AgentSpec>(defaultUiAgentSpec);
  const [apiKey, setApiKey] = useState("");
  const [task, setTask] = useState("Research RunwayML and produce a concise company profile.");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabledAppCount = useMemo(
    () => agentSpec.apps.filter((app) => app.enabled).length,
    [agentSpec.apps]
  );

  function updateAgent(patch: Partial<AgentSpec>) {
    setAgentSpec((current) => ({ ...current, ...patch }));
  }

  function updateIdentity(field: keyof AgentSpec["identity"], value: string) {
    setAgentSpec((current) => ({
      ...current,
      identity: { ...current.identity, [field]: value }
    }));
  }

  function toggleApp(id: string) {
    setAgentSpec((current) => ({
      ...current,
      apps: current.apps.map((app) => (app.id === id ? { ...app, enabled: !app.enabled } : app))
    }));
  }

  function toggleSkill(id: string) {
    setAgentSpec((current) => ({
      ...current,
      skills: current.skills.map((skill) =>
        skill.id === id ? { ...skill, enabled: !skill.enabled } : skill
      )
    }));
  }

  async function runAgent() {
    setError(null);
    setRunRecord(null);

    if (!apiKey.trim()) {
      setError("API key is required");
      return;
    }

    if (!task.trim()) {
      setError("Task prompt is required");
      return;
    }

    setRunState("running");
    try {
      const run = await createRun({ agentSpec, apiKey, task });
      setRunRecord(run);
      setRunState("succeeded");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Run failed");
      setRunState("failed");
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
        <div className="agent-pill">Single agent skeleton</div>
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
            <div className="section-block">
              <p className="eyebrow">Profile</p>
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
                Persona
                <input
                  value={agentSpec.identity.persona}
                  onChange={(event) => updateIdentity("persona", event.target.value)}
                />
              </label>
              <label>
                System prompt
                <textarea
                  rows={5}
                  value={agentSpec.systemPrompt}
                  onChange={(event) => updateAgent({ systemPrompt: event.target.value })}
                />
              </label>
            </div>

            <div className="section-block">
              <p className="eyebrow">Model</p>
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
                  placeholder="Used for this run only"
                />
              </label>
              <p className="hint">API keys are runtime-only in v0.1 and are not exported.</p>
            </div>

            <div className="section-block">
              <p className="eyebrow">Apps, Skills, Abilities</p>
              <div className="mini-stat">{enabledAppCount} mock apps enabled</div>
              {appRegistry.map((app) => {
                const selected = agentSpec.apps.find((item) => item.id === app.id);
                return (
                  <label className="toggle-row" key={app.id}>
                    <span>
                      <strong>{app.label}</strong>
                      <small>{app.description} Configuration-only.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(selected?.enabled)}
                      onChange={() => toggleApp(app.id)}
                    />
                  </label>
                );
              })}
              {skillRegistry.map((skill) => {
                const selected = agentSpec.skills.find((item) => item.id === skill.id);
                return (
                  <label className="toggle-row" key={skill.id}>
                    <span>
                      <strong>{skill.label}</strong>
                      <small>{skill.description}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(selected?.enabled)}
                      onChange={() => toggleSkill(skill.id)}
                    />
                  </label>
                );
              })}
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
          </section>

          <section className="run-surface" aria-label="Run console">
            <p className="eyebrow">Run Console</p>
            <label>
              Task prompt
              <textarea rows={5} value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
            <button className="button primary" type="button" onClick={runAgent} disabled={runState === "running"}>
              {runState === "running" ? "Running..." : "Run agent"}
            </button>
            {error ? <div className="error-banner">{error}</div> : null}
            <div className="trace">
              <p className="eyebrow">Trace</p>
              {(runRecord?.traceEvents.length ? runRecord.traceEvents : []).map((event) => (
                <div className="trace-item" key={event.id}>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  <span>{event.message}</span>
                </div>
              ))}
              {runState === "idle" ? <p className="hint">Run a task to see status events.</p> : null}
            </div>
            <article className="markdown-output">
              {runRecord?.finalMarkdown ? (
                <ReactMarkdown>{runRecord.finalMarkdown}</ReactMarkdown>
              ) : (
                <p className="hint">Final Markdown output will appear here.</p>
              )}
            </article>
          </section>
        </div>
      </section>
    </main>
  );
}
