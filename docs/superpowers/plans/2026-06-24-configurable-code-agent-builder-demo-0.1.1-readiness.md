# Configurable Code Agent Builder Demo v0.1.1 Conversational Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the v0.1 run-only Research Agent demo into a persisted, session-first chat workbench with resumable runner state and runtime-only API keys.

**Architecture:** Keep the existing monorepo shape, but replace the run-first domain with shared `chat_session`, `chat_message`, `agent_tasks`, and `task_message` contracts. The API becomes the source of truth for persisted chat state in Postgres, while the runner remains a separate fake/Codex adapter service that receives request-only secrets and returns redacted task output plus resume pointers.

**Tech Stack:** TypeScript, Express, React, Vite, Vitest, React Markdown, `pg`, Postgres SQL migrations, Node child process APIs, Docker, Railway.

---

## Scope Check

This plan implements the v0.1.1 readiness patch described in `docs/superpowers/specs/2026-06-24-configurable-code-agent-builder-demo-0.1.1-readiness.md`.

In scope:

- Session-first single Research Agent chat.
- Postgres persistence for default agent config, chat sessions, chat messages, agent tasks, and task messages.
- Fake runner session simulation.
- Codex runner first-turn and resume command construction.
- Runtime-only API key handling and redaction before persistence.
- Chat/workbench UI with message list, composer, task status, and trace.
- Documentation for local Postgres, fake smoke, Codex smoke, Railway, and runner limitations.

Out of scope for this plan:

- Real MCP app integration.
- Permissions policy UI.
- Multi-agent CRUD.
- Encrypted API key persistence.
- Cancellation endpoint.
- Production queue leases, priority scheduling, retry trees, and cross-agent handoff.
- Artifact browser or file tree viewer.

## File Structure

Modify or create these files:

```text
package.json
apps/api/package.json
apps/api/src/index.ts
apps/api/src/runner-client.ts
apps/api/src/chat-store.ts
apps/api/src/chat-migrations.ts
apps/api/src/redaction.ts
apps/api/src/__tests__/api.test.ts
apps/api/src/__tests__/chat-store.test.ts
apps/runner/src/index.ts
apps/runner/src/fake-runner.ts
apps/runner/src/codex-runner.ts
apps/runner/src/workspace.ts
apps/runner/src/redaction.ts
apps/runner/src/__tests__/runner.test.ts
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/styles.css
apps/web/src/__tests__/app.test.tsx
packages/shared/src/index.ts
packages/shared/src/chat.ts
packages/shared/src/prompt.ts
packages/shared/src/__tests__/chat.test.ts
packages/shared/src/__tests__/prompt.test.ts
docs/local-smoke-test.md
docs/railway-deployment.md
docs/demo-script.md
docs/runner-security.md
```

Responsibilities:

- `packages/shared/src/chat.ts`: product-level chat/task/message types and runner request/response contracts. This is the main shared boundary; leave `packages/shared/src/run.ts` only as a narrow compatibility export if old tests still reference it during migration.
- `packages/shared/src/prompt.ts`: materializes first-turn and follow-up prompts using the current user message and Agent Spec snapshot.
- `apps/api/src/chat-store.ts`: Postgres-backed store for default agent config, `chat_session`, `chat_message`, `agent_tasks`, and `task_message`.
- `apps/api/src/chat-migrations.ts`: idempotent SQL schema bootstrap used by API startup and tests.
- `apps/api/src/redaction.ts`: shared API-side redaction for persisted task results and assistant-visible content.
- `apps/api/src/index.ts`: session-first HTTP API. Keep `/api/runs` only if a compatibility shim is needed during tests; primary endpoints must use chat/task vocabulary.
- `apps/api/src/runner-client.ts`: sends `CreateAgentTaskRequest` to runner `/agent-tasks`.
- `apps/runner/src/workspace.ts`: resolves persistent per-session runner workspaces.
- `apps/runner/src/fake-runner.ts`: deterministic fake session behavior.
- `apps/runner/src/codex-runner.ts`: Codex first-turn/resume command builder, timeout handling, empty-output detection, non-zero exit handling, raw output redaction, and resume fallback.
- `apps/web/src/App.tsx`: converts the right-side run console into a chat/workbench.
- `docs/*`: update smoke, deployment, and security documentation for the new session model.

## Task 1: Shared Chat and Runner Contracts

**Files:**
- Create: `packages/shared/src/chat.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/prompt.ts`
- Create: `packages/shared/src/__tests__/chat.test.ts`
- Modify: `packages/shared/src/__tests__/prompt.test.ts`

- [ ] **Step 1: Write failing shared contract tests**

Create `packages/shared/src/__tests__/chat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import { createAssistantTaskMessage, createStatusTaskMessage, type CreateAgentTaskRequest } from "../chat";

describe("chat contracts", () => {
  it("models a follow-up task request without storing runtime secrets in snapshots", () => {
    const request: CreateAgentTaskRequest = {
      chatSessionId: "chat_session_1",
      message: "Continue with pricing.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-runtime-only" },
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-builder-demo/chat_session_1"
    };

    expect(request.chatSessionId).toBe("chat_session_1");
    expect(request.sessionId).toBe("codex-session-1");
    expect(JSON.stringify(request.agentSpec)).not.toContain("sk-runtime-only");
  });

  it("creates task messages with product vocabulary", () => {
    expect(createStatusTaskMessage("Running Codex").type).toBe("status");
    expect(createAssistantTaskMessage("# Done").content).toBe("# Done");
  });
});
```

Replace the existing prompt tests in `packages/shared/src/__tests__/prompt.test.ts` with tests for first-turn and follow-up materialization while preserving the unknown registry validation tests in `agent-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "../agent-spec";
import { materializeChatPrompt } from "../prompt";

describe("chat prompt materialization", () => {
  it("includes agent config and current user message on the first turn", () => {
    const prompt = materializeChatPrompt({
      agentSpec: defaultAgentSpec,
      message: "Research Acme Corp.",
      isResume: false
    });

    expect(prompt).toContain("Research Agent");
    expect(prompt).toContain("Research Acme Corp.");
    expect(prompt).toContain("Return the final answer as Markdown");
  });

  it("preserves product instructions when resuming an existing Codex session", () => {
    const prompt = materializeChatPrompt({
      agentSpec: defaultAgentSpec,
      message: "Now summarize competitors.",
      isResume: true
    });

    expect(prompt).toContain("You are continuing an existing Research Agent chat session.");
    expect(prompt).toContain("Now summarize competitors.");
    expect(prompt).toContain("Do not expose internal runner details");
  });
});
```

- [ ] **Step 2: Run shared tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/shared test
```

Expected: FAIL with errors that `../chat` and `materializeChatPrompt` are missing.

- [ ] **Step 3: Add chat contracts**

Create `packages/shared/src/chat.ts`:

```ts
import type { AgentSpec } from "./agent-spec";

export type ChatSessionStatus = "active" | "archived";
export type ChatMessageRole = "user" | "assistant";
export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
export type TaskMessageType = "status" | "text" | "tool_use" | "tool_result" | "error" | "log";

export type ChatSession = {
  id: string;
  agentSpecSnapshot: AgentSpec;
  title: string;
  sessionId: string | null;
  workDir: string | null;
  status: ChatSessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  chatSessionId: string;
  role: ChatMessageRole;
  contentMarkdown: string;
  taskId: string | null;
  createdAt: string;
};

