# Configurable Code Agent Builder Demo v0.1.2 E2B Sandbox Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local Codex spawn runner with an E2B sandbox runner while preserving the v0.1.1 chat product model and adding incremental task-event persistence.

**Architecture:** Keep Postgres as the product source of truth and E2B as the execution substrate. The API remains the owner of task persistence; the runner receives the active task id plus a runner-authenticated event endpoint and appends redacted task events while the blocking final response keeps the existing `RunnerAgentTaskResponse` shape. The E2B runner isolates SDK calls behind focused adapters so command construction, sandbox resolution, resume fallback, event parsing, redaction, and secret-residue checks are unit-testable without live E2B.

**Tech Stack:** TypeScript, Express, pg/pg-mem, Vitest, pnpm workspaces, `e2b` JavaScript SDK, Codex CLI inside an E2B custom template.

---

## Source Spec

Implement against:

- `docs/superpowers/specs/2026-06-24-configurable-code-agent-builder-demo-0.1.2-e2b-sandbox-runner.md`
- E2B SDK reference:
  - `https://e2b.dev/docs/sdk-reference/js-sdk/v1.9.0/sandbox`
  - `https://e2b.dev/docs/sdk-reference/js-sdk/v1.9.0/commands`

## File Structure

Create:

- `apps/api/src/runner-event-auth.ts` — shared API helper for validating the runner-only event token.
- `apps/runner/src/e2b-types.ts` — narrow interfaces around E2B `Sandbox`, command execution, and filesystem methods used by tests.
- `apps/runner/src/e2b-sandbox.ts` — E2B SDK adapter: create/connect/pause, read/write files, run commands.
- `apps/runner/src/e2b-command.ts` — pure Codex command string builder and shell argument quoting.
- `apps/runner/src/e2b-events.ts` — parse Codex JSONL output into redacted `RunnerTaskMessage` events and extract Codex `session_id`.
- `apps/runner/src/runner-events-client.ts` — runner-side client for posting incremental task events to the API.
- `apps/runner/src/e2b-runner.ts` — orchestrates sandbox resolution, prompt writing, command execution, fallback, final output, pause, and response.
- `docs/runner-e2b.md` — operator guide for E2B setup, template publish, env vars, smoke tests, lifecycle, and security boundary.
- `e2b.Dockerfile` — E2B template image with Node, pnpm, and Codex CLI.
- `e2b.toml` — E2B template config.

Modify:

- `packages/shared/src/chat.ts` — add runner-internal fields to `CreateAgentTaskRequest` and introduce `RunnerTaskEventRequest`.
- `packages/shared/src/__tests__/chat.test.ts` — contract tests for the new runner-internal fields.
- `apps/api/src/chat-store.ts` — add `appendRunnerTaskMessages` for incremental event persistence and pointer-pair update guard.
- `apps/api/src/__tests__/chat-store.test.ts` — store tests for ordered append, terminal rejection, redaction, and pointer-pair safety.
- `apps/api/src/index.ts` — pass `taskId` and event endpoint to runner; add internal runner event endpoint.
- `apps/api/src/__tests__/api.test.ts` — orchestrator tests for request shape and internal event endpoint.
- `apps/api/src/runner-client.ts` — no public surface change; accepts the expanded shared request.
- `apps/runner/package.json` — add `e2b`.
- `apps/runner/src/index.ts` — replace `codex` mode with `e2b`; validate E2B configuration.
- `apps/runner/src/__tests__/runner.test.ts` — replace local Codex runner tests with E2B unit tests.
- `package.json` — add E2B smoke helper scripts.

Do not modify:

- Web UI files for v0.1.2.
- Postgres migrations or schema.
- Archive lifecycle behavior.

## Task 1: Shared Runner Contract

**Files:**
- Modify: `packages/shared/src/chat.ts`
- Modify: `packages/shared/src/__tests__/chat.test.ts`

- [ ] **Step 1: Write the failing shared contract tests**

Append these tests to `packages/shared/src/__tests__/chat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CreateAgentTaskRequest, RunnerTaskEventRequest } from "../chat";
import { defaultAgentSpec } from "../agent-spec";

describe("runner chat contracts", () => {
  it("allows runner-internal event metadata on agent task requests", () => {
    const request = {
      chatSessionId: "chat-session-1",
      taskId: "task-1",
      message: "Research Acme.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      sessionId: null,
      workDir: null,
      runnerEvents: {
        endpoint: "http://localhost:4001/internal/runner/task-events",
        token: "runner-token"
      }
    } satisfies CreateAgentTaskRequest;

    expect(request.taskId).toBe("task-1");
    expect(request.runnerEvents?.endpoint).toContain("/internal/runner/task-events");
  });

  it("models incremental runner task event payloads", () => {
    const payload = {
      taskId: "task-1",
      messages: [
        {
          type: "status",
          tool: null,
          content: "E2B sandbox resumed",
          inputJson: null,
          output: null
        }
      ]
    } satisfies RunnerTaskEventRequest;

    expect(payload.messages[0].type).toBe("status");
  });
});
```

- [ ] **Step 2: Run the shared tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/shared test -- src/__tests__/chat.test.ts
```

Expected: FAIL with TypeScript errors that `taskId`, `runnerEvents`, or `RunnerTaskEventRequest` are not defined on the shared chat contract.

- [ ] **Step 3: Expand the shared contract**

Edit `packages/shared/src/chat.ts` so the relevant section reads:

```ts
export type RunnerEventsTarget = {
  endpoint: string;
  token: string;
};

export type CreateAgentTaskRequest = {
  chatSessionId: string;
  taskId?: string;
  message: string;
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
  sessionId: string | null;
  workDir: string | null;
  runnerEvents?: RunnerEventsTarget | null;
};

export type RunnerTaskMessage = Omit<TaskMessage, "id" | "taskId" | "seq" | "createdAt">;

export type RunnerTaskEventRequest = {
  taskId: string;
  secretValues?: string[];
  messages: RunnerTaskMessage[];
};
```

Keep `RunnerAgentTaskResponse` unchanged.

- [ ] **Step 4: Run the shared tests and verify they pass**

Run:

```bash
pnpm --filter @agent-builder/shared test -- src/__tests__/chat.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck shared**

Run:

```bash
pnpm --filter @agent-builder/shared typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/shared/src/chat.ts packages/shared/src/__tests__/chat.test.ts
git commit -m "feat: add runner event contract"
```

## Task 2: Chat Store Incremental Event Persistence

**Files:**
- Modify: `apps/api/src/chat-store.ts`
- Modify: `apps/api/src/__tests__/chat-store.test.ts`

