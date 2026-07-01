import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAgentSpec,
  type CreateAgentRequest,
  type UpdateAgentRequest
} from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { PgChatStore } from "../chat-store";

process.env.LLM_API_KEY_ENCRYPTION_KEY = "a".repeat(64);

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

  it("reruns chat migrations safely", async () => {
    await expect(runChatMigrations(pool)).resolves.toBeUndefined();
    await expect(runChatMigrations(pool)).resolves.toBeUndefined();
  });

  it("migrates existing GitHub Connected Account and Tool Configuration rows to the github app id and list issues tool", async () => {
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    await pool.query(
      `
        insert into connected_accounts (
          id,
          workspace_id,
          app_id,
          account_label,
          external_account_id,
          status
        )
        values ('legacy-github-account', 'workspace_demo', 'mock-github', 'GitHub via Arcade', 'demo-user', 'connected')
      `
    );
    await pool.query(
      `
        insert into tool_configurations (
          id,
          agent_id,
          connected_account_id,
          app_id,
          tool_name,
          mode,
          sync_status,
          last_synced_mode,
          last_synced_at
        )
        values (
          'legacy-github-search-config',
          $1,
          'legacy-github-account',
          'mock-github',
          'github_search_issues',
          'ask_each_time',
          'synced',
          'ask_each_time',
          now()
        )
      `,
      [agent.id]
    );

    await runChatMigrations(pool);
    await runChatMigrations(pool);

    const connectedAccounts = await pool.query<{ app_id: string }>(
      `select app_id from connected_accounts where id = 'legacy-github-account'`
    );
    const toolConfigurations = await pool.query<{ app_id: string; tool_name: string }>(
      `select app_id, tool_name from tool_configurations where id = 'legacy-github-search-config'`
    );

    expect(connectedAccounts.rows).toEqual([{ app_id: "github" }]);
    expect(toolConfigurations.rows).toEqual([{ app_id: "github", tool_name: "github_list_issues" }]);
  });

  describe("v0.1.3 multi-agent migration", () => {
    it("creates the agents table", async () => {
      const result = await pool.query<{ table_name: string }>(`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'agents'
      `);
      expect(result.rows.length).toBe(1);
    });

    it("seeds a default agent from default_agent_config", async () => {
      await pool.query(
        `insert into default_agent_config (id, agent_spec, updated_at)
         values ($1, $2, now())
         on conflict (id) do update
         set agent_spec = excluded.agent_spec,
             updated_at = now()`,
        ["default", JSON.stringify(defaultAgentSpec)]
      );

      await runChatMigrations(pool);

      const result = await pool.query<{ id: string; name: string; description: string; spec: unknown }>(
        `select id, name, description, spec from agents`
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      const defaultAgent = result.rows.find((row) => row.name === defaultAgentSpec.identity.name);
      expect(defaultAgent).toBeDefined();
    });

    it("adds agent_id, agent_name, and last_message_preview columns to chat_session", async () => {
      const result = await pool.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'chat_session'
          and column_name in ('agent_id', 'agent_name', 'last_message_preview')
      `);
      expect(result.rows.length).toBe(3);
    });

    it("backfills agent_name from existing agent_spec_snapshot", async () => {
      await pool.query(
        `insert into chat_session (id, agent_spec_snapshot, title, status, agent_id, agent_name)
         values ($1, $2, 'Test', 'active', null, null)`,
        ["cs_backfill", JSON.stringify(defaultAgentSpec)]
      );

      await runChatMigrations(pool);

      const result = await pool.query<{ agent_name: string; agent_id: string }>(
        `select agent_name, agent_id from chat_session where id = $1`,
        ["cs_backfill"]
      );
      expect(result.rows[0]?.agent_name).toBe(defaultAgentSpec.identity.name);
      expect(result.rows[0]?.agent_id).toBeTruthy();
    });

    it("adds the encrypted_api_key column to agents", async () => {
      const result = await pool.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agents'
          and column_name = 'encrypted_api_key'
      `);
      expect(result.rows.length).toBe(1);
    });
  });

  it("repairs duplicate trigger tasks by keeping the richer terminal canonical task during migrations", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Migration repair session"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Please run this task.",
      taskId: null
    });

    await pool.query("drop index if exists uq_agent_tasks_trigger_message_id");

    const assistantMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "assistant",
      contentMarkdown: "Task completed.",
      taskId: null
    });

    await pool.query(
      `
        insert into agent_tasks (
          id,
          chat_session_id,
          trigger_message_id,
          agent_spec_snapshot,
          status,
          result_markdown,
          completed_at,
          created_at
        )
        values
          ('task-pending-early', $1, $2, $3, 'pending', null, null, '2026-01-01T00:00:00Z'),
          ('task-completed-late', $1, $2, $3, 'completed', '# Done', '2026-01-01T00:05:00Z', '2026-01-01T00:00:01Z')
      `,
      [session.id, triggerMessage.id, defaultAgentSpec]
    );

    await pool.query("update chat_message set task_id = $2 where id = $1", [triggerMessage.id, "task-completed-late"]);
    await pool.query("update chat_message set task_id = $2 where id = $1", [assistantMessage.id, "task-completed-late"]);

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const repairedTasks = await pool.query<{
      id: string;
      status: string;
      result_markdown: string | null;
    }>(
      `
        select id, status, result_markdown
        from agent_tasks
        where trigger_message_id = $1
        order by created_at asc, created_order asc, id asc
      `,
      [triggerMessage.id]
    );
    const repairedMessages = await pool.query<{ id: string; task_id: string | null }>(
      `
        select id, task_id
        from chat_message
        where id in ($1, $2)
        order by created_at asc, id asc
      `,
      [triggerMessage.id, assistantMessage.id]
    );

    expect(repairedTasks.rows).toEqual([
      { id: "task-completed-late", status: "completed", result_markdown: "# Done" }
    ]);
    expect(repairedMessages.rows).toEqual([
      { id: triggerMessage.id, task_id: "task-completed-late" },
      { id: assistantMessage.id, task_id: "task-completed-late" }
    ]);

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const rerunTasks = await pool.query<{ id: string }>(
      `
        select id
        from agent_tasks
        where trigger_message_id = $1
      `,
      [triggerMessage.id]
    );

    expect(rerunTasks.rows.map((row) => row.id)).toEqual(["task-completed-late"]);
  });

  it("preserves duplicate resume metadata and task messages on the canonical task during migration repair", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Duplicate preservation session"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Resume this task.",
      taskId: null
    });

    await pool.query("drop index if exists uq_agent_tasks_trigger_message_id");

    await pool.query(
      `
        insert into agent_tasks (
          id,
          chat_session_id,
          trigger_message_id,
          agent_spec_snapshot,
          status,
          session_id,
          work_dir,
          result_markdown,
          started_at,
          completed_at,
          created_at
        )
        values
          (
            'task-canonical',
            $1,
            $2,
            $3,
            'completed',
            null,
            null,
            '# Richer result',
            null,
            null,
            '2026-01-01T00:00:01Z'
          ),
          (
            'task-duplicate',
            $1,
            $2,
            $3,
            'running',
            'codex-session-123',
            '/tmp/duplicate-worktree',
            null,
            '2026-01-01T00:00:02Z',
            '2026-01-01T00:05:00Z',
            '2026-01-01T00:00:00Z'
          )
      `,
      [session.id, triggerMessage.id, defaultAgentSpec]
    );

    await pool.query(
      `
        insert into task_message (id, task_id, seq, type, tool, content, created_at)
        values
          ('canonical-msg-0', 'task-canonical', 0, 'status', null, 'canonical message', '2026-01-01T00:00:03Z'),
          ('duplicate-msg-1', 'task-duplicate', 0, 'text', null, 'duplicate first', '2026-01-01T00:00:04Z'),
          ('duplicate-msg-2', 'task-duplicate', 1, 'tool_result', 'fetch', 'duplicate second', '2026-01-01T00:00:05Z')
      `
    );

    await pool.query("update chat_message set task_id = $2 where id = $1", [triggerMessage.id, "task-duplicate"]);

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const repairedTasks = await pool.query<{
      id: string;
      status: string;
      session_id: string | null;
      work_dir: string | null;
      result_markdown: string | null;
      started_at: Date | string | null;
      completed_at: Date | string | null;
    }>(
      `
        select id, status, session_id, work_dir, result_markdown, started_at, completed_at
        from agent_tasks
        where trigger_message_id = $1
      `,
      [triggerMessage.id]
    );
    const repairedTaskMessages = await pool.query<{
      task_id: string;
      seq: number;
      content: string;
    }>(
      `
        select task_id, seq, content
        from task_message
        where task_id = 'task-canonical'
        order by seq asc, created_at asc, id asc
      `
    );
    const duplicateTaskMessages = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from task_message
        where task_id = 'task-duplicate'
      `
    );

    expect(repairedTasks.rows).toEqual([
      {
        id: "task-canonical",
        status: "completed",
        session_id: "codex-session-123",
        work_dir: "/tmp/duplicate-worktree",
        result_markdown: "# Richer result",
        started_at: new Date("2026-01-01T00:00:02Z"),
        completed_at: new Date("2026-01-01T00:05:00Z")
      }
    ]);
    expect(repairedTaskMessages.rows).toEqual([
      { task_id: "task-canonical", seq: 0, content: "canonical message" },
      { task_id: "task-canonical", seq: 1, content: "duplicate first" },
      { task_id: "task-canonical", seq: 2, content: "duplicate second" }
    ]);
    expect(duplicateTaskMessages.rows[0]?.count).toBe("0");

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const rerunDetail = await store.getChatSessionDetail(session.id);

    expect(rerunDetail?.latestTask?.id).toBe("task-canonical");
    expect(rerunDetail?.latestTask?.sessionId).toBe("codex-session-123");
    expect(rerunDetail?.latestTask?.workDir).toBe("/tmp/duplicate-worktree");
    expect(rerunDetail?.taskMessages.map((message) => [message.seq, message.content])).toEqual([
      [0, "canonical message"],
      [1, "duplicate first"],
      [2, "duplicate second"]
    ]);
  });

  it("repoints every chat message linked to a deleted duplicate task during migration repair", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Migration repair session"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Please run this task.",
      taskId: null
    });
    const assistantMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "assistant",
      contentMarkdown: "Task completed.",
      taskId: null
    });

    await pool.query("drop index if exists uq_agent_tasks_trigger_message_id");

    await pool.query(
      `
        insert into agent_tasks (
          id,
          chat_session_id,
          trigger_message_id,
          agent_spec_snapshot,
          status,
          created_at
        )
        values
          ('task-late', $1, $2, $3, 'completed', '2026-01-01T00:00:01Z'),
          ('task-early', $1, $2, $3, 'completed', '2026-01-01T00:00:00Z')
      `,
      [session.id, triggerMessage.id, defaultAgentSpec]
    );

    await pool.query("update chat_message set task_id = $2 where id = $1", [triggerMessage.id, "task-late"]);
    await pool.query("update chat_message set task_id = $2 where id = $1", [assistantMessage.id, "task-late"]);

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const messages = await pool.query<{ id: string; role: string; task_id: string | null }>(
      `
        select id, role, task_id
        from chat_message
        where chat_session_id = $1
        order by created_at asc, created_order asc, id asc
      `,
      [session.id]
    );
    const danglingMessages = await pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from chat_message
        where task_id = 'task-late'
      `
    );

    expect(messages.rows).toHaveLength(2);
    expect(messages.rows).toEqual(
      expect.arrayContaining([
        { id: triggerMessage.id, role: "user", task_id: "task-early" },
        { id: assistantMessage.id, role: "assistant", task_id: "task-early" }
      ])
    );
    expect(danglingMessages.rows[0]?.count).toBe("0");
  });

  it("backfills missing created_order values for legacy rows and keeps ordering stable", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Legacy ordering session"
    });

    await pool.query("drop index if exists uq_agent_tasks_trigger_message_id");

    await pool.query(
      `
        insert into chat_message (
          id,
          chat_session_id,
          role,
          content_markdown,
          task_id,
          created_at,
          created_order
        )
        values
          ('legacy-msg-b', $1, 'user', 'Second by id', null, '2026-01-01T00:00:00Z', null),
          ('legacy-msg-a', $1, 'assistant', 'First by id', null, '2026-01-01T00:00:00Z', null)
      `,
      [session.id]
    );

    await pool.query(
      `
        insert into agent_tasks (
          id,
          chat_session_id,
          trigger_message_id,
          agent_spec_snapshot,
          status,
          created_at,
          created_order
        )
        values
          ('legacy-task-b', $1, 'legacy-msg-b', $2, 'pending', '2026-01-01T00:00:00Z', null),
          ('legacy-task-a', $1, 'legacy-msg-a', $2, 'running', '2026-01-01T00:00:00Z', null)
      `,
      [session.id, defaultAgentSpec]
    );

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();

    const messageOrders = await pool.query<{ id: string; created_order: string | null }>(
      `
        select id, created_order::text as created_order
        from chat_message
        where id in ('legacy-msg-a', 'legacy-msg-b')
        order by created_at asc, created_order asc, id asc
      `
    );
    const taskOrders = await pool.query<{ id: string; created_order: string | null }>(
      `
        select id, created_order::text as created_order
        from agent_tasks
        where id in ('legacy-task-a', 'legacy-task-b')
        order by created_at asc, created_order asc, id asc
      `
    );
    const detail = await store.getChatSessionDetail(session.id);

    expect(messageOrders.rows).toEqual([
      { id: "legacy-msg-a", created_order: expect.any(String) },
      { id: "legacy-msg-b", created_order: expect.any(String) }
    ]);
    expect(taskOrders.rows).toEqual([
      { id: "legacy-task-a", created_order: expect.any(String) },
      { id: "legacy-task-b", created_order: expect.any(String) }
    ]);
    expect(detail?.messages.slice(-2).map((message) => message.id)).toEqual(["legacy-msg-a", "legacy-msg-b"]);
    expect(detail?.latestTask?.id).toBe("legacy-task-b");
  });

  it("rejects createAgentTask when the trigger message belongs to a different session without leaving orphan tasks", async () => {
    const firstSession = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "First session"
    });
    const secondSession = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Second session"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: secondSession.id,
      role: "user",
      contentMarkdown: "Wrong session trigger.",
      taskId: null
    });

    await expect(
      store.createAgentTask({
        chatSessionId: firstSession.id,
        triggerMessageId: triggerMessage.id,
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow(/trigger message/i);

    const taskCount = await pool.query<{ count: string }>("select count(*)::text as count from agent_tasks");
    const messageTask = await pool.query<{ task_id: string | null }>(
      "select task_id from chat_message where id = $1",
      [triggerMessage.id]
    );

    expect(taskCount.rows[0]?.count).toBe("0");
    expect(messageTask.rows[0]?.task_id).toBeNull();
  });

  it("rejects createAgentTask when the trigger message is missing without leaving orphan tasks", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });

    await expect(
      store.createAgentTask({
        chatSessionId: session.id,
        triggerMessageId: "missing-trigger-message",
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow(/trigger message/i);

    const taskCount = await pool.query<{ count: string }>("select count(*)::text as count from agent_tasks");

    expect(taskCount.rows[0]?.count).toBe("0");
  });

  it("rejects createAgentTask when the trigger message is an assistant message", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const assistantMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "assistant",
      contentMarkdown: "Already answered.",
      taskId: null
    });

    await expect(
      store.createAgentTask({
        chatSessionId: session.id,
        triggerMessageId: assistantMessage.id,
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow(/user message/i);

    const taskCount = await pool.query<{ count: string }>("select count(*)::text as count from agent_tasks");
    const messageTask = await pool.query<{ task_id: string | null }>(
      "select task_id from chat_message where id = $1",
      [assistantMessage.id]
    );

    expect(taskCount.rows[0]?.count).toBe("0");
    expect(messageTask.rows[0]?.task_id).toBeNull();
  });

  it("returns the existing linked task when createAgentTask is called twice for the same trigger message", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });

    const firstTask = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: triggerMessage.id,
      agentSpec: defaultAgentSpec
    });

    const secondTask = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: triggerMessage.id,
      agentSpec: defaultAgentSpec
    });

    const taskCount = await pool.query<{ count: string }>("select count(*)::text as count from agent_tasks");
    const messageTask = await pool.query<{ task_id: string | null }>(
      "select task_id from chat_message where id = $1",
      [triggerMessage.id]
    );

    expect(secondTask).toEqual(firstTask);
    expect(taskCount.rows[0]?.count).toBe("1");
    expect(messageTask.rows[0]?.task_id).toBe(firstTask.id);
  });

  it("propagates unexpected insert failures from createAgentTask", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });

    await pool.query("drop index if exists uq_agent_tasks_trigger_message_id");
    await pool.query(`
      alter table agent_tasks
      add constraint reject_pending_agent_tasks
      check (status <> 'pending')
    `);

    await expect(
      store.createAgentTask({
        chatSessionId: session.id,
        triggerMessageId: triggerMessage.id,
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow();

    const taskCount = await pool.query<{ count: string }>("select count(*)::text as count from agent_tasks");
    const messageTask = await pool.query<{ task_id: string | null }>(
      "select task_id from chat_message where id = $1",
      [triggerMessage.id]
    );

    expect(taskCount.rows[0]?.count).toBe("0");
    expect(messageTask.rows[0]?.task_id).toBeNull();
  });

  it("throws a clear corruption error when a linked task row is missing", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });

    await pool.query("update chat_message set task_id = $2 where id = $1", [triggerMessage.id, "missing-task"]);

    await expect(
      store.createAgentTask({
        chatSessionId: session.id,
        triggerMessageId: triggerMessage.id,
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow(`Linked agent task not found for trigger message: ${triggerMessage.id}`);
  });

  it("throws a clear corruption error when a trigger message points to another task in the same session", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const firstTriggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the first task.",
      taskId: null
    });
    const secondTriggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the second task.",
      taskId: null
    });

    const firstTask = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: firstTriggerMessage.id,
      agentSpec: defaultAgentSpec
    });

    await pool.query("update chat_message set task_id = $2 where id = $1", [secondTriggerMessage.id, firstTask.id]);

    await expect(
      store.createAgentTask({
        chatSessionId: session.id,
        triggerMessageId: secondTriggerMessage.id,
        agentSpec: defaultAgentSpec
      })
    ).rejects.toThrow(
      `Corrupt trigger message link: chat_message ${secondTriggerMessage.id} points to task ${firstTask.id} for trigger ${firstTriggerMessage.id}`
    );
  });

  it("enforces a single agent task per trigger message at the schema level", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Research Agent"
    });
    const triggerMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });

    await pool.query(
      `
        insert into agent_tasks (id, chat_session_id, trigger_message_id, agent_spec_snapshot, status)
        values ('task-1', $1, $2, $3, 'pending')
      `,
      [session.id, triggerMessage.id, defaultAgentSpec]
    );

    await expect(
      pool.query(
        `
          insert into agent_tasks (id, chat_session_id, trigger_message_id, agent_spec_snapshot, status)
          values ('task-2', $1, $2, $3, 'pending')
        `,
        [session.id, triggerMessage.id, defaultAgentSpec]
      )
    ).rejects.toThrow();
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
    expect(detail?.messages[0]?.taskId).toBe(task.id);
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

  it("does not move terminal tasks back to running", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Research Agent" });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Finish this.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });

    const completedTask = await store.completeAgentTask(task.id, {
      status: "completed",
      resultMarkdown: "First result",
      rawOutputRedacted: "first raw output",
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-task",
      taskMessages: [{ type: "status", tool: null, content: "done", inputJson: null, output: null }]
    });

    const rerunTask = await store.markAgentTaskRunning(task.id);

    expect(rerunTask).toEqual(completedTask);
    expect(rerunTask?.status).toBe("completed");
    expect(rerunTask?.startedAt).toBe(completedTask.startedAt);
    expect(rerunTask?.completedAt).toBe(completedTask.completedAt);
  });

  it("fills missing terminal completion metadata from duplicate callbacks without duplicating messages", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Research Agent" });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Do the task.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });

    const firstCompletion = await store.completeAgentTask(task.id, {
      status: "completed",
      resultMarkdown: "First result",
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: [
        { type: "status", tool: null, content: "started", inputJson: null, output: null },
        { type: "status", tool: null, content: "done", inputJson: null, output: null }
      ]
    });

    const duplicateCompletion = await store.completeAgentTask(task.id, {
      status: "completed",
      resultMarkdown: "Second result",
      rawOutputRedacted: "OPENAI_API_KEY=sk-test-secret",
      sessionId: "codex-session-2",
      workDir: "/tmp/agent-task-2",
      taskMessages: [{ type: "status", tool: null, content: "duplicate", inputJson: null, output: null }]
    });

    const detail = await store.getChatSessionDetail(session.id);

    expect(duplicateCompletion).toMatchObject({
      ...firstCompletion,
      rawOutputRedacted: "OPENAI_API_KEY=[REDACTED]",
      sessionId: "codex-session-2",
      workDir: "/tmp/agent-task-2"
    });
    expect(detail?.latestTask?.status).toBe("completed");
    expect(detail?.latestTask?.resultMarkdown).toBe("First result");
    expect(detail?.latestTask?.rawOutputRedacted).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.latestTask?.sessionId).toBe("codex-session-2");
    expect(detail?.latestTask?.workDir).toBe("/tmp/agent-task-2");
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[1]).toMatchObject({
      role: "assistant",
      contentMarkdown: "First result",
      taskId: task.id
    });
    expect(detail?.taskMessages.map((message) => message.content)).toEqual(["started", "done"]);
  });

  it("fills missing terminal failure metadata from duplicate callbacks without duplicating task messages", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Research Agent" });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Do the task.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });

    const firstFailure = await store.failAgentTask(task.id, {
      status: "failed",
      error: "First error",
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: [{ type: "error", tool: null, content: "first failure", inputJson: null, output: null }]
    });

    const duplicateFailure = await store.failAgentTask(task.id, {
      status: "timed_out",
      error: "apiKey: sk-test-secret",
      rawOutputRedacted: "OPENAI_API_KEY=sk-test-secret",
      sessionId: "codex-session-2",
      workDir: "/tmp/agent-task-2",
      taskMessages: [{ type: "error", tool: null, content: "duplicate failure", inputJson: null, output: null }]
    });

    const detail = await store.getChatSessionDetail(session.id);

    expect(duplicateFailure).toMatchObject({
      ...firstFailure,
      rawOutputRedacted: "OPENAI_API_KEY=[REDACTED]",
      sessionId: "codex-session-2",
      workDir: "/tmp/agent-task-2"
    });
    expect(detail?.latestTask?.status).toBe("failed");
    expect(detail?.latestTask?.error).toBe("First error");
    expect(detail?.latestTask?.rawOutputRedacted).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.latestTask?.sessionId).toBe("codex-session-2");
    expect(detail?.latestTask?.workDir).toBe("/tmp/agent-task-2");
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[1]).toMatchObject({
      role: "assistant",
      contentMarkdown: "Task failed: First error",
      taskId: task.id
    });
    expect(detail?.taskMessages.map((message) => message.content)).toEqual(["first failure"]);
  });

  it("redacts secrets before persisting completed task outputs and messages", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Redaction session" });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });

    await store.completeAgentTask(task.id, {
      status: "completed",
      resultMarkdown: "OPENAI_API_KEY=sk-test-secret",
      rawOutputRedacted: 'apiKey: sk-test-secret\nOPENAI_API_KEY=sk-test-secret',
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-task",
      taskMessages: [
        {
          type: "tool_result",
          tool: "fetch",
          content: "apiKey: sk-test-secret",
          inputJson: {
            apiKey: "plain-secret",
            nested: {
              openai_api_key: "plain-secret",
              authorization: "Bearer plain-secret",
              token: "plain-secret",
              secret: "plain-secret",
              preserved: "keep me"
            }
          },
          output: "OPENAI_API_KEY=sk-test-secret"
        }
      ]
    });

    const detail = await store.getChatSessionDetail(session.id);
    const persistedTaskMessage = await pool.query<{
      content: string;
      output: string | null;
      input_json: Record<string, unknown> | null;
    }>(
      `
        select content, output, input_json
        from task_message
        where task_id = $1
      `,
      [task.id]
    );

    expect(detail?.latestTask?.resultMarkdown).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.latestTask?.rawOutputRedacted).toContain("apiKey: [REDACTED]");
    expect(detail?.latestTask?.rawOutputRedacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.latestTask?.rawOutputRedacted).not.toContain("sk-test-secret");
    expect(detail?.messages[1]?.contentMarkdown).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.taskMessages[0]?.content).toBe("apiKey: [REDACTED]");
    expect(detail?.taskMessages[0]?.output).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(JSON.stringify(persistedTaskMessage.rows[0]?.input_json)).not.toContain("sk-test-secret");
    expect(persistedTaskMessage.rows[0]?.input_json).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        openai_api_key: "[REDACTED]",
        authorization: "[REDACTED]",
        token: "[REDACTED]",
        secret: "[REDACTED]",
        preserved: "keep me"
      }
    });
    expect(persistedTaskMessage.rows[0]?.content).toBe("apiKey: [REDACTED]");
    expect(persistedTaskMessage.rows[0]?.output).toBe("OPENAI_API_KEY=[REDACTED]");
  });

  it("redacts secrets before persisting failed task outputs and messages", async () => {
    const session = await store.createChatSession({ agentSpec: defaultAgentSpec, title: "Failure redaction session" });
    const userMessage = await store.createChatMessage({
      chatSessionId: session.id,
      role: "user",
      contentMarkdown: "Run the task.",
      taskId: null
    });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: userMessage.id,
      agentSpec: defaultAgentSpec
    });

    await store.failAgentTask(task.id, {
      status: "failed",
      error: "apiKey: sk-test-secret",
      rawOutputRedacted: "OPENAI_API_KEY=sk-test-secret",
      sessionId: "codex-session-1",
      workDir: "/tmp/agent-task",
      taskMessages: [
        {
          type: "error",
          tool: null,
          content: "OPENAI_API_KEY=sk-test-secret",
          inputJson: { apiKey: "sk-test-secret" },
          output: "apiKey: sk-test-secret"
        }
      ]
    });

    const detail = await store.getChatSessionDetail(session.id);

    expect(detail?.latestTask?.error).toBe("apiKey: [REDACTED]");
    expect(detail?.latestTask?.rawOutputRedacted).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.taskMessages[0]?.content).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(detail?.taskMessages[0]?.output).toBe("apiKey: [REDACTED]");
    expect(JSON.stringify(detail?.taskMessages[0]?.inputJson)).not.toContain("sk-test-secret");
  });

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

  it("appends terminal task messages after incremental runner messages", async () => {
    const session = await store.createChatSession({
      agentSpec: defaultAgentSpec,
      title: "Terminal append"
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
      { type: "status", tool: null, content: "streamed first", inputJson: null, output: null }
    ]);
    await store.failAgentTask(task.id, {
      status: "timed_out",
      error: "Runner timed out",
      rawOutputRedacted: "",
      sessionId: null,
      workDir: null,
      taskMessages: [{ type: "error", tool: null, content: "terminal timeout", inputJson: null, output: null }]
    });

    const detail = await store.getChatSessionDetail(session.id);

    expect(detail?.taskMessages.map((message) => [message.seq, message.content])).toEqual([
      [0, "streamed first"],
      [1, "terminal timeout"]
    ]);
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

  describe("agent CRUD", () => {
    it("creates an agent deriving name and description from spec", async () => {
      const input: CreateAgentRequest = { spec: defaultAgentSpec, apiKey: "sk-test" };
      const agent = await store.createAgent(input);

      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe(defaultAgentSpec.identity.name);
      expect(agent.description).toBe(defaultAgentSpec.identity.description);
      expect(agent.spec.identity.name).toBe(defaultAgentSpec.identity.name);
      expect(agent.createdAt).toBeTruthy();
      expect(agent.updatedAt).toBeTruthy();
    });

    it("creates an agent with a default spec when no spec is provided", async () => {
      const input: CreateAgentRequest = { apiKey: "sk-test" };
      const agent = await store.createAgent(input);

      expect(agent.name).toBe(defaultAgentSpec.identity.name);
      expect(agent.spec.version).toBe("0.1");
    });

    it("gets an agent by id", async () => {
      const created = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const agent = await store.getAgent(created.id);

      expect(agent).not.toBeNull();
      expect(agent!.id).toBe(created.id);
      expect(agent!.name).toBe(defaultAgentSpec.identity.name);
    });

    it("returns null for a missing agent", async () => {
      const agent = await store.getAgent("nonexistent");
      expect(agent).toBeNull();
    });

    it("lists all agents ordered by created_at", async () => {
      await store.createAgent({
        spec: {
          ...defaultAgentSpec,
          identity: { ...defaultAgentSpec.identity, name: "Agent A" }
        },
        apiKey: "sk-test"
      });
      await store.createAgent({
        spec: {
          ...defaultAgentSpec,
          identity: { ...defaultAgentSpec.identity, name: "Agent B" }
        },
        apiKey: "sk-test"
      });

      const agents = await store.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(2);
      const names = agents.map((a) => a.name);
      expect(names).toContain("Agent A");
      expect(names).toContain("Agent B");
    });

    it("updates an agent spec, re-deriving name and description", async () => {
      const created = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const newSpec = {
        ...defaultAgentSpec,
        identity: { name: "Updated Agent", description: "Updated description" }
      };
      const input: UpdateAgentRequest = { spec: newSpec };
      const updated = await store.updateAgent(created.id, input);

      expect(updated.name).toBe("Updated Agent");
      expect(updated.description).toBe("Updated description");
      expect(updated.spec.identity.name).toBe("Updated Agent");
    });

    it("throws when updating a nonexistent agent", async () => {
      const input: UpdateAgentRequest = { spec: defaultAgentSpec };
      await expect(store.updateAgent("nonexistent", input)).rejects.toThrow("not found");
    });

    it("encrypts the api key on create and sets hasApiKey", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-create" });
      expect(agent.hasApiKey).toBe(true);

      const stored = await pool.query<{ encrypted_api_key: string | null }>(
        `select encrypted_api_key from agents where id = $1`,
        [agent.id]
      );
      const encrypted = stored.rows[0].encrypted_api_key;
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toContain("sk-create");
      expect(encrypted!.split(":")).toHaveLength(3);
    });

    it("rejects creating an agent without an api key", async () => {
      await expect(
        store.createAgent({ spec: defaultAgentSpec, apiKey: "" })
      ).rejects.toThrow("API key is required");
    });

    it("re-encrypts on update when apiKey is provided", async () => {
      const created = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-old" });
      const before = await pool.query<{ encrypted_api_key: string | null }>(
        `select encrypted_api_key from agents where id = $1`,
        [created.id]
      );
      const updated = await store.updateAgent(created.id, { spec: defaultAgentSpec, apiKey: "sk-new" });
      expect(updated.hasApiKey).toBe(true);
      const after = await pool.query<{ encrypted_api_key: string | null }>(
        `select encrypted_api_key from agents where id = $1`,
        [created.id]
      );
      expect(after.rows[0].encrypted_api_key).not.toBe(before.rows[0].encrypted_api_key);
      expect(after.rows[0].encrypted_api_key).not.toContain("sk-new");
    });

    it("leaves the encrypted key unchanged on update when apiKey is omitted", async () => {
      const created = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-keep" });
      const before = await pool.query<{ encrypted_api_key: string | null }>(
        `select encrypted_api_key from agents where id = $1`,
        [created.id]
      );
      await store.updateAgent(created.id, { spec: defaultAgentSpec });
      const after = await pool.query<{ encrypted_api_key: string | null }>(
        `select encrypted_api_key from agents where id = $1`,
        [created.id]
      );
      expect(after.rows[0].encrypted_api_key).toBe(before.rows[0].encrypted_api_key);
    });

    it("exposes hasApiKey false for agents with a null encrypted key", async () => {
      const created = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-x" });
      await pool.query(`update agents set encrypted_api_key = null where id = $1`, [created.id]);
      const fetched = await store.getAgent(created.id);
      expect(fetched?.hasApiKey).toBe(false);
    });

    it("deletes an agent from future use while preserving its chat sessions", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "Historical chat" });

      await store.deleteAgent(agent.id);

      await expect(store.createChatSession({ agentId: agent.id })).rejects.toThrow("not found");
      expect(await store.getAgent(agent.id)).toBeNull();
      expect((await store.listAgents()).some((item) => item.id === agent.id)).toBe(false);

      const sessions = await store.listChatSessions();
      expect(sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: session.id,
            agentId: agent.id,
            agentName: agent.name,
            title: "Historical chat"
          })
        ])
      );

      const stored = await pool.query<{ encrypted_api_key: string | null; deleted_at: Date | null }>(
        `select encrypted_api_key, deleted_at from agents where id = $1`,
        [agent.id]
      );
      expect(stored.rows[0].encrypted_api_key).toBeNull();
      expect(stored.rows[0].deleted_at).toBeTruthy();
    });
  });

  describe("agent-bound session creation", () => {
    it("creates a chat session bound to an agent id with null spec snapshot", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id, title: "Test chat" });

      expect(session.agentId).toBe(agent.id);
      expect(session.agentName).toBe(agent.name);
      expect(session.agentSpecSnapshot).toBeNull();
      expect(session.title).toBe("Test chat");
      expect(session.status).toBe("active");
    });

    it("defaults the title to the agent name when not provided", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      const session = await store.createChatSession({ agentId: agent.id });

      expect(session.title).toBe(agent.name);
    });

    it("throws when creating a session for a nonexistent agent", async () => {
      await expect(store.createChatSession({ agentId: "nonexistent" })).rejects.toThrow("not found");
    });

    it("lists sessions with agentId, agentName, and lastMessagePreview", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      await store.createChatSession({ agentId: agent.id, title: "List test" });

      const sessions = await store.listChatSessions();
      const session = sessions.find((s) => s.title === "List test");
      expect(session).toBeDefined();
      expect(session!.agentId).toBe(agent.id);
      expect(session!.agentName).toBe(agent.name);
      expect(session!.lastMessagePreview).toBeNull();
    });
  });

  describe("Connected Account and Tool Configuration", () => {
    it("creates Connected Account state outside AgentSpec and exposes default Tool Configuration for an Agent", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });

      const connectedAccount = await store.createConnectedAccount({
        workspaceId: "workspace_demo",
        appId: "github",
        accountLabel: "GitHub",
        externalAccountId: "github-user-1",
        agentIds: [agent.id]
      });

      const toolConfigurations = await store.listToolConfigurationsForAgent(agent.id);

      expect(connectedAccount.appId).toBe("github");
      expect(toolConfigurations).toEqual([
        expect.objectContaining({
          agentId: agent.id,
          connectedAccountId: connectedAccount.id,
          appId: "github",
          toolName: "github_create_issue",
          mode: "ask_each_time"
        }),
        expect.objectContaining({
          agentId: agent.id,
          connectedAccountId: connectedAccount.id,
          appId: "github",
          toolName: "github_list_issues",
          mode: "ask_each_time"
        })
      ]);
      expect(JSON.stringify((await store.getAgent(agent.id))?.spec)).not.toContain("connectedAccount");
      expect(JSON.stringify((await store.getAgent(agent.id))?.spec)).not.toContain("ask_each_time");
    });

    it("updates Tool Configuration mode for an Agent", async () => {
      const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
      await store.createConnectedAccount({
        workspaceId: "workspace_demo",
        appId: "github",
        accountLabel: "GitHub",
        externalAccountId: "github-user-1",
        agentIds: [agent.id]
      });
      const [toolConfiguration] = await store.listToolConfigurationsForAgent(agent.id);

      const updated = await store.updateToolConfigurationMode({
        agentId: agent.id,
        toolConfigurationId: toolConfiguration.id,
        mode: "auto"
      });

      expect(updated.mode).toBe("auto");
      await expect(
        store.updateToolConfigurationMode({
          agentId: agent.id,
          toolConfigurationId: toolConfiguration.id,
          mode: "disabled"
        })
      ).resolves.toMatchObject({ mode: "disabled" });
      expect((await store.listToolConfigurationsForAgent(agent.id))[0].mode).toBe("disabled");
    });
  });
});