export type AgentTask = {
  id: string;
  chatSessionId: string;
  triggerMessageId: string;
  agentSpecSnapshot: AgentSpec;
  status: AgentTaskStatus;
  sessionId: string | null;
  workDir: string | null;
  resultMarkdown: string | null;
  rawOutputRedacted: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskMessage = {
  id: string;
  taskId: string;
  seq: number;
  type: TaskMessageType;
  tool: string | null;
  content: string;
  inputJson: unknown | null;
  output: string | null;
  createdAt: string;
};

export type ChatSessionDetail = ChatSession & {
  messages: ChatMessage[];
  latestTask: AgentTask | null;
  taskMessages: TaskMessage[];
};

export type CreateChatSessionRequest = {
  agentSpec: AgentSpec;
  title?: string;
};

export type SendChatMessageRequest = {
  message: string;
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
};

export type CreateAgentTaskRequest = {
  chatSessionId: string;
  message: string;
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
  sessionId: string | null;
  workDir: string | null;
};

export type RunnerTaskMessage = Omit<TaskMessage, "id" | "taskId" | "seq" | "createdAt">;

export type RunnerAgentTaskResponse = {
  status: Exclude<AgentTaskStatus, "pending" | "running" | "cancelled">;
  finalMarkdown: string;
  rawOutputRedacted: string;
  taskMessages: RunnerTaskMessage[];
  sessionId: string | null;
  workDir: string | null;
};

export function createStatusTaskMessage(content: string): RunnerTaskMessage {
  return { type: "status", tool: null, content, inputJson: null, output: null };
}

export function createAssistantTaskMessage(content: string): RunnerTaskMessage {
  return { type: "text", tool: null, content, inputJson: null, output: null };
}
```

Modify `packages/shared/src/index.ts`:

```ts
export * from "./agent-spec";
export * from "./chat";
export * from "./plugin-registry";
export * from "./prompt";
export * from "./run";
```

- [ ] **Step 4: Add chat prompt materialization**

Modify `packages/shared/src/prompt.ts` to keep the old `materializePrompt` export and add the new session-aware function:

```ts
import type { AgentSpec } from "./agent-spec";

export function materializePrompt(input: { agentSpec: AgentSpec; task: string }): string {
  return materializeChatPrompt({
    agentSpec: input.agentSpec,
    message: input.task,
    isResume: false
  });
}

export function materializeChatPrompt(input: {
  agentSpec: AgentSpec;
  message: string;
  isResume: boolean;
}): string {
  const enabledApps = input.agentSpec.apps.filter((app) => app.enabled);
  const enabledSkills = input.agentSpec.skills.filter((skill) => skill.enabled);
  const enabledAbilities = input.agentSpec.abilities.filter((ability) => ability.enabled);
  const resumeInstruction = input.isResume
    ? "You are continuing an existing Research Agent chat session."
    : "You are starting a new Research Agent chat session.";

  return [
    `# ${input.agentSpec.identity.name}`,
    "",
    input.agentSpec.identity.description,
    "",
    `Persona: ${input.agentSpec.identity.persona}`,
    "",
    "## System Prompt",
    input.agentSpec.systemPrompt,
    "",
    "## Session Instruction",
    resumeInstruction,
    "Do not expose internal runner details, Codex CLI commands, session ids, workspace paths, raw logs, or secret handling in the final user-visible response.",
    "Return the final answer as Markdown.",
    "",
    "## Enabled Apps",
    ...enabledApps.map((app) => `- ${app.id}: ${app.configSummary}`),
    "",
    "## Enabled Skills",
    ...enabledSkills.map((skill) => `- ${skill.id}`),
    "",
    "## Enabled Abilities",
    ...enabledAbilities.map((ability) => `- ${ability.id}`),
    "",
    "## Current User Message",
    input.message
  ].join("\n");
}
```

- [ ] **Step 5: Run shared tests and commit**

Run:

```bash
pnpm --filter @agent-builder/shared test
pnpm --filter @agent-builder/shared typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/shared/src/chat.ts packages/shared/src/index.ts packages/shared/src/prompt.ts packages/shared/src/__tests__/chat.test.ts packages/shared/src/__tests__/prompt.test.ts
git commit -m "feat: add chat session contracts"
```

## Task 2: Postgres Chat Store and Migrations

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/chat-migrations.ts`
- Create: `apps/api/src/chat-store.ts`
- Create: `apps/api/src/redaction.ts`
- Create: `apps/api/src/__tests__/chat-store.test.ts`

- [ ] **Step 1: Add Postgres dependencies**

Run:

```bash
pnpm add --filter @agent-builder/api pg
pnpm add --filter @agent-builder/api -D @types/pg pg-mem
```

Expected: `apps/api/package.json` includes `pg` in dependencies and `@types/pg`, `pg-mem` in devDependencies.

- [ ] **Step 2: Write failing store tests**

Create `apps/api/src/__tests__/chat-store.test.ts`:

```ts
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";

describe("PgChatStore", () => {
  let pool: import("pg").Pool;
  let store: PgChatStore;

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await runChatMigrations(pool);
    store = new PgChatStore(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it("persists chat sessions and messages across store instances", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Research Acme.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });
    await store.completeAgentTask(task.id, {
      status: "completed",
      resultMarkdown: "# Done",
      rawOutputRedacted: "raw output",
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-builder-demo/chat-session-1",
      taskMessages: [{ type: "status", tool: null, content: "Completed", inputJson: null, output: null }]
    });

    const secondStore = new PgChatStore(pool);
    const detail = await secondStore.getChatSessionDetail(session.id);

    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail?.latestTask?.status).toBe("completed");
    expect(detail?.sessionId).toBe("codex-session-1");
    expect(detail?.workDir).toBe("/tmp/agent-builder-demo/chat-session-1");
    expect(detail?.taskMessages[0]?.content).toBe("Completed");
  });

  it("does not overwrite existing session resume pointers with empty failed-task values", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Research Agent" });
    await store.updateChatSessionResumePointers(session.id, {
      sessionId: "codex-session-1",
      workDir: "/tmp/work"
    });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Continue.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });
    await store.failAgentTask(task.id, {
      status: "failed",
      error: "Codex exited with code 1",
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: [{ type: "error", tool: null, content: "Codex exited with code 1", inputJson: null, output: null }]
    });

    const detail = await store.getChatSessionDetail(session.id);

    expect(detail?.sessionId).toBe("codex-session-1");
    expect(detail?.workDir).toBe("/tmp/work");
  });
});
```

- [ ] **Step 3: Run store tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
```

Expected: FAIL with missing `chat-migrations` and `chat-store` modules.

- [ ] **Step 4: Add idempotent migration SQL**

Create `apps/api/src/chat-migrations.ts`:

```ts
import type { Pool } from "pg";

export async function runChatMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists default_agent_config (
      id text primary key,
      agent_spec jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists chat_session (
      id text primary key,
      agent_spec_snapshot jsonb not null,
      title text not null,
      session_id text,
      work_dir text,
      status text not null check (status in ('active', 'archived')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists chat_message (
      id text primary key,
      chat_session_id text not null references chat_session(id) on delete cascade,
      role text not null check (role in ('user', 'assistant')),
      content_markdown text not null,
      task_id text,
      created_at timestamptz not null default now()
    );

    create table if not exists agent_tasks (
      id text primary key,
      chat_session_id text not null references chat_session(id) on delete cascade,
      trigger_message_id text not null references chat_message(id) on delete cascade,
      agent_spec_snapshot jsonb not null,
      status text not null check (status in ('pending', 'running', 'completed', 'failed', 'timed_out', 'cancelled')),
      session_id text,
      work_dir text,
      result_markdown text,
      raw_output_redacted text,
      error text,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      completed_at timestamptz
    );

    create table if not exists task_message (
      id text primary key,
      task_id text not null references agent_tasks(id) on delete cascade,
      seq integer not null,
      type text not null check (type in ('status', 'text', 'tool_use', 'tool_result', 'error', 'log')),
      tool text,
      content text not null,
      input_json jsonb,
      output text,
      created_at timestamptz not null default now(),
      unique (task_id, seq)
    );

    create index if not exists idx_chat_message_session_created on chat_message(chat_session_id, created_at);
    create index if not exists idx_agent_tasks_session_created on agent_tasks(chat_session_id, created_at);
    create index if not exists idx_task_message_task_seq on task_message(task_id, seq);
  `);
}
```

- [ ] **Step 5: Add redaction helper**

Create `apps/api/src/redaction.ts`:

```ts
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /OPENAI_API_KEY=([^\s]+)/g,
  /api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi
];

export function redactSecrets(input: string, runtimeSecrets: string[] = []): string {
  let redacted = input;
  for (const secret of runtimeSecrets.filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.includes("=")) {
        return match.replace(/=.*/, "=[REDACTED]");
      }
      if (match.includes(":")) {
        return match.replace(/:.*/, ": [REDACTED]");
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}
```

- [ ] **Step 6: Add Postgres store implementation**

Create `apps/api/src/chat-store.ts`:

```ts
import { nanoid } from "nanoid";
import { exportAgentSpec, type AgentSpec, type AgentTask, type AgentTaskStatus, type ChatMessage, type ChatMessageRole, type ChatSession, type ChatSessionDetail, type RunnerTaskMessage, type TaskMessage } from "@agent-builder/shared";
import type { Pool } from "pg";

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function mapSession(row: Record<string, any>): ChatSession {
  return {
    id: row.id,
    agentSpecSnapshot: row.agent_spec_snapshot,
    title: row.title,
    sessionId: row.session_id,
    workDir: row.work_dir,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapMessage(row: Record<string, any>): ChatMessage {
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    role: row.role,
    contentMarkdown: row.content_markdown,
    taskId: row.task_id,
    createdAt: iso(row.created_at)
  };
}

function mapTask(row: Record<string, any>): AgentTask {
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    triggerMessageId: row.trigger_message_id,
    agentSpecSnapshot: row.agent_spec_snapshot,
    status: row.status,
    sessionId: row.session_id,
    workDir: row.work_dir,
    resultMarkdown: row.result_markdown,
    rawOutputRedacted: row.raw_output_redacted,
    error: row.error,
    createdAt: iso(row.created_at),
    startedAt: row.started_at ? iso(row.started_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null
  };
}

function mapTaskMessage(row: Record<string, any>): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    tool: row.tool,
    content: row.content,
    inputJson: row.input_json,
    output: row.output,
    createdAt: iso(row.created_at)
  };
}

export class PgChatStore {
  constructor(private readonly pool: Pool) {}

  async getDefaultAgentSpec(): Promise<AgentSpec | null> {
    const result = await this.pool.query("select agent_spec from default_agent_config where id = $1", ["default"]);
    return result.rows[0]?.agent_spec ?? null;
  }

  async saveDefaultAgentSpec(agentSpec: AgentSpec): Promise<AgentSpec> {
    const snapshot = exportAgentSpec(agentSpec);
    await this.pool.query(
      `insert into default_agent_config (id, agent_spec, updated_at)
       values ($1, $2, now())
       on conflict (id) do update set agent_spec = excluded.agent_spec, updated_at = now()`,
      ["default", snapshot]
    );
    return snapshot;
  }

  async createChatSession(input: { agentSpec: AgentSpec; title: string }): Promise<ChatSession> {
    const id = nanoid();
    const snapshot = exportAgentSpec(input.agentSpec);
    const result = await this.pool.query(
      `insert into chat_session (id, agent_spec_snapshot, title, status)
       values ($1, $2, $3, 'active')
       returning *`,
      [id, snapshot, input.title]
    );
    return mapSession(result.rows[0]);
  }

  async listChatSessions(): Promise<ChatSession[]> {
    const result = await this.pool.query("select * from chat_session where status = 'active' order by updated_at desc");
    return result.rows.map(mapSession);
  }

  async getChatSessionDetail(id: string): Promise<ChatSessionDetail | null> {
    const sessionResult = await this.pool.query("select * from chat_session where id = $1", [id]);
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) return null;

    const messagesResult = await this.pool.query("select * from chat_message where chat_session_id = $1 order by created_at asc", [id]);
    const tasksResult = await this.pool.query("select * from agent_tasks where chat_session_id = $1 order by created_at desc limit 1", [id]);
    const latestTask = tasksResult.rows[0] ? mapTask(tasksResult.rows[0]) : null;
    const taskMessagesResult = latestTask
      ? await this.pool.query("select * from task_message where task_id = $1 order by seq asc", [latestTask.id])
      : { rows: [] };

    return {
      ...mapSession(sessionRow),
      messages: messagesResult.rows.map(mapMessage),
      latestTask,
      taskMessages: taskMessagesResult.rows.map(mapTaskMessage)
    };
  }

  async createChatMessage(input: {
    chatSessionId: string;
    role: ChatMessageRole;
    contentMarkdown: string;
    taskId: string | null;
  }): Promise<ChatMessage> {
    const id = nanoid();
    const result = await this.pool.query(
      `insert into chat_message (id, chat_session_id, role, content_markdown, task_id)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [id, input.chatSessionId, input.role, input.contentMarkdown, input.taskId]
    );
    await this.touchSession(input.chatSessionId);
    return mapMessage(result.rows[0]);
  }

  async createAgentTask(input: { chatSessionId: string; triggerMessageId: string; agentSpec: AgentSpec }): Promise<AgentTask> {
    const id = nanoid();
    const result = await this.pool.query(
      `insert into agent_tasks (id, chat_session_id, trigger_message_id, agent_spec_snapshot, status, created_at)
       values ($1, $2, $3, $4, 'pending', now())
       returning *`,
      [id, input.chatSessionId, input.triggerMessageId, exportAgentSpec(input.agentSpec)]
    );
    await this.pool.query("update chat_message set task_id = $1 where id = $2", [id, input.triggerMessageId]);
    await this.touchSession(input.chatSessionId);
    return mapTask(result.rows[0]);
  }

  async markAgentTaskRunning(taskId: string): Promise<AgentTask> {
    const result = await this.pool.query(
      `update agent_tasks set status = 'running', started_at = now() where id = $1 returning *`,
      [taskId]
    );
    return mapTask(result.rows[0]);
  }

  async completeAgentTask(taskId: string, input: {
    status: "completed";
    resultMarkdown: string;
    rawOutputRedacted: string;
    sessionId: string | null;
    workDir: string | null;
    taskMessages: RunnerTaskMessage[];
  }): Promise<AgentTask> {
    const result = await this.pool.query(
      `update agent_tasks
       set status = $2, result_markdown = $3, raw_output_redacted = $4, session_id = $5, work_dir = $6, completed_at = now()
       where id = $1
       returning *`,
      [taskId, input.status, input.resultMarkdown, input.rawOutputRedacted, input.sessionId, input.workDir]
    );
    const task = mapTask(result.rows[0]);
    await this.insertTaskMessages(taskId, input.taskMessages);
    await this.updateChatSessionResumePointers(task.chatSessionId, { sessionId: input.sessionId, workDir: input.workDir });
    await this.createChatMessage({
      chatSessionId: task.chatSessionId,
      role: "assistant",
      contentMarkdown: input.resultMarkdown,
      taskId
    });
    return task;
  }

  async failAgentTask(taskId: string, input: {
    status: Exclude<AgentTaskStatus, "pending" | "running" | "completed" | "cancelled">;
    error: string;
    rawOutputRedacted: string;
    sessionId: string | null;
    workDir: string | null;
    taskMessages: RunnerTaskMessage[];
  }): Promise<AgentTask> {
    const result = await this.pool.query(
      `update agent_tasks
       set status = $2, error = $3, raw_output_redacted = $4, session_id = $5, work_dir = $6, completed_at = now()
       where id = $1
       returning *`,
      [taskId, input.status, input.error, input.rawOutputRedacted, input.sessionId, input.workDir]
    );
    const task = mapTask(result.rows[0]);
    await this.insertTaskMessages(taskId, input.taskMessages);
    await this.updateChatSessionResumePointers(task.chatSessionId, { sessionId: input.sessionId, workDir: input.workDir });
    return task;
  }

  async updateChatSessionResumePointers(id: string, input: { sessionId: string | null; workDir: string | null }): Promise<void> {
    if (!input.sessionId && !input.workDir) {
      await this.touchSession(id);
      return;
    }
    await this.pool.query(
      `update chat_session
       set session_id = coalesce($2, session_id),
           work_dir = coalesce($3, work_dir),
           updated_at = now()
       where id = $1`,
      [id, input.sessionId, input.workDir]
    );
  }

  private async insertTaskMessages(taskId: string, messages: RunnerTaskMessage[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      await this.pool.query(
        `insert into task_message (id, task_id, seq, type, tool, content, input_json, output)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [nanoid(), taskId, index + 1, message.type, message.tool, message.content, message.inputJson, message.output]
      );
    }
  }

  private async touchSession(id: string): Promise<void> {
    await this.pool.query("update chat_session set updated_at = now() where id = $1", [id]);
  }
}
```

- [ ] **Step 7: Run store tests and commit**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
pnpm --filter @agent-builder/api typecheck
```

Expected: PASS.

Commit:

```bash
git add package.json pnpm-lock.yaml apps/api/package.json apps/api/src/chat-migrations.ts apps/api/src/chat-store.ts apps/api/src/redaction.ts apps/api/src/__tests__/chat-store.test.ts
git commit -m "feat: persist chat sessions in Postgres"
```

## Task 3: Session-First API Lifecycle

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/runner-client.ts`
- Modify: `apps/api/src/__tests__/api.test.ts`

- [ ] **Step 1: Replace API tests with session-first behavior**

Modify `apps/api/src/__tests__/api.test.ts`:

```ts
import request from "supertest";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";
import { createApiApp } from "../index";

describe("chat API orchestrator", () => {
  let pool: import("pg").Pool;
  let store: PgChatStore;

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await runChatMigrations(pool);
    store = new PgChatStore(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it("returns the default agent without an API key", async () => {
    const app = createApiApp({ chatStore: store });
    const response = await request(app).get("/api/agent/default").expect(200);

    expect(response.body.identity.name).toBe("Research Agent");
    expect(JSON.stringify(response.body)).not.toContain("apiKey");
  });

  it("creates a chat session and persists it", async () => {
    const app = createApiApp({ chatStore: store });
    const response = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "Research Agent" })
      .expect(201);

    expect(response.body.title).toBe("Research Agent");
    expect(response.body.sessionId).toBeNull();

    const list = await request(app).get("/api/chat-sessions").expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("sends a first message, creates an agent task, assistant message, and resume pointers", async () => {
    const runAgentTask = vi.fn().mockResolvedValue({
      status: "completed",
      finalMarkdown: "# Research Report\n\nDone.",
      rawOutputRedacted: "runner output",
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-builder-demo/chat-session-1",
      taskMessages: [{ type: "status", tool: null, content: "Completed", inputJson: null, output: null }]
    });
    const app = createApiApp({ chatStore: store, runAgentTask });
    const session = await request(app)
      .post("/api/chat-sessions")
      .send({ agentSpec: defaultAgentSpec, title: "Research Agent" })
      .expect(201);

    const send = await request(app)
      .post(`/api/chat-sessions/${session.body.id}/messages`)
      .send({
        agentSpec: defaultAgentSpec,
        runtimeSecrets: { apiKey: "sk-test" },
        message: "Research Acme."
      })
      .expect(201);

    expect(send.body.latestTask.status).toBe("completed");
    expect(send.body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(send.body.sessionId).toBe("codex-session-1");
    expect(JSON.stringify(send.body)).not.toContain("sk-test");
    expect(runAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      chatSessionId: session.body.id,
      message: "Research Acme.",
      sessionId: null,
      workDir: null
    }));
  });

  it("sends a follow-up with existing sessionId and workDir", async () => {
    const runAgentTask = vi.fn()
      .mockResolvedValueOnce({
        status: "completed",
        finalMarkdown: "# First",
        rawOutputRedacted: "first",
        sessionId: "codex-session-1",
        workDir: "/tmp/agent-builder-demo/chat-session-1",
        taskMessages: []
      })
      .mockResolvedValueOnce({
        status: "completed",
        finalMarkdown: "# Follow Up",
        rawOutputRedacted: "second",
        sessionId: "codex-session-1",
        workDir: "/tmp/agent-builder-demo/chat-session-1",
        taskMessages: []
      });
    const app = createApiApp({ chatStore: store, runAgentTask });
    const session = await request(app).post("/api/chat-sessions").send({ agentSpec: defaultAgentSpec }).expect(201);

    await request(app).post(`/api/chat-sessions/${session.body.id}/messages`).send({
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      message: "Research Acme."
    }).expect(201);

    await request(app).post(`/api/chat-sessions/${session.body.id}/messages`).send({
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      message: "Continue."
    }).expect(201);

    expect(runAgentTask).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-builder-demo/chat-session-1",
      message: "Continue."
    }));
  });

  it("rejects message creation without a runtime API key", async () => {
    const app = createApiApp({ chatStore: store });
    const session = await request(app).post("/api/chat-sessions").send({ agentSpec: defaultAgentSpec }).expect(201);

    const response = await request(app)
      .post(`/api/chat-sessions/${session.body.id}/messages`)
      .send({ agentSpec: defaultAgentSpec, runtimeSecrets: { apiKey: "" }, message: "Research Acme." })
      .expect(400);

    expect(response.body.error).toBe("API key is required");
  });
});
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/api.test.ts
```

Expected: FAIL because `createApiApp` still expects `runStore` and `/api/runs`.

- [ ] **Step 3: Update runner client contract**

Modify `apps/api/src/runner-client.ts`:

```ts
import type { CreateAgentTaskRequest, RunnerAgentTaskResponse } from "@agent-builder/shared";

export type RunnerClient = {
  runAgentTask(request: CreateAgentTaskRequest): Promise<RunnerAgentTaskResponse>;
};

export function createHttpRunnerClient(baseUrl: string): RunnerClient {
  return {
    async runAgentTask(request) {
      const response = await fetch(`${baseUrl}/agent-tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error ?? `Runner request failed with ${response.status}`);
      }

      return body as RunnerAgentTaskResponse;
    }
  };
}
```

- [ ] **Step 4: Implement session-first API**

Modify `apps/api/src/index.ts`:

```ts
import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { defaultAgentSpec, exportAgentSpec, validateAgentSpec, type AgentSpec, type AgentTaskStatus } from "@agent-builder/shared";
import { runChatMigrations } from "./chat-migrations";
import { PgChatStore } from "./chat-store";
import { redactSecrets } from "./redaction";
import { createHttpRunnerClient, type RunnerClient } from "./runner-client";

