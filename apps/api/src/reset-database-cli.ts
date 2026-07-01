import { Pool } from "pg";
import { runChatMigrations } from "./chat-migrations";
import { isLocalDatabaseUrl, resetDatabaseRecords, resetDatabaseTables } from "./reset-database";

const defaultLocalDatabaseUrl = "postgres://postgres:agent_builder@localhost:54329/agent_builder";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;
  const allowNonLocalReset = process.env.ALLOW_NON_LOCAL_DB_RESET === "true";

  if (!allowNonLocalReset && !isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(
      "Refusing to reset a non-local database. Set ALLOW_NON_LOCAL_DB_RESET=true if you really mean it."
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await runChatMigrations(pool);
    await resetDatabaseRecords(pool);
    console.log(`Reset ${resetDatabaseTables.length} database tables. Database is clean like new.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
