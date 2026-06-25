# Session List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse prior chat sessions in the sidebar, open one to view its history, and resume the conversation — all frontend, reusing existing API endpoints.

**Architecture:** Replace the static `N chat sessions` pill in `apps/web/src/App.tsx` with a clickable session list. Selecting a session fetches its detail via the existing `getChatSession(id)` client and renders history + timeline through the existing render code. Sending with a session selected uses the existing resume-aware `sendChatMessage`. A tiny pure `formatRelativeTime` helper formats the per-row timestamp.

**Tech Stack:** React 18 + TypeScript (Vite), Vitest + @testing-library/react.

## Global Constraints

- No API, DB, or shared-package changes — the endpoints and client functions already exist (`listChatSessions`, `getChatSession`, `sendChatMessage`).
- Reuse existing CSS design language: border color `#e7eaf0`, existing `.button` / `.button.ghost` / `.button.compact` classes.
- Relative time labels: `just now` (<60s), `Nm ago` (<60m), `Nh ago` (<24h), `Nd ago` (otherwise).
- List sub-line is title + relative time + `· archived` only when `session.status === "archived"`. No per-row task-status fetches.
- Run commands from repo root. Web tests: `pnpm --filter @agent-builder/web test` (or `pnpm test` for the whole suite).

---

### Task 1: `formatRelativeTime` helper

**Files:**
- Create: `apps/web/src/relative-time.ts`
- Test: `apps/web/src/__tests__/relative-time.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatRelativeTime(iso: string, now?: number): string`. Used by Task 2 to render each session row's sub-line.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/relative-time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../relative-time";