export type ApiDependencies = Partial<RunnerClient> & {
  chatStore?: PgChatStore;
};

let currentAgentSpec: AgentSpec = defaultAgentSpec;

function publicAgentSpec(spec: AgentSpec): AgentSpec {
  const exported = exportAgentSpec(spec);
  const { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...model } = exported.model;
  return { ...exported, model };
}

function stableError(message: string) {
  return { error: message };
}

function statusFromError(message: string): Exclude<AgentTaskStatus, "pending" | "running" | "completed" | "cancelled"> {
  return message.toLowerCase().includes("timed out") ? "timed_out" : "failed";
}

export function createApiApp(deps: ApiDependencies = {}) {
  const app = express();
  const chatStore = deps.chatStore;
  if (!chatStore) {
    throw new Error("createApiApp requires a PgChatStore. Use createProductionApiApp for process startup.");
  }
  const runnerClient: RunnerClient = {
    runAgentTask:
      deps.runAgentTask ??
      createHttpRunnerClient(process.env.RUNNER_BASE_URL ?? "http://localhost:4101").runAgentTask
  };

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/agent/default", async (_req, res) => {
    const persisted = await chatStore.getDefaultAgentSpec();
    if (persisted) currentAgentSpec = persisted;
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.put("/api/agent/default", async (req, res) => {
    const validation = validateAgentSpec(req.body);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    currentAgentSpec = await chatStore.saveDefaultAgentSpec(validation.data);
    res.json(publicAgentSpec(currentAgentSpec));
  });

  app.post("/api/chat-sessions", async (req, res) => {
    const validation = validateAgentSpec(req.body.agentSpec ?? currentAgentSpec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }
    const session = await chatStore.createChatSession({
      agentSpec: validation.data,
      title: String(req.body.title ?? validation.data.identity.name)
    });
    res.status(201).json(session);
  });

  app.get("/api/chat-sessions", async (_req, res) => {
    res.json(await chatStore.listChatSessions());
  });

  app.get("/api/chat-sessions/:id", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }
    res.json(detail);
  });

  app.post("/api/chat-sessions/:id/messages", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }

    const validation = validateAgentSpec(req.body.agentSpec);
    if (!validation.success) {
      res.status(400).json(stableError(validation.error.message));
      return;
    }

    const message = String(req.body.message ?? "").trim();
    const apiKey = String(req.body.runtimeSecrets?.apiKey ?? "").trim();
    if (!message) {
      res.status(400).json(stableError("Message is required"));
      return;
    }
    if (!apiKey) {
      res.status(400).json(stableError("API key is required"));
      return;
    }

    const userMessage = await chatStore.createChatMessage({
      chatSessionId: detail.id,
      role: "user",
      contentMarkdown: redactSecrets(message, [apiKey]),
      taskId: null
    });
    const task = await chatStore.createAgentTask({
      chatSessionId: detail.id,
      triggerMessageId: userMessage.id,
      agentSpec: validation.data
    });

    await chatStore.markAgentTaskRunning(task.id);

    try {
      const result = await runnerClient.runAgentTask({
        chatSessionId: detail.id,
        message,
        agentSpec: validation.data,
        runtimeSecrets: { apiKey },
        sessionId: detail.sessionId,
        workDir: detail.workDir
      });
      if (result.status === "completed" && result.finalMarkdown.trim()) {
        await chatStore.completeAgentTask(task.id, {
          status: "completed",
          resultMarkdown: redactSecrets(result.finalMarkdown, [apiKey]),
          rawOutputRedacted: redactSecrets(result.rawOutputRedacted, [apiKey]),
          sessionId: result.sessionId,
          workDir: result.workDir,
          taskMessages: result.taskMessages.map((item) => ({
            ...item,
            content: redactSecrets(item.content, [apiKey]),
            output: item.output ? redactSecrets(item.output, [apiKey]) : null
          }))
        });
      } else {
        await chatStore.failAgentTask(task.id, {
          status: result.status === "timed_out" ? "timed_out" : "failed",
          error: result.finalMarkdown || "Runner did not produce assistant content",
          rawOutputRedacted: redactSecrets(result.rawOutputRedacted, [apiKey]),
          sessionId: result.sessionId,
          workDir: result.workDir,
          taskMessages: result.taskMessages
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Runner failed";
      await chatStore.failAgentTask(task.id, {
        status: statusFromError(messageText),
        error: redactSecrets(messageText, [apiKey]),
        rawOutputRedacted: "",
        sessionId: null,
        workDir: null,
        taskMessages: [{ type: "error", tool: null, content: redactSecrets(messageText, [apiKey]), inputJson: null, output: null }]
      });
      const failedDetail = await chatStore.getChatSessionDetail(detail.id);
      res.status(500).json(failedDetail);
      return;
    }

    res.status(201).json(await chatStore.getChatSessionDetail(detail.id));
  });

  app.get("/api/chat-sessions/:id/events", async (req, res) => {
    const detail = await chatStore.getChatSessionDetail(req.params.id);
    if (!detail) {
      res.status(404).json(stableError("Chat session not found"));
      return;
    }
    res.json({ task: detail.latestTask, taskMessages: detail.taskMessages });
  });

  app.get("/api/agent-tasks/:id", async (_req, res) => {
    res.status(501).json(stableError("Use GET /api/chat-sessions/:id for v0.1.1 task details"));
  });

  return app;
}

