import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

const CHAT_MIGRATIONS_ADVISORY_LOCK_KEY = 1742017085;

async function tableExists(db: Queryable, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
      ) as exists
    `,
    [tableName]
  );

  return result.rows[0]?.exists ?? false;
}

async function columnExists(db: Queryable, tableName: string, columnName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
      ) as exists
    `,
    [tableName, columnName]
  );

  return result.rows[0]?.exists ?? false;
}

async function indexExists(db: Queryable, indexName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from pg_indexes
        where schemaname = 'public'
          and indexname = $1
      ) as exists
    `,
    [indexName]
  );

  return result.rows[0]?.exists ?? false;
}

function isPgMemUnsupportedIfNotExists(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Not supported");
}

function isUnsupportedAdvisoryLockError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("pg_advisory_xact_lock") || error.message.includes("Not supported"))
  );
}

async function createTableIfNeeded(db: Queryable, tableName: string, sql: string): Promise<void> {
  try {
    await db.query(sql);
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error)) {
      throw error;
    }
    if (await tableExists(db, tableName)) {
      return;
    }
    await db.query(sql.replace("create table if not exists", "create table"));
  }
}

async function addColumnIfNeeded(db: Queryable, tableName: string, columnName: string, sql: string): Promise<void> {
  try {
    await db.query(sql);
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error)) {
      throw error;
    }
    if (await columnExists(db, tableName, columnName)) {
      return;
    }
    await db.query(sql.replace("add column if not exists", "add column"));
  }
}

async function createIndexIfNeeded(db: Queryable, indexName: string, sql: string): Promise<void> {
  try {
    await db.query(sql);
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error)) {
      throw error;
    }
    if (await indexExists(db, indexName)) {
      return;
    }
    await db.query(sql.replace("create unique index if not exists", "create unique index"));
  }
}

async function repairAgentTaskTriggerLinks(db: Queryable): Promise<void> {
  const taskResult = await db.query<{
    id: string;
    trigger_message_id: string;
  }>(`
    select id, trigger_message_id
    from agent_tasks
    order by trigger_message_id asc, created_at asc, created_order asc, id asc
  `);

  const canonicalByTrigger = new Map<string, string>();
  const duplicateTaskIdsByCanonical = new Map<string, string[]>();

  for (const row of taskResult.rows) {
    const canonicalTaskId = canonicalByTrigger.get(row.trigger_message_id);

    if (canonicalTaskId == null) {
      canonicalByTrigger.set(row.trigger_message_id, row.id);
      continue;
    }

    const duplicateTaskIds = duplicateTaskIdsByCanonical.get(canonicalTaskId) ?? [];
    duplicateTaskIds.push(row.id);
    duplicateTaskIdsByCanonical.set(canonicalTaskId, duplicateTaskIds);
  }

  for (const [triggerMessageId, canonicalTaskId] of canonicalByTrigger) {
    await db.query(
      `
        update chat_message
        set task_id = $2
        where id = $1
          and role = 'user'
          and (task_id is null or task_id <> $2)
      `,
      [triggerMessageId, canonicalTaskId]
    );

    const duplicateTaskIds = duplicateTaskIdsByCanonical.get(canonicalTaskId) ?? [];
    if (duplicateTaskIds.length === 0) {
      continue;
    }

    await db.query(
      `
        update chat_message
        set task_id = $2
        where task_id = any($1::text[])
      `,
      [duplicateTaskIds, canonicalTaskId]
    );
  }

  // v0.1.1 accepts deleting duplicate task rows because task_message cascades with the task.
  for (const duplicateTaskIds of duplicateTaskIdsByCanonical.values()) {
    for (const duplicateTaskId of duplicateTaskIds) {
      await db.query("delete from agent_tasks where id = $1", [duplicateTaskId]);
    }
  }
}

async function backfillCreatedOrder(db: Queryable, tableName: "chat_message" | "agent_tasks"): Promise<void> {
  const maxResult = await db.query<{ max_created_order: string | number | null }>(
    `
      select coalesce(max(created_order), 0) as max_created_order
      from ${tableName}
    `
  );
  const missingRowsResult = await db.query<{ id: string }>(
    `
      select id
      from ${tableName}
      where created_order is null
      order by created_at asc, id asc
    `
  );

  let nextCreatedOrder = Number(maxResult.rows[0]?.max_created_order ?? 0);
  for (const row of missingRowsResult.rows) {
    nextCreatedOrder += 1;
    await db.query(
      `
        update ${tableName}
        set created_order = $2
        where id = $1
      `,
      [row.id, nextCreatedOrder]
    );
  }
}

async function runChatMigrationsSequence(db: Queryable): Promise<void> {
  await createTableIfNeeded(
    db,
    "default_agent_config",
    `
    create table if not exists default_agent_config (
      id text primary key,
      agent_spec jsonb not null,
      updated_at timestamptz not null default now()
    )
  `
  );

  await createTableIfNeeded(
    db,
    "chat_session",
    `
    create table if not exists chat_session (
      id text primary key,
      agent_spec_snapshot jsonb not null,
      title text not null,
      session_id text,
      work_dir text,
      status text not null check (status in ('active', 'archived')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `
  );

  await createTableIfNeeded(
    db,
    "chat_message",
    `
    create table if not exists chat_message (
      id text primary key,
      chat_session_id text not null references chat_session(id) on delete cascade,
      role text not null check (role in ('user', 'assistant')),
      content_markdown text not null,
      -- Soft relation by design: the triggering chat_message is inserted before its agent_task exists.
      task_id text,
      created_at timestamptz not null default now()
    )
  `
  );

  await createTableIfNeeded(
    db,
    "agent_tasks",
    `
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
    )
  `
  );

  await createTableIfNeeded(
    db,
    "task_message",
    `
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
    )
  `
  );

  await addColumnIfNeeded(
    db,
    "chat_message",
    "created_order",
    `
    alter table chat_message
    add column if not exists created_order bigserial
  `
  );

  await addColumnIfNeeded(
    db,
    "agent_tasks",
    "created_order",
    `
    alter table agent_tasks
    add column if not exists created_order bigserial
  `
  );

  await backfillCreatedOrder(db, "chat_message");
  await backfillCreatedOrder(db, "agent_tasks");

  await repairAgentTaskTriggerLinks(db);

  await createIndexIfNeeded(
    db,
    "uq_agent_tasks_trigger_message_id",
    `
      create unique index if not exists uq_agent_tasks_trigger_message_id
        on agent_tasks(trigger_message_id)
    `
  );

  await db.query(`
    create index if not exists idx_chat_message_session_created
      on chat_message(chat_session_id, created_at, created_order)
  `);

  await db.query(`
    create index if not exists idx_agent_tasks_session_created
      on agent_tasks(chat_session_id, created_at, created_order)
  `);

  await db.query(`
    create index if not exists idx_task_message_task_seq
      on task_message(task_id, seq)
  `);
}

export async function runChatMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");

    try {
      await client.query("select pg_advisory_xact_lock($1)", [CHAT_MIGRATIONS_ADVISORY_LOCK_KEY]);
    } catch (error) {
      await client.query("rollback");

      if (isUnsupportedAdvisoryLockError(error)) {
        await runChatMigrationsSequence(pool);
        return;
      }

      throw error;
    }

    await runChatMigrationsSequence(client);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Ignore rollback errors after failed begin/commit paths.
    }
    throw error;
  } finally {
    client.release();
  }
}
