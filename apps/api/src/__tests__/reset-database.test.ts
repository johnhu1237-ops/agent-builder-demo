import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAgentSpec } from "@agent-builder/shared";
import { runChatMigrations } from "../chat-migrations";
import { resetDatabaseRecords } from "../reset-database";
import { PgChatStore } from "../chat-store";

process.env.LLM_API_KEY_ENCRYPTION_KEY = "a".repeat(64);

describe("resetDatabaseRecords", () => {
  let pool: import("pg").Pool;

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await runChatMigrations(pool);
  });

  it("clears persisted app records while keeping the migrated schema usable", async () => {
    const store = new PgChatStore(pool);
    const agent = await store.createAgent({ spec: defaultAgentSpec, apiKey: "sk-test" });
    const session = await store.createChatSession({ agentId: agent.id, title: "Before reset" });
    const task = await store.createAgentTask({
      chatSessionId: session.id,
      triggerMessageId: (
        await store.createChatMessage({
          chatSessionId: session.id,
          role: "user",
          taskId: null,
          contentMarkdown: "Run the thing"
        })
      ).id,
      agentSpec: defaultAgentSpec
    });
    await store.createConnectedAccount({
      workspaceId: "workspace_demo",
      appId: "github",
      accountLabel: "GitHub via Arcade",
      externalAccountId: "github-user-1",
      agentIds: [agent.id]
    });
    await store.appendRunnerTaskMessages(task.id, [
      { type: "status", tool: null, content: "Started", inputJson: null, output: null }
    ]);

    await resetDatabaseRecords(pool);

    for (const tableName of [
      "tool_call_audit_logs",
      "tool_confirmations",
      "tool_configurations",
      "connected_account_agents",
      "connected_accounts",
      "agent_task_leases",
      "task_message",
      "agent_tasks",
      "chat_message",
      "chat_session",
      "agents",
      "default_agent_config"
    ]) {
      const result = await pool.query<{ count: string }>(`select count(*) from ${tableName}`);
      expect(Number(result.rows[0]?.count ?? 0), tableName).toBe(0);
    }

    await expect(runChatMigrations(pool)).resolves.toBeUndefined();
    const newStore = new PgChatStore(pool);
    const newAgent = await newStore.createAgent({ spec: defaultAgentSpec, apiKey: "sk-new" });
    const newSession = await newStore.createChatSession({ agentId: newAgent.id, title: "After reset" });

    expect(newSession.title).toBe("After reset");
  });
});