const now = new Date("2026-06-25T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("formatRelativeTime", () => {
  it("returns 'just now' under a minute", () => {
    expect(formatRelativeTime(ago(30_000), now)).toBe("just now");
  });

  it("formats whole minutes", () => {
    expect(formatRelativeTime(ago(60_000), now)).toBe("1m ago");
    expect(formatRelativeTime(ago(5 * 60_000), now)).toBe("5m ago");
  });

  it("formats whole hours", () => {
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe("3h ago");
  });

  it("formats whole days", () => {
    expect(formatRelativeTime(ago(2 * 86_400_000), now)).toBe("2d ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatRelativeTime(ago(-10_000), now)).toBe("just now");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-builder/web test -- relative-time`
Expected: FAIL — cannot find module `../relative-time`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/relative-time.ts`:

```ts
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diffMs = Math.max(0, now - then);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-builder/web test -- relative-time`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/relative-time.ts apps/web/src/__tests__/relative-time.test.ts
git commit -m "feat(web): add formatRelativeTime helper"
```

---

### Task 2: Sidebar session list, selection, and resume wiring

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/__tests__/app.test.tsx`

**Interfaces:**
- Consumes: `formatRelativeTime` (Task 1); existing `listChatSessions`, `getChatSession`, `sendChatMessage`, `createChatSession` from `./api`.
- Produces: UI behavior only (no exported symbols).

- [ ] **Step 1: Write the failing tests**

Add this helper and these four tests to `apps/web/src/__tests__/app.test.tsx`. Put the helper near the bottom next to `jsonResponse`, and the tests inside the existing `describe("App chat workbench", ...)` block.

Helper (add at file bottom):

```ts
function sessionDetailFixture(overrides: Partial<Record<string, unknown>> = {}) {
  const ts = new Date().toISOString();
  return {
    id: "chat-session-1",
    agentSpecSnapshot: defaultAgentSpec,
    title: "Research Agent",
    sessionId: "fake-session-chat-session-1",
    workDir: "/tmp/fake",
    status: "active",
    createdAt: ts,
    updatedAt: ts,
    messages: [
      { id: "m1", chatSessionId: "chat-session-1", role: "user", contentMarkdown: "Earlier question.", taskId: "t1", createdAt: ts },
      { id: "m2", chatSessionId: "chat-session-1", role: "assistant", contentMarkdown: "# Earlier Report\n\nDone.", taskId: "t1", createdAt: ts }
    ],
    latestTask: null,
    taskMessages: [],
    ...overrides
  };
}
```

Tests:

```ts
  it("lists prior chat sessions in the sidebar with relative time", async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/api/agent/default")) return jsonResponse(persistedAgentSpec);
      if (url.endsWith("/api/chat-sessions") && options?.method !== "POST") {
        return jsonResponse([
          { id: "chat-session-1", agentSpecSnapshot: defaultAgentSpec, title: "First session", sessionId: null, workDir: null, status: "active", createdAt: old, updatedAt: old }
        ]);
      }
      return jsonResponse(defaultAgentSpec);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("First session")).toBeInTheDocument();
    });
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });

  it("opens a session and renders its history when clicked", async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/api/agent/default")) return jsonResponse(persistedAgentSpec);
      if (url.endsWith("/api/chat-sessions") && options?.method !== "POST") {
        return jsonResponse([
          { id: "chat-session-1", agentSpecSnapshot: defaultAgentSpec, title: "First session", sessionId: null, workDir: null, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        ]);
      }
      if (url.endsWith("/api/chat-sessions/chat-session-1") && (!options || options.method === undefined)) {
        return jsonResponse(sessionDetailFixture({ title: "First session" }));
      }
      return jsonResponse(defaultAgentSpec);
    });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("First session"));

    await waitFor(() => {
      expect(screen.getByText("Earlier question.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Earlier Report" })).toBeInTheDocument();
    });
  });

  it("clears the active session and message input on New chat", async () => {
    render(<App />);
    const user = userEvent.setup();

    expect(screen.getByLabelText("Message")).toHaveValue("Research RunwayML and produce a concise company profile.");

    await user.click(screen.getByRole("button", { name: "+ New chat" }));

    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.getByText("Start the conversation with the configured Research Agent.")).toBeInTheDocument();
  });

  it("resumes the selected session when sending instead of creating a new one", async () => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/api/agent/default")) return jsonResponse(persistedAgentSpec);
      if (url.endsWith("/api/chat-sessions") && options?.method !== "POST") {
        return jsonResponse([
          { id: "chat-session-1", agentSpecSnapshot: defaultAgentSpec, title: "First session", sessionId: "fake-session-chat-session-1", workDir: "/tmp/fake", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        ]);
      }
      if (url.endsWith("/api/chat-sessions/chat-session-1") && (!options || options.method === undefined)) {
        return jsonResponse(sessionDetailFixture({ title: "First session" }));
      }
      if (url.endsWith("/api/chat-sessions/chat-session-1/messages")) {
        return jsonResponse(sessionDetailFixture({ title: "First session" }), 201);
      }
      return jsonResponse(defaultAgentSpec);
    });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByText("First session"));
    await screen.findByText("Earlier question.");

    await user.click(screen.getByRole("tab", { name: "Model" }));
    await user.type(screen.getByLabelText("API key"), "sk-test");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const sentResume = fetchMock.mock.calls.some(
        ([u, o]) => String(u).endsWith("/api/chat-sessions/chat-session-1/messages") && o?.method === "POST"
      );
      expect(sentResume).toBe(true);
    });
    const createdNew = fetchMock.mock.calls.some(
      ([u, o]) => String(u).endsWith("/api/chat-sessions") && o?.method === "POST"
    );
    expect(createdNew).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agent-builder/web test -- app.test`
Expected: FAIL — `+ New chat` button and `First session` text not found (sidebar still shows the old pill).

- [ ] **Step 3: Update imports in `App.tsx`**

Change the React import (line 1) to add `useRef`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
```

Change the `./api` import (line 11) to add `getChatSession`:

```tsx
import { createChatSession, getChatSession, getDefaultAgent, listChatSessions, saveDefaultAgent, sendChatMessage } from "./api";
```

Add a new import line after the `./defaults` import (line 12):

```tsx
import { formatRelativeTime } from "./relative-time";
```

- [ ] **Step 4: Add state and a selection ref**

After the `activeSession` state line (currently line 40) add:

```tsx
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const latestSelectionRef = useRef<string | null>(null);
```

- [ ] **Step 5: Add `startNewChat` and `selectSession` functions**

Add these two functions right before the existing `function exportSpec()` (currently line 144):

```tsx
  function startNewChat() {
    latestSelectionRef.current = null;
    setActiveSession(null);
    setActiveSessionId(null);
    setMessage("");
    setError(null);
  }

  async function selectSession(id: string) {
    setError(null);
    setActiveSessionId(id);
    setLoadingSessionId(id);
    latestSelectionRef.current = id;
    try {
      const detail = await getChatSession(id);
      if (latestSelectionRef.current === id) {
        setActiveSession(detail);
      }
    } catch (selectError) {
      if (latestSelectionRef.current === id) {
        setError(selectError instanceof Error ? selectError.message : "Failed to load session");
      }
    } finally {
      if (latestSelectionRef.current === id) {
        setLoadingSessionId(null);
      }
    }
  }
```

- [ ] **Step 6: Keep `activeSessionId` in sync inside `sendMessage`**

In `sendMessage`, the success branch currently sets `setActiveSession(detail)` then updates `sessions`. Add `setActiveSessionId(detail.id);` and `latestSelectionRef.current = detail.id;` immediately after `setActiveSession(detail);`. The block becomes:

```tsx
      setActiveSession(detail);
      setActiveSessionId(detail.id);
      latestSelectionRef.current = detail.id;
      setSessions((current) => {
        const withoutCurrent = current.filter((item) => item.id !== detail.id);
        return [detail, ...withoutCurrent];
      });
```

- [ ] **Step 7: Replace the sidebar pill with the session list**

Replace the single line (currently line 157):

```tsx
        <div className="agent-pill">{sessions.length} chat sessions</div>
```

with:

```tsx
        <div className="session-list" aria-label="Chat sessions">
          <button className="button ghost compact new-chat" type="button" onClick={startNewChat}>
            + New chat
          </button>
          <ul className="session-items">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`session-item${session.id === activeSessionId ? " active" : ""}`}
                  aria-current={session.id === activeSessionId}
                  onClick={() => selectSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {formatRelativeTime(session.updatedAt)}
                    {session.status === "archived" ? " · archived" : ""}
                    {loadingSessionId === session.id ? " · loading…" : ""}
                  </span>
                </button>
              </li>
            ))}
            {sessions.length === 0 ? <li className="hint session-empty">No sessions yet.</li> : null}
          </ul>
        </div>
```

- [ ] **Step 8: Add CSS for the session list**

Append to `apps/web/src/styles.css`:

```css
.session-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.new-chat {
  width: 100%;
  justify-content: center;
}

.session-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.session-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-item:hover {
  background: #f4f6f9;
}

.session-item.active {
  background: #eef1f6;
  border-color: #e7eaf0;
}

.session-title {
  font-size: 14px;
  color: #1f2329;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  font-size: 12px;
  color: #676f7b;
}

.session-empty {
  padding: 8px 10px;
}
```

- [ ] **Step 9: Run the web tests to verify they pass**

Run: `pnpm --filter @agent-builder/web test -- app.test`
Expected: PASS — all existing tests plus the four new ones.

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @agent-builder/web typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/__tests__/app.test.tsx
git commit -m "feat(web): browse and resume chat sessions from the sidebar"
```

---

## Self-Review Notes

- **Spec coverage:** list placement (sidebar) → Task 2 Step 7; title + relative time + archived marker → Steps 7/8 + Task 1; `+ New chat` lazy-create → Steps 5/7 (clears active session; existing `sendMessage` lazy-creates); click-to-load history → Step 5 + tests; resume on send → Step 6 + resume test; relative-time helper → Task 1; tests → both tasks.
- **No per-row task-status fetch** — honored; status note in spec respected (only `archived` marker).
- **Type consistency:** `selectSession`, `startNewChat`, `formatRelativeTime`, `activeSessionId`, `loadingSessionId`, `latestSelectionRef` used consistently across steps.