async function createProductionApiApp() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for v0.1.1 chat persistence");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  await runChatMigrations(pool);
  return createApiApp({ chatStore: new PgChatStore(pool) });
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.API_PORT ?? 4001);
  createProductionApiApp().then((app) => {
    app.listen(port, () => {
      console.log(`api listening on ${port}`);
    });
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run API tests and commit**

Run:

```bash
pnpm --filter @agent-builder/api test
pnpm --filter @agent-builder/api typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/api/src/index.ts apps/api/src/runner-client.ts apps/api/src/__tests__/api.test.ts
git commit -m "feat: add chat session API lifecycle"
```

## Task 4: Fake Runner and Codex Resume Contracts

**Files:**
- Create: `apps/runner/src/workspace.ts`
- Create: `apps/runner/src/redaction.ts`
- Modify: `apps/runner/src/fake-runner.ts`
- Modify: `apps/runner/src/codex-runner.ts`
- Modify: `apps/runner/src/index.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Modify `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { createCodexCommand } from "../codex-runner";
import { runFakeAgentTask } from "../fake-runner";
import { redactRunnerOutput } from "../redaction";
import { resolveWorkspacePath } from "../workspace";

describe("runner adapters", () => {
  it("fake runner returns deterministic session metadata and task messages", async () => {
    const result = await runFakeAgentTask({
      chatSessionId: "chat-session-1",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      message: "Research Acme Corp.",
      sessionId: null,
      workDir: null
    });

    expect(result.status).toBe("completed");
    expect(result.finalMarkdown).toContain("Research Acme Corp.");
    expect(result.sessionId).toBe("fake-session-chat-session-1");
    expect(result.workDir).toContain("fake-workspaces/chat-session-1");
    expect(result.taskMessages.map((event) => event.type)).toEqual(["status", "text", "status"]);
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("Codex command supports first-turn execution", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/work",
      finalPath: "/tmp/work/final.md",
      prompt: "Return Markdown.",
      sessionId: null
    });

    expect(command.args).toContain("exec");
    expect(command.args).not.toContain("resume");
    expect(command.args).toContain("--output-last-message");
  });

  it("Codex command supports resumed execution", () => {
    const command = createCodexCommand({
      modelName: "gpt-5",
      workspacePath: "/tmp/work",
      finalPath: "/tmp/work/final.md",
      prompt: "Continue.",
      sessionId: "codex-session-1"
    });

    expect(command.args).toContain("resume");
    expect(command.args).toContain("codex-session-1");
    expect(command.args).toContain("Continue.");
  });

  it("redacts runtime API keys from raw output", () => {
    expect(redactRunnerOutput("OPENAI_API_KEY=sk-test secret", ["sk-test"])).toBe("OPENAI_API_KEY=[REDACTED] secret");
  });

  it("resolves a stable workspace path per chat session", async () => {
    const workDir = await resolveWorkspacePath({
      requestedWorkDir: null,
      chatSessionId: "chat-session-1",
      rootDir: "/tmp/agent-builder-demo-runner"
    });

    expect(workDir).toBe("/tmp/agent-builder-demo-runner/chat-session-1");
  });
});
```

- [ ] **Step 2: Run runner tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/runner test
```

Expected: FAIL with missing `workspace`, `redaction`, and new runner functions.

- [ ] **Step 3: Add runner redaction and workspace helpers**

Create `apps/runner/src/redaction.ts`:

```ts
export function redactRunnerOutput(input: string, secrets: string[] = []): string {
  let output = input;
  for (const secret of secrets.filter(Boolean)) {
    output = output.split(secret).join("[REDACTED]");
  }
  output = output.replace(/OPENAI_API_KEY=([^\s]+)/g, "OPENAI_API_KEY=[REDACTED]");
  output = output.replace(/sk-[A-Za-z0-9_-]{4,}/g, "[REDACTED]");
  return output;
}
```

Create `apps/runner/src/workspace.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function resolveWorkspacePath(input: {
  requestedWorkDir: string | null;
  chatSessionId: string;
  rootDir: string;
}): Promise<string> {
  const workDir = input.requestedWorkDir?.trim()
    ? input.requestedWorkDir
    : join(input.rootDir, input.chatSessionId);
  const resolved = resolve(workDir);
  await mkdir(resolved, { recursive: true });
  return resolved;
}
```

- [ ] **Step 4: Update fake runner**

Modify `apps/runner/src/fake-runner.ts`:

```ts
import { createAssistantTaskMessage, createStatusTaskMessage, type CreateAgentTaskRequest, type RunnerAgentTaskResponse } from "@agent-builder/shared";

export async function runFakeAgentTask(request: CreateAgentTaskRequest): Promise<RunnerAgentTaskResponse> {
  const sessionId = request.sessionId ?? `fake-session-${request.chatSessionId}`;
  const workDir = request.workDir ?? `/tmp/agent-builder-demo/fake-workspaces/${request.chatSessionId}`;
  const finalMarkdown = [
    "# Research Report",
    "",
    "## Executive Summary",
    `This is a deterministic demo response for: ${request.message}`,
    "",
    "## Session",
    request.sessionId ? "Session resumed." : "Fresh session started.",
    "",
    "## Recommendation",
    "Use Codex mode after deployment credentials and persistent runner storage are configured."
  ].join("\n");

  return {
    status: "completed",
    finalMarkdown,
    rawOutputRedacted: "fake runner completed successfully",
    sessionId,
    workDir,
    taskMessages: [
      createStatusTaskMessage(request.sessionId ? "Resuming fake session" : "Starting fake session"),
      createAssistantTaskMessage(finalMarkdown),
      createStatusTaskMessage("Task completed")
    ]
  };
}
```

- [ ] **Step 5: Update Codex command builder and runner**

Modify `apps/runner/src/codex-runner.ts`:

```ts
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusTaskMessage, materializeChatPrompt, type CreateAgentTaskRequest, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { redactRunnerOutput } from "./redaction";
import { resolveWorkspacePath } from "./workspace";

export type CodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  prompt: string;
  sessionId: string | null;
};

export type CodexCommand = {
  command: "codex";
  args: string[];
};

export function createCodexCommand(input: CodexCommandInput): CodexCommand {
  const execArgs = input.sessionId ? ["exec", "resume", input.sessionId] : ["exec"];
  return {
    command: "codex",
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      ...execArgs,
      "--json",
      "--model",
      input.modelName,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "--output-last-message",
      input.finalPath,
      "-C",
      input.workspacePath,
      input.prompt
    ]
  };
}

export async function runCodexAgentTask(request: CreateAgentTaskRequest, timeoutMs: number): Promise<RunnerAgentTaskResponse> {
  const rootDir = process.env.RUNNER_WORKSPACE_ROOT ?? join(tmpdir(), "agent-builder-demo-workspaces");
  const workspacePath = await resolveWorkspacePath({
    requestedWorkDir: request.workDir,
    chatSessionId: request.chatSessionId,
    rootDir
  });
  const finalPath = join(workspacePath, "final.md");
  const prompt = materializeChatPrompt({
    agentSpec: request.agentSpec,
    message: request.message,
    isResume: Boolean(request.sessionId)
  });
  await writeFile(join(workspacePath, "prompt.md"), prompt, "utf8");

  const firstCommand = createCodexCommand({
    modelName: request.agentSpec.model.name,
    workspacePath,
    finalPath,
    prompt,
    sessionId: request.sessionId
  });

  const rawChunks: string[] = [];
  const events = [
    createStatusTaskMessage(request.sessionId ? "Resuming Codex session" : "Starting Codex session")
  ];

  try {
    await runCommand(firstCommand, request, rawChunks, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex failed";
    const canFallback = Boolean(request.sessionId) && message.toLowerCase().includes("resume");
    if (!canFallback) {
      throw error;
    }
    events.push({ type: "error", tool: "codex", content: `Resume failed: ${message}. Starting fresh session.`, inputJson: null, output: null });
    const fallbackCommand = createCodexCommand({
      modelName: request.agentSpec.model.name,
      workspacePath,
      finalPath,
      prompt,
      sessionId: null
    });
    await runCommand(fallbackCommand, request, rawChunks, timeoutMs);
  }

  const finalMarkdown = await readFile(finalPath, "utf8").catch(() => "");
  if (!finalMarkdown.trim()) {
    throw new Error("Codex completed without final Markdown output");
  }

  const rawOutputRedacted = redactRunnerOutput(rawChunks.join(""), [request.runtimeSecrets.apiKey]);
  const parsedSessionId = extractSessionId(rawOutputRedacted) ?? request.sessionId;
  events.push(createStatusTaskMessage("Task completed"));

  return {
    status: "completed",
    finalMarkdown: redactRunnerOutput(finalMarkdown, [request.runtimeSecrets.apiKey]),
    rawOutputRedacted,
    taskMessages: events,
    sessionId: parsedSessionId,
    workDir: workspacePath
  };
}

async function runCommand(command: CodexCommand, request: CreateAgentTaskRequest, rawChunks: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.args[command.args.indexOf("-C") + 1],
      env: {
        ...process.env,
        OPENAI_API_KEY: request.runtimeSecrets.apiKey,
        OPENAI_BASE_URL: request.agentSpec.model.apiEndpoint
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Run timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => rawChunks.push(chunk.toString()));
    child.stderr.on("data", (chunk) => rawChunks.push(chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex exited with code ${code}`));
    });
  });
}

