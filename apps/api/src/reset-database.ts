import type { Pool } from "pg";

export const resetDatabaseTables = [
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
] as const;

function isPgMemMultipleTruncateError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Multiple truncations");
}

export async function resetDatabaseRecords(pool: Pool): Promise<void> {
  try {
    await pool.query(`truncate table ${resetDatabaseTables.join(", ")} restart identity cascade`);
  } catch (error) {
    if (!isPgMemMultipleTruncateError(error)) {
      throw error;
    }

    for (const tableName of resetDatabaseTables) {
      await pool.query(`delete from ${tableName}`);
    }
  }
}

export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const parsed = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
}