- [ ] **Step 1: Write failing store tests for incremental append**

Append these tests to `apps/api/src/__tests__/chat-store.test.ts`:

```ts
it("appends runner task messages with ordered seq values", async () => {
  const session = await store.createChatSession({
    agentSpec: defaultAgentSpec,
    title: "Incremental events"
  });
  const trigger = await store.createChatMessage({
    chatSessionId: session.id,
    role: "user",
    contentMarkdown: "Run task.",
    taskId: null
  });
  const task = await store.createAgentTask({
    chatSessionId: session.id,
    triggerMessageId: trigger.id,
    agentSpec: defaultAgentSpec
  });
  await store.markAgentTaskRunning(task.id);

  await store.appendRunnerTaskMessages(task.id, [
    { type: "status", tool: null, content: "first", inputJson: null, output: null },
    { type: "text", tool: null, content: "second", inputJson: null, output: null }
  ]);
  await store.appendRunnerTaskMessages(task.id, [
    { type: "log", tool: "codex", content: "third", inputJson: { secret: "sk-test" }, output: "output sk-test" }
  ], ["sk-test"]);

  const detail = await store.getChatSessionDetail(session.id);

  expect(detail?.taskMessages.map((message) => [message.seq, message.content])).toEqual([
    [0, "first"],
    [1, "second"],
    [2, "third"]
  ]);
  expect(JSON.stringify(detail?.taskMessages)).not.toContain("sk-test");
});

it("rejects incremental runner messages for terminal tasks", async () => {
  const session = await store.createChatSession({
    agentSpec: defaultAgentSpec,
    title: "Terminal event rejection"
  });
  const trigger = await store.createChatMessage({
    chatSessionId: session.id,
    role: "user",
    contentMarkdown: "Run task.",
    taskId: null
  });
  const task = await store.createAgentTask({
    chatSessionId: session.id,
    triggerMessageId: trigger.id,
    agentSpec: defaultAgentSpec
  });
  await store.markAgentTaskRunning(task.id);
  await store.failAgentTask(task.id, {
    status: "failed",
    error: "failed",
    rawOutputRedacted: "",
    sessionId: null,
    workDir: null,
    taskMessages: []
  });

  await expect(
    store.appendRunnerTaskMessages(task.id, [
      { type: "status", tool: null, content: "too late", inputJson: null, output: null }
    ])
  ).rejects.toThrow("Cannot append task messages to terminal task");
});
```