function extractSessionId(rawOutput: string): string | null {
  const match = rawOutput.match(/"session_id"\s*:\s*"([^"]+)"/) ?? rawOutput.match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}
```

- [ ] **Step 6: Update runner HTTP endpoint**

Modify `apps/runner/src/index.ts`:

```ts
import cors from "cors";
import express from "express";
import { validateAgentSpec, type CreateAgentTaskRequest } from "@agent-builder/shared";
import { runCodexAgentTask } from "./codex-runner";
import { runFakeAgentTask } from "./fake-runner";
import { redactRunnerOutput } from "./redaction";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.RUNNER_PORT ?? 4101);
const runnerMode = process.env.RUNNER_MODE ?? "fake";
const timeoutMs = Number(process.env.RUN_TIMEOUT_MS ?? 120000);

app.get("/health", (_req, res) => {
  res.json({ ok: true, runnerMode });
});

app.post("/agent-tasks", async (req, res) => {
  const body = req.body as CreateAgentTaskRequest;
  const validation = validateAgentSpec(body.agentSpec);

  if (!validation.success) {
    res.status(400).json({ error: validation.error.message });
    return;
  }

  if (!body.chatSessionId?.trim()) {
    res.status(400).json({ error: "chatSessionId is required" });
    return;
  }
  if (!body.message?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }
  if (!body.runtimeSecrets?.apiKey?.trim()) {
    res.status(400).json({ error: "API key is required" });
    return;
  }

  try {
    const request = { ...body, agentSpec: validation.data };
    const result =
      runnerMode === "codex"
        ? await runCodexAgentTask(request, timeoutMs)
        : await runFakeAgentTask(request);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runner failed";
    res.status(500).json({
      error: redactRunnerOutput(message, [body.runtimeSecrets?.apiKey ?? ""])
    });
  }
});