- [ ] **Step 2: Run the store tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
```

Expected: FAIL because `appendRunnerTaskMessages` is not defined.

- [ ] **Step 3: Add store input type and method**

In `apps/api/src/chat-store.ts`, add this type near the existing task input types:

```ts
type AppendRunnerTaskMessagesInput = {
  messages: RunnerTaskMessage[];
  secretValues?: string[];
};
```

Then add this public method inside `PgChatStore`, before `completeAgentTask`:

```ts
  async appendRunnerTaskMessages(
    taskId: string,
    messages: RunnerTaskMessage[],
    secretValues: string[] = []
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const task = await getTaskById(client, taskId);
      if (!task) {
        throw new Error(`Agent task not found: ${taskId}`);
      }
      if (terminalTaskStatuses.has(task.status)) {
        throw new Error(`Cannot append task messages to terminal task: ${taskId}`);
      }

      const nextSeqResult = await client.query<{ next_seq: number }>(
        `
          select coalesce(max(seq) + 1, 0) as next_seq
          from task_message
          where task_id = $1
        `,
        [taskId]
      );
      const startSeq = Number(nextSeqResult.rows[0]?.next_seq ?? 0);
      const redactedMessages = messages.map((message) => ({
        ...message,
        content: redactSecrets(message.content, secretValues),
        inputJson: redactUnknownJson(message.inputJson, secretValues),
        output: message.output ? redactSecrets(message.output, secretValues) : null
      }));

      for (const [index, message] of redactedMessages.entries()) {
        await client.query(
          `
            insert into task_message (id, task_id, seq, type, tool, content, input_json, output)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            nanoid(),
            taskId,
            startSeq + index,
            message.type,
            message.tool,
            message.content,
            message.inputJson,
            message.output
          ]
        );
      }
      await this.touchChatSession(task.chat_session_id);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
```

Remove the unused `AppendRunnerTaskMessagesInput` type if TypeScript flags it as unused; the method signature above is the source of truth.

- [ ] **Step 4: Run the store tests**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck API**

Run:

```bash
pnpm --filter @agent-builder/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/api/src/chat-store.ts apps/api/src/__tests__/chat-store.test.ts
git commit -m "feat: append runner task events incrementally"
```

## Task 3: Internal Runner Event Endpoint

**Files:**
- Create: `apps/api/src/runner-event-auth.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/__tests__/api.test.ts`

- [ ] **Step 1: Write failing API tests for runner event ingest**

Append these tests to `apps/api/src/__tests__/api.test.ts`:

```ts
it("passes task id and runner event target to the runner", async () => {
  process.env.RUNNER_EVENT_TOKEN = "runner-token";
  process.env.API_PUBLIC_BASE_URL = "http://api.internal:4001";
  const runAgentTask = vi.fn().mockResolvedValue({
    status: "completed",
    finalMarkdown: "Done",
    rawOutputRedacted: "",
    sessionId: "runner-session-1",
    workDir: "sandbox-1",
    taskMessages: []
  } satisfies RunnerAgentTaskResponse);
  const app = createApiApp({ chatStore: store, runAgentTask });

  const sessionResponse = await request(app)
    .post("/api/chat-sessions")
    .send({ agentSpec: defaultAgentSpec, title: "Runner event target" })
    .expect(201);

  await request(app)
    .post(`/api/chat-sessions/${sessionResponse.body.id}/messages`)
    .send({
      agentSpec: defaultAgentSpec,
      message: "Run with events.",
      runtimeSecrets: { apiKey: "sk-test" }
    })
    .expect(201);

  expect(runAgentTask).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: expect.any(String),
      runnerEvents: {
        endpoint: "http://api.internal:4001/internal/runner/task-events",
        token: "runner-token"
      }
    })
  );
});

it("authenticates and persists internal runner task events", async () => {
  process.env.RUNNER_EVENT_TOKEN = "runner-token";
  const app = createApiApp({ chatStore: store });
  const session = await store.createChatSession({
    agentSpec: defaultAgentSpec,
    title: "Internal event ingest"
  });
  const trigger = await store.createChatMessage({
    chatSessionId: session.id,
    role: "user",
    contentMarkdown: "Run task.",
    taskId: null
  });
  const task = await store.createAgentTask({
    chatSessionId: session.id,
    triggerMessageId: trigger.id,
    agentSpec: defaultAgentSpec
  });
  await store.markAgentTaskRunning(task.id);

  await request(app)
    .post("/internal/runner/task-events")
    .set("authorization", "Bearer runner-token")
    .send({
      taskId: task.id,
      secretValues: ["sk-test"],
      messages: [{ type: "status", tool: null, content: "streamed sk-test", inputJson: null, output: null }]
    })
    .expect(202);

  await request(app)
    .post("/internal/runner/task-events")
    .set("authorization", "Bearer wrong-token")
    .send({
      taskId: task.id,
      messages: [{ type: "status", tool: null, content: "rejected", inputJson: null, output: null }]
    })
    .expect(401);

  const detail = await store.getChatSessionDetail(session.id);
  expect(detail?.taskMessages).toHaveLength(1);
  expect(detail?.taskMessages[0].content).toBe("streamed [REDACTED]");
});
```

- [ ] **Step 2: Run the API tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/api.test.ts
```

Expected: FAIL because the internal route does not exist and runner requests do not include `taskId` / `runnerEvents`.

- [ ] **Step 3: Add runner event auth helper**

Create `apps/api/src/runner-event-auth.ts`:

```ts
import type { Request } from "express";

export function getRunnerEventToken(): string | null {
  const token = process.env.RUNNER_EVENT_TOKEN?.trim();
  return token ? token : null;
}

export function requireRunnerEventAuth(req: Request): boolean {
  const expected = getRunnerEventToken();
  if (!expected) {
    return false;
  }
  const header = req.header("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

export function runnerEventEndpoint(): string {
  const baseUrl = process.env.API_PUBLIC_BASE_URL?.trim() || "http://localhost:4001";
  return `${baseUrl.replace(/\/$/, "")}/internal/runner/task-events`;
}
```

- [ ] **Step 4: Wire request metadata and internal endpoint**

In `apps/api/src/index.ts`, import:

```ts
import type { RunnerTaskEventRequest } from "@agent-builder/shared";
import { getRunnerEventToken, requireRunnerEventAuth, runnerEventEndpoint } from "./runner-event-auth";
```

Change the `runnerClient.runAgentTask` call in `POST /api/chat-sessions/:id/messages` to include:

```ts
        taskId: task.id,
        runnerEvents: getRunnerEventToken()
          ? {
              endpoint: runnerEventEndpoint(),
              token: getRunnerEventToken()!
            }
          : null,
```

Add this route before `return app;`:

```ts
  app.post("/internal/runner/task-events", async (req, res) => {
    if (!requireRunnerEventAuth(req)) {
      res.status(401).json(stableError("Unauthorized runner event request"));
      return;
    }

    const body = req.body as RunnerTaskEventRequest;
    if (!body.taskId?.trim() || !Array.isArray(body.messages)) {
      res.status(400).json(stableError("taskId and messages are required"));
      return;
    }

    try {
      await chatStore.appendRunnerTaskMessages(body.taskId, body.messages, body.secretValues ?? []);
      res.status(202).json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to append runner task events";
      res.status(message.includes("terminal task") ? 409 : 404).json(stableError(message));
    }
  });
```

- [ ] **Step 5: Run API tests**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run shared and API typechecks**

Run:

```bash
pnpm --filter @agent-builder/shared typecheck
pnpm --filter @agent-builder/api typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/shared/src/chat.ts apps/api/src/runner-event-auth.ts apps/api/src/index.ts apps/api/src/__tests__/api.test.ts
git commit -m "feat: ingest runner task events"
```

## Task 4: Runner Event Client

**Files:**
- Create: `apps/runner/src/runner-events-client.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing runner event client tests**

Append these tests to `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { createRunnerEventEmitter } from "../runner-events-client";

it("posts redacted incremental task events when runnerEvents is configured", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const emitEvent = createRunnerEventEmitter({
    taskId: "task-1",
    runnerEvents: {
      endpoint: "http://api.internal/internal/runner/task-events",
      token: "runner-token"
    },
    secretValues: ["sk-test"],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
  });

  await emitEvent({ type: "status", tool: null, content: "started sk-test", inputJson: null, output: null });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://api.internal/internal/runner/task-events");
  expect(calls[0].init.headers).toEqual({
    authorization: "Bearer runner-token",
    "content-type": "application/json"
  });
  expect(String(calls[0].init.body)).not.toContain("sk-test");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    taskId: "task-1",
    secretValues: ["sk-test"],
    messages: [{ type: "status", tool: null, content: "started [REDACTED]", inputJson: null, output: null }]
  });
});

it("no-ops incremental task events without runnerEvents or taskId", async () => {
  const emitEvent = createRunnerEventEmitter({
    taskId: undefined,
    runnerEvents: null,
    secretValues: ["sk-test"],
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });

  await expect(
    emitEvent({ type: "status", tool: null, content: "local only", inputJson: null, output: null })
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run runner tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: FAIL because `runner-events-client` does not exist.

- [ ] **Step 3: Implement runner event client**

Create `apps/runner/src/runner-events-client.ts`:

```ts
import type { RunnerEventsTarget, RunnerTaskMessage } from "@agent-builder/shared";
import { redactRunnerOutput } from "./redaction";

export type RunnerEventEmitter = (message: RunnerTaskMessage) => Promise<void>;

type FetchLike = typeof fetch;

export function createRunnerEventEmitter(input: {
  taskId?: string;
  runnerEvents?: RunnerEventsTarget | null;
  secretValues: string[];
  fetchImpl?: FetchLike;
}): RunnerEventEmitter {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (message) => {
    if (!input.taskId || !input.runnerEvents) {
      return;
    }

    const redactedMessage: RunnerTaskMessage = {
      ...message,
      content: redactRunnerOutput(message.content, input.secretValues),
      output: message.output ? redactRunnerOutput(message.output, input.secretValues) : null
    };

    const response = await fetchImpl(input.runnerEvents.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.runnerEvents.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        taskId: input.taskId,
        secretValues: input.secretValues,
        messages: [redactedMessage]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Runner event append failed with ${response.status}: ${body}`);
    }
  };
}
```

- [ ] **Step 4: Run runner tests**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck runner**

Run:

```bash
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/runner/src/runner-events-client.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: post incremental runner events"
```

## Task 5: E2B Command and Event Parsing Units

**Files:**
- Create: `apps/runner/src/e2b-command.ts`
- Create: `apps/runner/src/e2b-events.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing tests for command building and JSONL parsing**

Append these tests to `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { buildCodexCommand } from "../e2b-command";
import { parseCodexJsonLine, extractSessionIdFromCodexEvent } from "../e2b-events";

it("builds first-turn E2B Codex command without leaking secrets in args", () => {
  const command = buildCodexCommand({
    modelName: "gpt-5",
    workspacePath: "/home/user/workspace",
    finalPath: "/home/user/workspace/final.md",
    promptPath: "/home/user/workspace/prompt.md",
    sessionId: null
  });

  expect(command).toContain("codex --search --ask-for-approval never exec --json");
  expect(command).toContain("--model 'gpt-5'");
  expect(command).toContain("--output-last-message '/home/user/workspace/final.md'");
  expect(command).toContain("-C '/home/user/workspace'");
  expect(command).toContain("$(cat '/home/user/workspace/prompt.md')");
  expect(command).not.toContain("sk-test");
});

it("builds resumed E2B Codex command", () => {
  const command = buildCodexCommand({
    modelName: "gpt-5",
    workspacePath: "/home/user/workspace",
    finalPath: "/home/user/workspace/final.md",
    promptPath: "/home/user/workspace/prompt.md",
    sessionId: "codex-session-1"
  });

  expect(command).toContain("exec resume 'codex-session-1' --json");
});

it("parses Codex JSONL events into runner task messages", () => {
  expect(parseCodexJsonLine(JSON.stringify({ type: "session", session_id: "codex-session-1" }))).toEqual({
    message: { type: "status", tool: "codex", content: "Codex session established", inputJson: null, output: null },
    sessionId: "codex-session-1"
  });
  expect(parseCodexJsonLine(JSON.stringify({ type: "tool_call", tool: "web_search", arguments: { q: "Acme" } }))).toEqual({
    message: { type: "tool_use", tool: "web_search", content: "Tool call: web_search", inputJson: { q: "Acme" }, output: null },
    sessionId: null
  });
  expect(parseCodexJsonLine("not json")).toEqual({
    message: { type: "log", tool: "codex", content: "not json", inputJson: null, output: null },
    sessionId: null
  });
});

it("extracts session ids from known Codex event variants", () => {
  expect(extractSessionIdFromCodexEvent({ session_id: "snake" })).toBe("snake");
  expect(extractSessionIdFromCodexEvent({ sessionId: "camel" })).toBe("camel");
  expect(extractSessionIdFromCodexEvent({ type: "other" })).toBeNull();
});
```

- [ ] **Step 2: Run runner tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: FAIL because `e2b-command` and `e2b-events` do not exist.

- [ ] **Step 3: Implement command builder**

Create `apps/runner/src/e2b-command.ts`:

```ts
export type E2BCodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  promptPath: string;
  sessionId: string | null;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildCodexCommand(input: E2BCodexCommandInput): string {
  const execArgs = input.sessionId ? `exec resume ${shellQuote(input.sessionId)}` : "exec";
  return [
    "codex",
    "--search",
    "--ask-for-approval",
    "never",
    execArgs,
    "--json",
    "--model",
    shellQuote(input.modelName),
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--output-last-message",
    shellQuote(input.finalPath),
    "-C",
    shellQuote(input.workspacePath),
    `"$(cat ${shellQuote(input.promptPath)})"`
  ].join(" ");
}
```

- [ ] **Step 4: Implement event parser**

Create `apps/runner/src/e2b-events.ts`:

```ts
import type { RunnerTaskMessage } from "@agent-builder/shared";

export type ParsedCodexEvent = {
  message: RunnerTaskMessage;
  sessionId: string | null;
};

export function extractSessionIdFromCodexEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as Record<string, unknown>;
  const value = record.session_id ?? record.sessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseCodexJsonLine(line: string): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const sessionId = extractSessionIdFromCodexEvent(event);
    if (sessionId) {
      return {
        sessionId,
        message: { type: "status", tool: "codex", content: "Codex session established", inputJson: null, output: null }
      };
    }
    if (event.type === "tool_call") {
      const tool = typeof event.tool === "string" ? event.tool : "tool";
      return {
        sessionId: null,
        message: {
          type: "tool_use",
          tool,
          content: `Tool call: ${tool}`,
          inputJson: event.arguments ?? null,
          output: null
        }
      };
    }
    if (event.type === "tool_result") {
      const tool = typeof event.tool === "string" ? event.tool : "tool";
      return {
        sessionId: null,
        message: {
          type: "tool_result",
          tool,
          content: `Tool result: ${tool}`,
          inputJson: null,
          output: typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? null)
        }
      };
    }
    return {
      sessionId: null,
      message: { type: "log", tool: "codex", content: line, inputJson: event, output: null }
    };
  } catch {
    return {
      sessionId: null,
      message: { type: "log", tool: "codex", content: line, inputJson: null, output: null }
    };
  }
}
```

- [ ] **Step 5: Run runner tests**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck runner**

Run:

```bash
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/runner/src/e2b-command.ts apps/runner/src/e2b-events.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: add E2B Codex command units"
```

## Task 6: E2B Sandbox Adapter and Resume Resolution

**Files:**
- Create: `apps/runner/src/e2b-types.ts`
- Create: `apps/runner/src/e2b-sandbox.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`
- Modify: `apps/runner/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the E2B SDK dependency**

Run:

```bash
pnpm add e2b --filter @agent-builder/runner
```

Expected: `apps/runner/package.json` includes `"e2b"` in dependencies and `pnpm-lock.yaml` changes.

- [ ] **Step 2: Write failing sandbox resolution tests**

Append these tests to `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { createE2BSandboxFactory, resolveSandbox } from "../e2b-sandbox";
import type { E2BSandboxLike } from "../e2b-types";

function fakeSandbox(id: string): E2BSandboxLike {
  return {
    sandboxId: id,
    commands: {
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 })
    },
    files: {
      write: async () => undefined,
      read: async () => "# Done"
    },
    pause: async () => undefined,
    kill: async () => undefined
  };
}

it("creates a new E2B sandbox when workDir is missing", async () => {
  const created: string[] = [];
  const factory = {
    create: async (templateId: string) => {
      created.push(templateId);
      return fakeSandbox("sandbox-new");
    },
    connect: async () => {
      throw new Error("connect should not be called");
    }
  };

  const result = await resolveSandbox({ workDir: null, templateId: "template-1", factory });

  expect(result.kind).toBe("created");
  expect(result.sandbox.sandboxId).toBe("sandbox-new");
  expect(created).toEqual(["template-1"]);
});

it("resumes an existing E2B sandbox when workDir is present", async () => {
  const connected: string[] = [];
  const factory = {
    create: async () => {
      throw new Error("create should not be called");
    },
    connect: async (sandboxId: string) => {
      connected.push(sandboxId);
      return fakeSandbox(sandboxId);
    }
  };

  const result = await resolveSandbox({ workDir: "sandbox-existing", templateId: "template-1", factory });

  expect(result.kind).toBe("resumed");
  expect(result.sandbox.sandboxId).toBe("sandbox-existing");
  expect(connected).toEqual(["sandbox-existing"]);
});

it("creates a fresh sandbox when resume fails", async () => {
  const factory = {
    create: async () => fakeSandbox("sandbox-fresh"),
    connect: async () => {
      throw new Error("sandbox not found");
    }
  };

  const result = await resolveSandbox({ workDir: "sandbox-lost", templateId: "template-1", factory });

  expect(result.kind).toBe("workspace_lost");
  expect(result.sandbox.sandboxId).toBe("sandbox-fresh");
  expect(result.resumeError?.message).toContain("sandbox not found");
});
```

- [ ] **Step 3: Run runner tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: FAIL because E2B sandbox files do not exist.

- [ ] **Step 4: Add narrow E2B interfaces**

Create `apps/runner/src/e2b-types.ts`:

```ts
export type E2BCommandResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type E2BSandboxLike = {
  sandboxId: string;
  commands: {
    run: (
      command: string,
      opts?: {
        cwd?: string;
        timeoutMs?: number;
        envs?: Record<string, string>;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
      }
    ) => Promise<E2BCommandResult>;
  };
  files: {
    write: (path: string, data: string) => Promise<void>;
    read: (path: string) => Promise<string>;
  };
  pause: () => Promise<void>;
  kill: () => Promise<void>;
};

export type E2BSandboxFactory = {
  create: (templateId: string) => Promise<E2BSandboxLike>;
  connect: (sandboxId: string) => Promise<E2BSandboxLike>;
};
```

- [ ] **Step 5: Implement SDK adapter and resolver**

Create `apps/runner/src/e2b-sandbox.ts`:

```ts
import { Sandbox } from "e2b";
import type { E2BSandboxFactory, E2BSandboxLike } from "./e2b-types";

export type ResolvedSandbox =
  | { kind: "created"; sandbox: E2BSandboxLike; resumeError: null }
  | { kind: "resumed"; sandbox: E2BSandboxLike; resumeError: null }
  | { kind: "workspace_lost"; sandbox: E2BSandboxLike; resumeError: Error };

export function createE2BSandboxFactory(input: { apiKey: string }): E2BSandboxFactory {
  return {
    async create(templateId) {
      return Sandbox.create(templateId, { apiKey: input.apiKey }) as Promise<E2BSandboxLike>;
    },
    async connect(sandboxId) {
      return Sandbox.connect(sandboxId, { apiKey: input.apiKey }) as Promise<E2BSandboxLike>;
    }
  };
}

export async function resolveSandbox(input: {
  workDir: string | null;
  templateId: string;
  factory: E2BSandboxFactory;
}): Promise<ResolvedSandbox> {
  if (!input.workDir) {
    return { kind: "created", sandbox: await input.factory.create(input.templateId), resumeError: null };
  }

  try {
    return { kind: "resumed", sandbox: await input.factory.connect(input.workDir), resumeError: null };
  } catch (error) {
    const resumeError = error instanceof Error ? error : new Error("Sandbox resume failed");
    return {
      kind: "workspace_lost",
      sandbox: await input.factory.create(input.templateId),
      resumeError
    };
  }
}
```

- [ ] **Step 6: Run runner tests**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck runner**

Run:

```bash
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/runner/package.json pnpm-lock.yaml apps/runner/src/e2b-types.ts apps/runner/src/e2b-sandbox.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: resolve E2B sandboxes"
```

## Task 7: E2B Runner Orchestration

**Files:**
- Create: `apps/runner/src/e2b-runner.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing runner orchestration tests**

Append these tests to `apps/runner/src/__tests__/runner.test.ts`:

```ts
import { runE2BAgentTask } from "../e2b-runner";

it("runs a first-turn E2B task with command-scoped model envs and pauses the sandbox", async () => {
  const emitted: string[] = [];
  const sandbox = fakeSandbox("sandbox-1");
  const runCalls: Array<{ command: string; opts: any }> = [];
  sandbox.commands.run = async (command, opts) => {
    runCalls.push({ command, opts });
    await opts?.onStdout?.(JSON.stringify({ session_id: "codex-session-1" }) + "\n");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  sandbox.files.read = async (path) => {
    expect(path).toBe("/home/user/workspace/final.md");
    return "# Final answer";
  };
  sandbox.pause = async () => {
    emitted.push("paused");
  };

  const result = await runE2BAgentTask(
    {
      chatSessionId: "chat-session-1",
      taskId: "task-1",
      message: "Research Acme.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      sessionId: null,
      workDir: null,
      runnerEvents: null
    },
    {
      timeoutMs: 120000,
      templateId: "template-1",
      factory: {
        create: async () => sandbox,
        connect: async () => {
          throw new Error("connect should not run");
        }
      },
      emitEvent: async (event) => {
        emitted.push(event.content);
      }
    }
  );

  expect(result.status).toBe("completed");
  expect(result.finalMarkdown).toBe("# Final answer");
  expect(result.sessionId).toBe("codex-session-1");
  expect(result.workDir).toBe("sandbox-1");
  expect(runCalls[0].opts.envs).toEqual({
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: defaultAgentSpec.model.apiEndpoint
  });
  expect(runCalls[0].opts.envs).not.toHaveProperty("E2B_API_KEY");
  expect(emitted).toContain("Codex session established");
  expect(emitted).toContain("paused");
});

it("resets session pointer when workspace loss creates a fresh sandbox", async () => {
  const sandbox = fakeSandbox("sandbox-fresh");
  sandbox.commands.run = async (_command, opts) => {
    await opts?.onStdout?.(JSON.stringify({ session_id: "codex-session-fresh" }) + "\n");
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const result = await runE2BAgentTask(
    {
      chatSessionId: "chat-session-1",
      taskId: "task-1",
      message: "Continue.",
      agentSpec: defaultAgentSpec,
      runtimeSecrets: { apiKey: "sk-test" },
      sessionId: "codex-session-old",
      workDir: "sandbox-lost",
      runnerEvents: null
    },
    {
      timeoutMs: 120000,
      templateId: "template-1",
      factory: {
        create: async () => sandbox,
        connect: async () => {
          throw new Error("sandbox not found");
        }
      },
      emitEvent: async () => undefined
    }
  );

  expect(result.sessionId).toBe("codex-session-fresh");
  expect(result.workDir).toBe("sandbox-fresh");
  expect(JSON.stringify(result)).not.toContain("codex-session-old");
});
```

- [ ] **Step 2: Run runner tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: FAIL because `e2b-runner` does not exist.

- [ ] **Step 3: Implement E2B runner**

Create `apps/runner/src/e2b-runner.ts`:

```ts
import { createStatusTaskMessage, materializeChatPrompt, type CreateAgentTaskRequest, type RunnerAgentTaskResponse, type RunnerTaskMessage } from "@agent-builder/shared";
import { buildCodexCommand } from "./e2b-command";
import { parseCodexJsonLine } from "./e2b-events";
import { createE2BSandboxFactory, resolveSandbox } from "./e2b-sandbox";
import type { E2BSandboxFactory } from "./e2b-types";
import { redactRunnerOutput } from "./redaction";
import { createRunnerEventEmitter, type RunnerEventEmitter } from "./runner-events-client";

export type RunE2BAgentTaskOptions = {
  timeoutMs: number;
  templateId?: string;
  factory?: E2BSandboxFactory;
  emitEvent?: RunnerEventEmitter;
};

const WORKSPACE_PATH = "/home/user/workspace";
const PROMPT_PATH = `${WORKSPACE_PATH}/prompt.md`;
const FINAL_PATH = `${WORKSPACE_PATH}/final.md`;

function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function runE2BAgentTask(
  request: CreateAgentTaskRequest,
  options?: RunE2BAgentTaskOptions
): Promise<RunnerAgentTaskResponse> {
  const templateId = options?.templateId ?? process.env.E2B_TEMPLATE_ID?.trim();
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (!templateId) {
    throw new Error("E2B_TEMPLATE_ID is required for RUNNER_MODE=e2b");
  }
  const factory = options?.factory ?? createE2BSandboxFactory({ apiKey: e2bApiKey ?? "" });
  if (!options?.factory && !e2bApiKey) {
    throw new Error("E2B_API_KEY is required for RUNNER_MODE=e2b");
  }

  const resolved = await resolveSandbox({ workDir: request.workDir, templateId, factory });
  const secretValues = [request.runtimeSecrets.apiKey].filter(Boolean);
  const localEvents: RunnerTaskMessage[] = [];
  const emitEvent = options?.emitEvent ?? createRunnerEventEmitter({
    taskId: request.taskId,
    runnerEvents: request.runnerEvents,
    secretValues
  });
  const recordEvent = async (event: RunnerTaskMessage) => {
    const redactedEvent = {
      ...event,
      content: redactRunnerOutput(event.content, secretValues),
      output: event.output ? redactRunnerOutput(event.output, secretValues) : null
    };
    localEvents.push(redactedEvent);
    await emitEvent(redactedEvent);
  };

  if (resolved.kind === "workspace_lost") {
    await recordEvent({
      type: "error",
      tool: "e2b",
      content: `Workspace lost: ${resolved.resumeError.message}. Starting fresh sandbox.`,
      inputJson: null,
      output: null
    });
  }

  const effectiveSessionId = resolved.kind === "workspace_lost" ? null : request.sessionId;
  const prompt = materializeChatPrompt({
    agentSpec: request.agentSpec,
    message: request.message,
    isResume: Boolean(effectiveSessionId)
  });
  await resolved.sandbox.files.write(PROMPT_PATH, prompt);

  const command = buildCodexCommand({
    modelName: request.agentSpec.model.name,
    workspacePath: WORKSPACE_PATH,
    finalPath: FINAL_PATH,
    promptPath: PROMPT_PATH,
    sessionId: effectiveSessionId
  });
  const rawChunks: string[] = [];
  let sessionId: string | null = null;

  await recordEvent(createStatusTaskMessage(effectiveSessionId ? "Resuming Codex session in E2B" : "Starting Codex session in E2B"));
  const result = await resolved.sandbox.commands.run(command, {
    cwd: WORKSPACE_PATH,
    timeoutMs: options?.timeoutMs ?? 120000,
    envs: {
      OPENAI_API_KEY: request.runtimeSecrets.apiKey,
      OPENAI_BASE_URL: request.agentSpec.model.apiEndpoint
    },
    onStdout: async (data) => {
      rawChunks.push(data);
      for (const line of splitLines(data)) {
        const parsed = parseCodexJsonLine(line);
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        await recordEvent(parsed.message);
      }
    },
    onStderr: async (data) => {
      rawChunks.push(data);
      for (const line of splitLines(data)) {
        await recordEvent({ type: "log", tool: "codex", content: line, inputJson: null, output: null });
      }
    }
  });

  if (result.exitCode && result.exitCode !== 0) {
    throw new Error(`Codex exited with code ${result.exitCode}`);
  }

  const finalMarkdown = await resolved.sandbox.files.read(FINAL_PATH).catch(() => "");
  if (!finalMarkdown.trim()) {
    throw new Error("Codex completed without final Markdown output");
  }

  await recordEvent(createStatusTaskMessage("Task completed"));
  await resolved.sandbox.pause();

  return {
    status: "completed",
    finalMarkdown: redactRunnerOutput(finalMarkdown, secretValues),
    rawOutputRedacted: redactRunnerOutput(rawChunks.join(""), secretValues),
    taskMessages: localEvents,
    sessionId: sessionId ?? effectiveSessionId,
    workDir: resolved.sandbox.sandboxId
  };
}
```

- [ ] **Step 4: Run runner tests**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck runner**

Run:

```bash
pnpm --filter @agent-builder/runner typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/runner/src/e2b-runner.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: run Codex in E2B"
```

## Task 8: Runner Entrypoint Mode Switch

**Files:**
- Modify: `apps/runner/src/index.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Write failing entrypoint expectations**

Add this test to `apps/runner/src/__tests__/runner.test.ts`:

```ts
it("keeps fake runner deterministic after runner contract expansion", async () => {
  const result = await runFakeAgentTask({
    chatSessionId: "chat-session-1",
    taskId: "task-1",
    agentSpec: defaultAgentSpec,
    runtimeSecrets: { apiKey: "sk-test" },
    message: "Research Acme Corp.",
    sessionId: null,
    workDir: null,
    runnerEvents: null
  });

  expect(result.status).toBe("completed");
  expect(result.sessionId).toBe("fake-session-chat-session-1");
  expect(JSON.stringify(result)).not.toContain("sk-test");
});
```

- [ ] **Step 2: Run runner tests**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
```

Expected: PASS. If it fails, update `runFakeAgentTask` to ignore the new optional `taskId` and `runnerEvents` fields.

- [ ] **Step 3: Replace local codex mode with e2b mode**

Edit `apps/runner/src/index.ts`:

```ts
import cors from "cors";
import express from "express";
import { validateAgentSpec, type CreateAgentTaskRequest } from "@agent-builder/shared";
import { runE2BAgentTask } from "./e2b-runner";
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
      runnerMode === "e2b"
        ? await runE2BAgentTask(request, { timeoutMs, templateId: process.env.E2B_TEMPLATE_ID })
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

- [ ] **Step 4: Remove local Codex import from runner entrypoint**

Delete:

```ts
import { runCodexAgentTask } from "./codex-runner";
```

Do not delete `apps/runner/src/codex-runner.ts` in this task; removal happens after tests no longer import it.

- [ ] **Step 5: Run runner tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
pnpm --filter @agent-builder/runner typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/runner/src/index.ts apps/runner/src/e2b-runner.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "feat: switch runner mode to e2b"
```

## Task 9: Pointer-Pair Safety in API Completion

**Files:**
- Modify: `apps/api/src/chat-store.ts`
- Modify: `apps/api/src/__tests__/chat-store.test.ts`

- [ ] **Step 1: Write failing pointer-pair safety test**

Append this test to `apps/api/src/__tests__/chat-store.test.ts`:

```ts
it("does not persist a fresh sandbox id with an old Codex session id after workspace loss", async () => {
  const session = await store.createChatSession({
    agentSpec: defaultAgentSpec,
    title: "Pointer safety"
  });
  await store.updateChatSessionResumePointers(session.id, {
    sessionId: "codex-session-old",
    workDir: "sandbox-old"
  });
  const trigger = await store.createChatMessage({
    chatSessionId: session.id,
    role: "user",
    contentMarkdown: "Continue.",
    taskId: null
  });
  const task = await store.createAgentTask({
    chatSessionId: session.id,
    triggerMessageId: trigger.id,
    agentSpec: defaultAgentSpec
  });
  await store.markAgentTaskRunning(task.id);

  await store.completeAgentTask(task.id, {
    status: "completed",
    resultMarkdown: "Recovered without a new session id",
    rawOutputRedacted: "workspace lost",
    sessionId: null,
    workDir: "sandbox-fresh",
    taskMessages: [{ type: "error", tool: "e2b", content: "Workspace lost", inputJson: null, output: null }]
  });

  const detail = await store.getChatSessionDetail(session.id);
  expect(detail?.sessionId).toBe("codex-session-old");
  expect(detail?.workDir).toBe("sandbox-old");
});
```

- [ ] **Step 2: Run store tests and verify they fail**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
```

Expected: FAIL because current `coalesce($3, work_dir)` persists the fresh `workDir` even when `sessionId` is null.

- [ ] **Step 3: Add pointer-pair helper**

In `apps/api/src/chat-store.ts`, add near helper functions:

```ts
function shouldUpdateResumePointerPair(input: { sessionId: string | null; workDir: string | null }): boolean {
  return Boolean(input.sessionId?.trim() && input.workDir?.trim());
}
```

Replace session pointer updates in `completeAgentTask`, `failAgentTask`, and `updateChatSessionResumePointers` so `chat_session` only receives a new pair when both values exist:

```ts
const shouldUpdatePointers = shouldUpdateResumePointerPair({
  sessionId: input.sessionId,
  workDir: input.workDir
});

await client.query(
  `
    update chat_session
    set session_id = case when $2 then $3 else session_id end,
        work_dir = case when $2 then $4 else work_dir end,
        updated_at = now()
    where id = $1
  `,
  [taskRow.chat_session_id, shouldUpdatePointers, input.sessionId, input.workDir]
);
```

Keep task-level metadata updates as they are; task rows may record partial values for debugging, but `chat_session` must not mix old and fresh pointers.

For `updateChatSessionResumePointers`, use:

```ts
const shouldUpdatePointers = shouldUpdateResumePointerPair(input);
if (!shouldUpdatePointers) {
  return;
}
await this.pool.query(
  `
    update chat_session
    set session_id = $2,
        work_dir = $3,
        updated_at = now()
    where id = $1
  `,
  [id, input.sessionId, input.workDir]
);
```

- [ ] **Step 4: Run store tests**

Run:

```bash
pnpm --filter @agent-builder/api test -- src/__tests__/chat-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck API**

Run:

```bash
pnpm --filter @agent-builder/api typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/api/src/chat-store.ts apps/api/src/__tests__/chat-store.test.ts
git commit -m "fix: keep resume pointers paired"
```

## Task 10: E2B Template and Operator Documentation

**Files:**
- Create: `e2b.Dockerfile`
- Create: `e2b.toml`
- Create: `docs/runner-e2b.md`
- Modify: `package.json`

- [ ] **Step 1: Create the E2B Dockerfile**

Create `e2b.Dockerfile`:

```Dockerfile
FROM node:22-bookworm

RUN corepack enable
RUN npm install -g @openai/codex@0.50.0

WORKDIR /home/user/workspace
RUN chown -R node:node /home/user
USER node

RUN mkdir -p /home/user/workspace
```

- [ ] **Step 2: Create the E2B template config**

Create `e2b.toml`:

```toml
template_id = "agent-builder-codex-runner"
dockerfile = "e2b.Dockerfile"
```

- [ ] **Step 3: Add smoke scripts**

In root `package.json`, add these scripts after `smoke:chat`:

```json
"smoke:e2b:health": "RUNNER_MODE=e2b pnpm --filter @agent-builder/runner start",
"smoke:e2b:chat": "curl -sS -X POST http://localhost:4001/api/chat-sessions -H 'content-type: application/json' -d '{\"agentSpec\":{\"version\":\"0.1\",\"identity\":{\"name\":\"Research Agent\",\"description\":\"Research companies and summarize findings.\"},\"model\":{\"provider\":\"openai-compatible\",\"name\":\"gpt-5\",\"apiEndpoint\":\"https://api.openai.com/v1\"},\"systemPrompt\":\"You are a careful research assistant.\",\"apps\":[{\"id\":\"mock-github\",\"enabled\":false,\"mode\":\"configuration-only\"}],\"skills\":[{\"id\":\"research-synthesis\",\"enabled\":true}],\"abilities\":[{\"id\":\"web-research\",\"enabled\":true}],\"output\":{\"format\":\"markdown\"}},\"title\":\"E2B Smoke\"}'"
```

Make sure the preceding script line has a trailing comma so `package.json` remains valid JSON.

- [ ] **Step 4: Write operator docs**

Create `docs/runner-e2b.md`:

```md
# E2B Runner

## Required Environment

- `RUNNER_MODE=e2b`
- `E2B_API_KEY`: E2B API key for the runner service.
- `E2B_TEMPLATE_ID`: published template id for `e2b.Dockerfile`.
- `RUN_TIMEOUT_MS`: per Codex execution timeout, default `120000`.
- `RUNNER_EVENT_TOKEN`: shared secret used by the runner to append incremental task events through the API.
- `API_PUBLIC_BASE_URL`: API base URL reachable by the runner for `/internal/runner/task-events`.

## Template Build

Build and publish the template with the E2B CLI after authenticating to E2B:

```bash
e2b template build
```

Record the published template id in `E2B_TEMPLATE_ID`.

## Runtime Model Credentials

The end user provides the model API key per chat request. The API forwards it to the runner as `runtimeSecrets.apiKey`. The runner passes it to the E2B command with command-scoped `envs`:

```ts
envs: {
  OPENAI_API_KEY: runtimeSecrets.apiKey,
  OPENAI_BASE_URL: agentSpec.model.apiEndpoint
}
```

Do not put user-provided model keys in `Sandbox.create({ envs })`, E2B metadata, template files, prompts, command arguments, or logs. Command-scoped `envs` are scoped to the command, but they are visible inside the sandbox process environment while the command runs. Treat E2B as trusted execution infrastructure for the duration of execution.

## Secret Residue Smoke

After an E2B smoke run, inspect the sandbox before pause in a debug build and confirm the runtime key is absent from:

- `/home/user/workspace`
- Codex config and session directories
- shell history files
- runner raw output
- persisted `task_message` rows

## Lifecycle

v0.1.2 pauses sandboxes after each run and resumes them by sandbox id on follow-up turns. If a sandbox is gone, the runner creates a fresh sandbox and must establish a fresh Codex session id before updating `chat_session` pointers.

Archive cleanup is deferred in v0.1.2. Do not add kill-on-archive behavior in this release.
```

- [ ] **Step 5: Validate JSON and docs paths**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json ok')"
test -f e2b.Dockerfile
test -f e2b.toml
test -f docs/runner-e2b.md
```

Expected:

```text
package.json ok
```

and both `test -f` commands exit successfully.

- [ ] **Step 6: Commit**

Run:

```bash
git add e2b.Dockerfile e2b.toml docs/runner-e2b.md package.json
git commit -m "docs: add E2B runner setup"
```

## Task 11: Remove Local Codex Runner Path

**Files:**
- Delete: `apps/runner/src/codex-runner.ts`
- Modify: `apps/runner/src/__tests__/runner.test.ts`

- [ ] **Step 1: Confirm no tests import the local Codex runner**

Run:

```bash
rg "codex-runner|createCodexCommand|runCodexAgentTask" apps/runner/src
```

Expected: only `apps/runner/src/codex-runner.ts` appears, or no results if previous tasks already removed references.

- [ ] **Step 2: Delete local Codex runner**

Run:

```bash
rm apps/runner/src/codex-runner.ts
```

- [ ] **Step 3: Run runner tests and typecheck**

Run:

```bash
pnpm --filter @agent-builder/runner test -- src/__tests__/runner.test.ts
pnpm --filter @agent-builder/runner typecheck
```

Expected: both PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/runner/src/codex-runner.ts apps/runner/src/__tests__/runner.test.ts
git commit -m "refactor: remove local Codex runner"
```

## Task 12: Full Verification and Smoke Checklist

**Files:**
- Modify: `docs/runner-e2b.md` if verification reveals command corrections.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run workspace typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Run fake-mode local smoke**

Start services:

```bash
RUNNER_MODE=fake pnpm dev
```

In a second terminal, run:

```bash
pnpm smoke:health
```

Expected: API health returns `{"ok":true}` and runner health returns `{"ok":true,"runnerMode":"fake"}`.

- [ ] **Step 5: Run E2B-mode deployed smoke**

With `DATABASE_URL`, `RUNNER_MODE=e2b`, `E2B_API_KEY`, `E2B_TEMPLATE_ID`, `RUNNER_EVENT_TOKEN`, `API_PUBLIC_BASE_URL`, and a valid model API key configured, send a chat message through the deployed API.

Expected:

- First turn completes and returns assistant Markdown.
- `chat_session.workDir` is an E2B sandbox id.
- `chat_session.sessionId` is a Codex session id.
- `GET /api/chat-sessions/:id/events` shows incremental task messages before final completion when polled during execution.
- Follow-up turn reuses the same sandbox id and resumes the Codex session.
- Runtime API key does not appear in `chat_message`, `agent_tasks.raw_output_redacted`, `task_message`, runner logs, or API logs.

- [ ] **Step 6: Record verification notes**

Append a short verification section to `docs/runner-e2b.md`:

```md
## Verification Notes

- Unit tests: `pnpm test`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Fake smoke: `pnpm smoke:health` with `RUNNER_MODE=fake`
- E2B smoke: first turn and follow-up turn in deployed environment with valid E2B and model credentials
```

- [ ] **Step 7: Commit**

Run:

```bash
git add docs/runner-e2b.md
git commit -m "docs: record E2B runner verification"
```

## Self-Review

Spec coverage:

- E2B runner replaces local spawn path: Tasks 5, 6, 7, 8, 11.
- One `chat_session` maps to one long-lived sandbox by `work_dir`: Tasks 6, 7, 9.
- Codex `session_id` resume and workspace-lost fresh session behavior: Tasks 5, 7, 9.
- Fake runner remains local demo path: Task 8 and Task 12.
- Option C incremental persistence: Tasks 1, 2, 3, 4, 7.
- Runtime-only key and command-scoped envs: Tasks 7, 10, 12.
- Pause on completion and archive cleanup deferred: Tasks 7, 10.
- Tests and docs: Tasks 1 through 12.

Known gaps intentionally left outside v0.1.2:

- Real MCP integration.
- Permissions policy UI.
- Encrypted key persistence.
- Sandbox kill-on-archive.
- Full runner-to-API SSE/NDJSON streaming.

Placeholder scan:

- The plan does not contain `TBD`, `TODO`, or "fill in details".
- Each code-changing task includes concrete test code, implementation code, commands, expected outcomes, and commit commands.

Type consistency:

- `CreateAgentTaskRequest.taskId` is optional for compatibility with fake/local callers and required by the API when invoking the runner.
- `RunnerTaskEventRequest.messages` uses `RunnerTaskMessage[]`.
- Runner event auth consistently uses `RUNNER_EVENT_TOKEN`.
- E2B runner uses `workDir` as sandbox id and `sessionId` as Codex session id.