app.listen(port, () => {
  console.log(`runner listening on ${port}`);
});
```

- [ ] **Step 7: Run runner tests and commit**

Run:

```bash
pnpm --filter @agent-builder/runner test
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/runner/src/workspace.ts apps/runner/src/redaction.ts apps/runner/src/fake-runner.ts apps/runner/src/codex-runner.ts apps/runner/src/index.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: support runner chat sessions"
```

## Task 5: Chat Workbench UI

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/__tests__/app.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Modify `apps/web/src/__tests__/app.test.tsx` so it verifies chat behavior instead of a run console:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import App from "../App";

const fetchMock = vi.fn();

beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/api/chat-sessions") && !options) {
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
```

- [ ] **Step 2: Run UI tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/web test
```

Expected: FAIL because `App` still renders `Run Console` and `Task prompt`.

- [ ] **Step 3: Update web API client**

Modify `apps/web/src/api.ts`:

```ts
import type { AgentSpec, ChatSession, ChatSessionDetail } from "@agent-builder/shared";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {})
    }
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with ${response.status}`);
  }

  return body as T;
}

export function getDefaultAgent(): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default");
}

export function saveDefaultAgent(agentSpec: AgentSpec): Promise<AgentSpec> {
  return requestJson<AgentSpec>("/api/agent/default", {
    method: "PUT",
    body: JSON.stringify(agentSpec)
  });
}

export function listChatSessions(): Promise<ChatSession[]> {
  return requestJson<ChatSession[]>("/api/chat-sessions");
}

export function createChatSession(input: { agentSpec: AgentSpec; title?: string }): Promise<ChatSession> {
  return requestJson<ChatSession>("/api/chat-sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getChatSession(id: string): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${id}`);
}

export function sendChatMessage(input: {
  chatSessionId: string;
  agentSpec: AgentSpec;
  apiKey: string;
  message: string;
}): Promise<ChatSessionDetail> {
  return requestJson<ChatSessionDetail>(`/api/chat-sessions/${input.chatSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      agentSpec: input.agentSpec,
      runtimeSecrets: { apiKey: input.apiKey },
      message: input.message
    })
  });
}
```

- [ ] **Step 4: Convert App to chat/workbench**

Modify `apps/web/src/App.tsx` by keeping the left configuration surface and replacing run state with chat state. The right-side section should use these state variables and helpers:

```tsx
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
import { createChatSession, listChatSessions, sendChatMessage } from "./api";
import { createExportPayload, defaultUiAgentSpec } from "./defaults";

type SendState = "idle" | "sending" | "failed";
```

Inside `App`, replace `task`, `runState`, and `runRecord` state with:

```tsx
const [apiKey, setApiKey] = useState("");
const [message, setMessage] = useState("Research RunwayML and produce a concise company profile.");
const [sendState, setSendState] = useState<SendState>("idle");
const [sessions, setSessions] = useState<ChatSession[]>([]);
const [activeSession, setActiveSession] = useState<ChatSessionDetail | null>(null);
const [error, setError] = useState<string | null>(null);
```

Add this load effect:

```tsx
useEffect(() => {
  let cancelled = false;
  listChatSessions()
    .then((items) => {
      if (!cancelled) setSessions(items);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
  };
}, []);
```

Add this send helper:

```tsx
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
```

Replace the right-side JSX with:

```tsx
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
```

- [ ] **Step 5: Update styles for chat**

Modify `apps/web/src/styles.css` to keep existing layout rules and add:

```css
.workbench-header {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.workbench-header h3 {
  font-size: 18px;
  margin: 0;
}

.task-status {
  border: 1px solid #d8dee8;
  border-radius: 999px;
  color: #334155;
  font-size: 12px;
  padding: 6px 10px;
  text-transform: capitalize;
  white-space: nowrap;
}

.message-list {
  display: grid;
  gap: 12px;
  max-height: 420px;
  overflow: auto;
  padding-right: 4px;
}

.message {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px;
}

.message.user {
  background: #f8fafc;
}

.message.assistant {
  background: #ffffff;
}

.message-role {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  margin: 0 0 8px;
  text-transform: uppercase;
}
```

- [ ] **Step 6: Run UI tests and commit**

Run:

```bash
pnpm --filter @agent-builder/web test
pnpm --filter @agent-builder/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/styles.css apps/web/src/__tests__/app.test.tsx
git commit -m "feat: convert run console to chat workbench"
```

## Task 6: End-to-End Validation and Documentation

**Files:**
- Modify: `package.json`
- Modify: `docs/local-smoke-test.md`
- Modify: `docs/railway-deployment.md`
- Modify: `docs/demo-script.md`
- Create: `docs/runner-security.md`

- [ ] **Step 1: Add chat smoke scripts**

Modify root `package.json` scripts:

```json
{
  "smoke:health": "curl -sS http://localhost:4001/health && curl -sS http://localhost:4101/health",
  "smoke:chat": "curl -sS -X POST http://localhost:4001/api/chat-sessions -H 'content-type: application/json' -d '{\"agentSpec\":{\"identity\":{\"name\":\"Research Agent\",\"description\":\"Research companies and summarize findings.\",\"persona\":\"Clear, concise research partner\"},\"model\":{\"provider\":\"openai-compatible\",\"name\":\"gpt-5\",\"apiEndpoint\":\"https://api.openai.com/v1\"},\"systemPrompt\":\"You are a careful research assistant.\",\"apps\":[{\"id\":\"browser\",\"enabled\":true,\"configSummary\":\"Web research\"}],\"skills\":[{\"id\":\"company-research\",\"enabled\":true}],\"abilities\":[{\"id\":\"web-research\",\"enabled\":true}]},\"title\":\"Research Agent\"}'"
}
```

Keep all existing scripts.

- [ ] **Step 2: Update local smoke docs**

Modify `docs/local-smoke-test.md` with these exact sections:

```md
# Local Smoke Test

## Requirements

- Node 22+
- pnpm
- Docker
- Postgres reachable through `DATABASE_URL`

## Start Postgres

```bash
docker run --rm --name agent-builder-postgres -p 54329:5432 -e POSTGRES_PASSWORD=agent_builder -e POSTGRES_DB=agent_builder postgres:16
```

Use:

```bash
export DATABASE_URL=postgres://postgres:agent_builder@localhost:54329/agent_builder
```

## Start Services

```bash
RUNNER_MODE=fake DATABASE_URL=$DATABASE_URL pnpm dev
```

Open `http://localhost:5173`.

## Fake Chat Smoke

1. Enter any non-empty API key.
2. Send `Research RunwayML and produce a concise company profile.`
3. Confirm the message list shows the user message and a Markdown assistant response.
4. Send `Continue with competitors.`
5. Confirm the timeline shows completed task events.
6. Restart the API and confirm the chat session still appears.

## Codex Chat Smoke

```bash
RUNNER_MODE=codex RUNNER_WORKSPACE_ROOT=/tmp/agent-builder-workspaces DATABASE_URL=$DATABASE_URL pnpm dev
```

Use a valid API key in the UI. Send a first message, then a follow-up. The follow-up should reuse the saved `session_id` and `work_dir` when the runner workspace still exists.
```

- [ ] **Step 3: Update Railway docs**

Modify `docs/railway-deployment.md` to include:

```md
## v0.1.1 Services

- Web: Vite static build served from `apps/web`.
- API: Express service with `DATABASE_URL` and `RUNNER_BASE_URL`.
- Runner: Express service with `RUNNER_MODE=fake` or `RUNNER_MODE=codex`.
- Postgres: required for chat sessions, messages, tasks, and task messages.

## Required API Variables

```dotenv
DATABASE_URL=<Railway Postgres URL>
RUNNER_BASE_URL=<runner service URL>
API_PORT=4001
```

## Required Runner Variables

```dotenv
RUNNER_PORT=4101
RUNNER_MODE=fake
RUN_TIMEOUT_MS=120000
RUNNER_WORKSPACE_ROOT=/data/agent-builder-workspaces
```

Codex resume requires persistent runner storage. Without a persistent volume, chat messages still persist in Postgres, but workspace-backed resume can fail after runner restart. In that case the runner records the resume failure and starts a fresh session when safe.
```

- [ ] **Step 4: Add runner security docs**

Create `docs/runner-security.md`:

```md
# Runner Security Assumptions

v0.1.1 keeps API keys runtime-only. The browser sends the key for one message, the API passes it to the runner for that task, and neither service stores the raw key in Postgres.

The API redacts task output, assistant Markdown, and task messages before persistence. The runner also redacts raw Codex stdout/stderr before returning it.

Current limitations:

- Codex mode uses a broad local workspace sandbox for the demo runner.
- The UI does not expose permissions controls.
- `session_id` and `work_dir` are product-internal resume pointers and are not primary user-facing UI concepts.
- Persistent resume requires the runner workspace directory to survive runner restarts.
- v0.1.1 does not implement encrypted secret storage.
```

- [ ] **Step 5: Update demo script**

Modify `docs/demo-script.md` to replace one-shot run language with:

```md
# Demo Script

1. Open the Agent Builder workspace.
2. Configure the Research Agent profile, model, mock apps, and skills.
3. Enter a runtime-only API key.
4. Send the first chat message.
5. Show the user and assistant messages in the workbench.
6. Send a follow-up message.
7. Point out that the product model is a chat session, while Codex resume details stay behind the runner boundary.
8. Export the Agent Spec and confirm the raw API key is absent.
```

- [ ] **Step 6: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add package.json docs/local-smoke-test.md docs/railway-deployment.md docs/demo-script.md docs/runner-security.md
git commit -m "docs: document chat readiness smoke paths"
```

## Task 7: Manual Smoke and Release Readiness

**Files:**
- No source changes expected.

- [ ] **Step 1: Start local Postgres**

Run:

```bash
docker run --rm --name agent-builder-postgres -p 54329:5432 -e POSTGRES_PASSWORD=agent_builder -e POSTGRES_DB=agent_builder postgres:16
```

Expected: Postgres logs show `database system is ready to accept connections`.

- [ ] **Step 2: Start app in fake mode**

Run in a second terminal:

```bash
DATABASE_URL=postgres://postgres:agent_builder@localhost:54329/agent_builder RUNNER_MODE=fake pnpm dev
```

Expected: API, runner, and web services start. API listens on `4001`, runner listens on `4101`, and Vite prints a local URL.

- [ ] **Step 3: Verify health endpoints**

Run:

```bash
curl -sS http://localhost:4001/health
curl -sS http://localhost:4101/health
```

Expected:

```json
{"ok":true}
{"ok":true,"runnerMode":"fake"}
```

- [ ] **Step 4: Verify fake chat in browser**

Open the Vite URL. Enter `sk-test` in the API key field. Send:

```text
Research RunwayML and produce a concise company profile.
```

Expected:

- User message appears in the message list.
- Assistant Markdown appears with `# Research Report`.
- Task timeline shows status/text/status events.
- No raw API key appears in the page.

- [ ] **Step 5: Verify follow-up resume behavior**

Send:

```text
Continue with competitors.
```

Expected:

- A second user message and assistant response appear.
- Task status returns to `completed`.
- Postgres-backed session survives API restart.

- [ ] **Step 6: Verify persistence after API restart**

Stop only the API process and restart it with the same `DATABASE_URL`. Refresh the web page.

Expected:

- Existing chat session remains listed or can be loaded by the app.
- Messages remain in Postgres.
- `chat_session.session_id` and `chat_session.work_dir` remain non-empty after successful fake runner tasks.

- [ ] **Step 7: Verify Docker builds**

Run:

```bash
docker build -f Dockerfile.web .
docker build -f Dockerfile.runner .
```

Expected: both images build successfully.

- [ ] **Step 8: Commit only if smoke fixes were needed**

If source or docs changed during smoke fixes, run:

```bash
git add <changed-files>
git commit -m "fix: close chat readiness smoke gaps"
```

Expected: commit succeeds. If no files changed, skip this step.

## Self-Review

Spec coverage:

- Session-first semantics are covered by Tasks 1, 2, 3, and 5.
- Postgres persistence is covered by Task 2 and verified in Tasks 3 and 7.
- `session_id` and `work_dir` resume pointers are covered by Tasks 2, 3, 4, and 7.
- Fake runner session behavior is covered by Task 4.
- Codex first-turn and resume command support is covered by Task 4.
- Runtime-only API key handling and redaction are covered by Tasks 2, 3, 4, 5, and 7.
- UI chat/workbench behavior is covered by Task 5.
- Documentation and deployment readiness are covered by Task 6.

Decisions from open questions:

- `/api/tasks/:id` is not added. The primary v0.1.1 vocabulary remains `/api/agent-tasks/:id`; the first implementation returns task detail through session detail and can expand `/api/agent-tasks/:id` once the UI needs a standalone task view.
- Persistent runner volume is recommended for Codex resume. Fake mode and message persistence still work without it.
- The API supports multiple chat sessions immediately, while the UI starts with one active session and keeps the model simple.
- Cancellation remains outside v0.1.1.
- Redacted raw output is stored on `agent_tasks`; structured trace is stored in `task_message`.
- The Codex CLI command builder uses `codex exec resume <session_id>` as the planned mechanism. If the installed CLI differs, adjust only `apps/runner/src/codex-runner.ts` and its tests.

Placeholder scan:

- No placeholder text, incomplete task, or open implementation slot remains in this plan.
- Every code-changing task includes concrete code or exact replacement snippets.
- Every test task includes commands and expected outcomes.

Type consistency:

- Shared types use `chatSessionId`, `sessionId`, `workDir`, `resultMarkdown`, `rawOutputRedacted`, and `taskMessages` consistently across shared, API, runner, and web files.
- Persisted SQL names use snake_case table names from the spec: `chat_session`, `chat_message`, `agent_tasks`, and `task_message`.
- UI API client returns `ChatSession` and `ChatSessionDetail`, matching `packages/shared/src/chat.ts`.
