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

function isPgMemUnknownLanguage(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unkonwn language");
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

async function createNonUniqueIndexIfNeeded(db: Queryable, indexName: string, sql: string): Promise<void> {
  try {
    await db.query(sql);
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error)) {
      throw error;
    }
    if (await indexExists(db, indexName)) {
      return;
    }
    await db.query(sql.replace("create index if not exists", "create index"));
  }
}

function hasNonEmptyText(value: string | null): value is string {
  return value != null && value.trim().length > 0;
}

async function repairAgentTaskTriggerLinks(db: Queryable): Promise<void> {
  const taskResult = await db.query<{
    id: string;
    chat_session_id: string;
    trigger_message_id: string;
    status: string;
    session_id: string | null;
    work_dir: string | null;
    result_markdown: string | null;
    raw_output_redacted: string | null;
    error: string | null;
    started_at: Date | string | null;
    completed_at: Date | string | null;
    created_at: Date | string;
    created_order: string | number | null;
  }>(`
    select
      id,
      chat_session_id,
      trigger_message_id,
      status,
      session_id,
      work_dir,
      result_markdown,
      raw_output_redacted,
      error,
      started_at,
      completed_at,
      created_at,
      created_order
    from agent_tasks
    order by trigger_message_id asc, chat_session_id asc, id asc
  `);

  type AgentTaskRepairRow = (typeof taskResult.rows)[number];
  const triggerKey = (row: AgentTaskRepairRow): string => `${row.chat_session_id}:${row.trigger_message_id}`;
  const taskRowById = new Map(taskResult.rows.map((row) => [row.id, row]));

  const taskPriority = (row: AgentTaskRepairRow): number => {
    const hasResultMarkdown = hasNonEmptyText(row.result_markdown);
    const hasFailureDetails =
      hasNonEmptyText(row.error) || hasNonEmptyText(row.raw_output_redacted);

    if (row.status === "completed" && hasResultMarkdown) {
      return 1;
    }
    if ((row.status === "failed" || row.status === "timed_out") && hasFailureDetails) {
      return 2;
    }
    if (["completed", "failed", "timed_out", "cancelled"].includes(row.status)) {
      return 3;
    }
    if (row.status === "running") {
      return 4;
    }
    return 5;
  };

  const compareNullableDate = (left: Date | string | null, right: Date | string | null): number => {
    if (left == null && right == null) {
      return 0;
    }
    if (left == null) {
      return 1;
    }
    if (right == null) {
      return -1;
    }
    return new Date(left).getTime() - new Date(right).getTime();
  };

  const compareNullableNumber = (left: string | number | null, right: string | number | null): number => {
    if (left == null && right == null) {
      return 0;
    }
    if (left == null) {
      return 1;
    }
    if (right == null) {
      return -1;
    }
    return Number(left) - Number(right);
  };

  const compareCanonicalCandidates = (left: AgentTaskRepairRow, right: AgentTaskRepairRow): number => {
    return (
      taskPriority(left) - taskPriority(right) ||
      compareNullableDate(left.completed_at, right.completed_at) ||
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
      compareNullableNumber(left.created_order, right.created_order) ||
      left.id.localeCompare(right.id)
    );
  };

  const canonicalTaskByTriggerKey = new Map<string, AgentTaskRepairRow>();
  const duplicateTaskIdsByTriggerKey = new Map<string, string[]>();

  for (const row of taskResult.rows) {
    const key = triggerKey(row);
    const currentCanonical = canonicalTaskByTriggerKey.get(key);

    if (currentCanonical == null) {
      canonicalTaskByTriggerKey.set(key, row);
      continue;
    }

    if (compareCanonicalCandidates(row, currentCanonical) < 0) {
      const duplicateTaskIds = duplicateTaskIdsByTriggerKey.get(key) ?? [];
      duplicateTaskIds.push(currentCanonical.id);
      duplicateTaskIdsByTriggerKey.set(key, duplicateTaskIds);
      canonicalTaskByTriggerKey.set(key, row);
      continue;
    }

    const duplicateTaskIds = duplicateTaskIdsByTriggerKey.get(key) ?? [];
    duplicateTaskIds.push(row.id);
    duplicateTaskIdsByTriggerKey.set(key, duplicateTaskIds);
  }

  for (const canonicalTask of canonicalTaskByTriggerKey.values()) {
    await db.query(
      `
        update chat_message
        set task_id = $2
        where id = $1
          and role = 'user'
          and (task_id is null or task_id <> $2)
      `,
      [canonicalTask.trigger_message_id, canonicalTask.id]
    );

    const duplicateTaskIds = duplicateTaskIdsByTriggerKey.get(triggerKey(canonicalTask)) ?? [];
    if (duplicateTaskIds.length === 0) {
      continue;
    }

    const mergedTask = duplicateTaskIds.reduce<AgentTaskRepairRow>((current, duplicateTaskId) => {
      const duplicateTask = taskRowById.get(duplicateTaskId);
      if (duplicateTask == null) {
        return current;
      }

      return {
        ...current,
        session_id: hasNonEmptyText(current.session_id)
          ? current.session_id
          : hasNonEmptyText(duplicateTask.session_id)
            ? duplicateTask.session_id
            : current.session_id,
        work_dir: hasNonEmptyText(current.work_dir)
          ? current.work_dir
          : hasNonEmptyText(duplicateTask.work_dir)
            ? duplicateTask.work_dir
            : current.work_dir,
        result_markdown: hasNonEmptyText(current.result_markdown)
          ? current.result_markdown
          : hasNonEmptyText(duplicateTask.result_markdown)
            ? duplicateTask.result_markdown
            : current.result_markdown,
        raw_output_redacted: hasNonEmptyText(current.raw_output_redacted)
          ? current.raw_output_redacted
          : hasNonEmptyText(duplicateTask.raw_output_redacted)
            ? duplicateTask.raw_output_redacted
            : current.raw_output_redacted,
        error: hasNonEmptyText(current.error)
          ? current.error
          : hasNonEmptyText(duplicateTask.error)
            ? duplicateTask.error
            : current.error,
        started_at: current.started_at ?? duplicateTask.started_at,
        completed_at: current.completed_at ?? duplicateTask.completed_at
      };
    }, canonicalTask);

    await db.query(
      `
        update agent_tasks
        set session_id = $2,
            work_dir = $3,
            result_markdown = $4,
            raw_output_redacted = $5,
            error = $6,
            started_at = $7,
            completed_at = $8
        where id = $1
      `,
      [
        canonicalTask.id,
        mergedTask.session_id,
        mergedTask.work_dir,
        mergedTask.result_markdown,
        mergedTask.raw_output_redacted,
        mergedTask.error,
        mergedTask.started_at,
        mergedTask.completed_at
      ]
    );

    await db.query(
      `
        update chat_message
        set task_id = $2
        where task_id = any($1::text[])
      `,
      [duplicateTaskIds, canonicalTask.id]
    );

    const maxSeqResult = await db.query<{ max_seq: number | null }>(
      `
        select max(seq) as max_seq
        from task_message
        where task_id = $1
      `,
      [canonicalTask.id]
    );
    const duplicateTaskMessages = await db.query<{ id: string }>(
      `
        select id
        from task_message
        where task_id = any($1::text[])
        order by seq asc, created_at asc, id asc
      `,
      [duplicateTaskIds]
    );

    let nextSeq = (maxSeqResult.rows[0]?.max_seq ?? -1) + 1;
    for (const taskMessage of duplicateTaskMessages.rows) {
      await db.query(
        `
          update task_message
          set task_id = $2,
              seq = $3
          where id = $1
        `,
        [taskMessage.id, canonicalTask.id, nextSeq]
      );
      nextSeq += 1;
    }
  }

  for (const duplicateTaskIds of duplicateTaskIdsByTriggerKey.values()) {
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

async function seedDefaultAgent(db: Queryable): Promise<void> {
  const existing = await db.query<{ id: string }>(`select id from agents where id = 'default'`);
  if (existing.rows.length > 0) {
    return;
  }

  const config = await db.query<{ agent_spec: unknown }>(
    `select agent_spec from default_agent_config where id = 'default'`
  );

  let sourceSpec: Record<string, unknown> | null = null;
  if (config.rows[0]) {
    sourceSpec = config.rows[0].agent_spec as Record<string, unknown>;
  } else {
    const fallback = await db.query<{ agent_spec_snapshot: unknown }>(
      `
        select agent_spec_snapshot
        from chat_session
        where agent_spec_snapshot is not null
        order by created_at asc, id asc
        limit 1
      `
    );
    if (fallback.rows[0]?.agent_spec_snapshot) {
      sourceSpec = fallback.rows[0].agent_spec_snapshot as Record<string, unknown>;
    }
  }

  if (!sourceSpec) {
    return;
  }

  const identity = (sourceSpec.identity ?? {}) as Record<string, string>;
  await db.query(
    `insert into agents (id, name, description, spec) values ($1, $2, $3, $4)`,
    ["default", identity.name ?? "Research Agent", identity.description ?? "Default agent", JSON.stringify(sourceSpec)]
  );
}

async function installChatSessionAgentDefaults(db: Queryable): Promise<boolean> {
  try {
    await db.query(`
      create or replace function set_chat_session_agent_defaults()
      returns trigger as $$
      declare
        fallback_agent_id text;
      begin
        if new.agent_name is null and new.agent_spec_snapshot is not null then
          new.agent_name := new.agent_spec_snapshot -> 'identity' ->> 'name';
        end if;

        if new.agent_id is null then
          select id into fallback_agent_id
          from agents
          where id = 'default'
          limit 1;

          if fallback_agent_id is null and new.agent_spec_snapshot is not null then
            insert into agents (id, name, description, spec)
            values (
              'default',
              coalesce(new.agent_spec_snapshot -> 'identity' ->> 'name', 'Research Agent'),
              coalesce(new.agent_spec_snapshot -> 'identity' ->> 'description', 'Default agent'),
              new.agent_spec_snapshot
            )
            on conflict (id) do nothing;
            fallback_agent_id := 'default';
          end if;

          new.agent_id := fallback_agent_id;
        end if;

        if new.agent_name is null and new.agent_id is not null then
          select name into new.agent_name
          from agents
          where id = new.agent_id;
        end if;

        return new;
      end;
      $$ language plpgsql
    `);

    await db.query(`
      drop trigger if exists trg_chat_session_agent_defaults on chat_session
    `);

    await db.query(`
      create trigger trg_chat_session_agent_defaults
      before insert on chat_session
      for each row
      execute function set_chat_session_agent_defaults()
    `);

    return true;
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error) && !isPgMemUnknownLanguage(error)) {
      throw error;
    }
    return false;
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
    "agents",
    `
    create table if not exists agents (
      id text primary key,
      name text not null,
      description text not null,
      spec jsonb not null,
      created_at timestamptz not null default now(),
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
      agent_id text references agents(id),
      agent_name text,
      agent_spec_snapshot jsonb,
      last_message_preview text,
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

  await addColumnIfNeeded(
    db,
    "agent_tasks",
    "tool_policy_snapshot",
    `
      alter table agent_tasks
      add column if not exists tool_policy_snapshot jsonb
    `
  );

  await createTableIfNeeded(
    db,
    "agent_task_leases",
    `
      create table if not exists agent_task_leases (
        id text primary key,
        agent_task_id text not null references agent_tasks(id) on delete cascade,
        token_hash text not null unique,
        issuer text not null,
        audience text not null,
        status text not null,
        sandbox_id text,
        expires_at timestamptz not null,
        absolute_expires_at timestamptz not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `
  );

  await createTableIfNeeded(
    db,
    "connected_accounts",
    `
      create table if not exists connected_accounts (
        id text primary key,
        workspace_id text not null,
        app_id text not null,
        account_label text not null,
        external_account_id text not null,
        status text not null check (status in ('connected', 'disconnected')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (workspace_id, app_id, external_account_id)
      )
    `
  );

  await createTableIfNeeded(
    db,
    "connected_account_agents",
    `
      create table if not exists connected_account_agents (
        connected_account_id text not null references connected_accounts(id) on delete cascade,
        agent_id text not null references agents(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (connected_account_id, agent_id)
      )
    `
  );

  await createTableIfNeeded(
    db,
    "tool_configurations",
    `
      create table if not exists tool_configurations (
        id text primary key,
        agent_id text not null references agents(id) on delete cascade,
        connected_account_id text not null references connected_accounts(id) on delete cascade,
        app_id text not null,
        tool_name text not null,
        mode text not null check (mode in ('auto', 'ask_each_time', 'disabled')),
        sync_status text not null default 'synced' check (sync_status in ('syncing', 'synced', 'sync_failed')),
        sync_error text,
        sync_version text,
        last_synced_mode text check (last_synced_mode in ('auto', 'ask_each_time', 'disabled')),
        last_synced_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (agent_id, connected_account_id, tool_name)
      )
    `
  );

  await createTableIfNeeded(
    db,
    "tool_call_audit_logs",
    `
      create table if not exists tool_call_audit_logs (
        id text primary key,
        agent_task_id text not null references agent_tasks(id) on delete cascade,
        chat_session_id text not null references chat_session(id) on delete cascade,
        agent_id text not null references agents(id) on delete cascade,
        connected_account_id text references connected_accounts(id) on delete set null,
        provider text not null,
        mcp_tool_name text not null,
        provider_tool_name text,
        mode text,
        args_redacted jsonb,
        status text not null,
        error text,
        created_at timestamptz not null default now()
      )
    `
  );

  await createTableIfNeeded(
    db,
    "tool_confirmations",
    `
      create table if not exists tool_confirmations (
        id text primary key,
        agent_task_id text not null references agent_tasks(id) on delete cascade,
        chat_session_id text not null references chat_session(id) on delete cascade,
        agent_id text not null references agents(id) on delete cascade,
        connected_account_id text not null references connected_accounts(id) on delete cascade,
        provider text not null,
        mcp_tool_name text not null,
        provider_tool_name text not null,
        args_hash text not null,
        args_encrypted text,
        preview_json jsonb not null default '{}'::jsonb,
        status text not null check (status in ('pending', 'approved', 'denied', 'expired', 'revoked')),
        expires_at timestamptz not null,
        resolved_at timestamptz,
        created_at timestamptz not null default now()
      )
    `
  );

  await db.query(`
    update connected_accounts
    set app_id = 'github'
    where app_id = 'mock-github'
  `);

  await db.query(`
    update tool_configurations
    set app_id = 'github'
    where app_id = 'mock-github'
  `);

  await db.query(`
    update tool_configurations
    set tool_name = 'github_list_issues'
    where app_id = 'github'
      and tool_name = 'github_search_issues'
  `);

  await createNonUniqueIndexIfNeeded(
    db,
    "idx_agent_task_leases_agent_task_id",
    `
      create index if not exists idx_agent_task_leases_agent_task_id
      on agent_task_leases(agent_task_id)
    `
  );

  await createNonUniqueIndexIfNeeded(
    db,
    "idx_tool_confirmations_chat_session_status",
    `
      create index if not exists idx_tool_confirmations_chat_session_status
      on tool_confirmations(chat_session_id, status)
    `
  );

  await addColumnIfNeeded(
    db,
    "tool_configurations",
    "sync_status",
    `
    alter table tool_configurations
    add column if not exists sync_status text not null default 'synced' check (sync_status in ('syncing', 'synced', 'sync_failed'))
  `
  );

  await addColumnIfNeeded(
    db,
    "tool_configurations",
    "sync_error",
    `
    alter table tool_configurations
    add column if not exists sync_error text
  `
  );

  await addColumnIfNeeded(
    db,
    "tool_configurations",
    "sync_version",
    `
    alter table tool_configurations
    add column if not exists sync_version text
  `
  );

  await addColumnIfNeeded(
    db,
    "tool_configurations",
    "last_synced_mode",
    `
    alter table tool_configurations
    add column if not exists last_synced_mode text check (last_synced_mode in ('auto', 'ask_each_time', 'disabled'))
  `
  );

  await addColumnIfNeeded(
    db,
    "tool_configurations",
    "last_synced_at",
    `
    alter table tool_configurations
    add column if not exists last_synced_at timestamptz
  `
  );

  await db.query(`
    update tool_configurations
    set last_synced_mode = mode,
        last_synced_at = coalesce(last_synced_at, updated_at)
    where sync_status = 'synced'
      and last_synced_mode is null
  `);

  await addColumnIfNeeded(
    db,
    "agents",
    "encrypted_api_key",
    `
    alter table agents
    add column if not exists encrypted_api_key text
  `
  );

  await backfillCreatedOrder(db, "chat_message");
  await backfillCreatedOrder(db, "agent_tasks");

  await repairAgentTaskTriggerLinks(db);

  await addColumnIfNeeded(
    db,
    "chat_session",
    "agent_id",
    `
    alter table chat_session
    add column if not exists agent_id text references agents(id)
  `
  );

  await addColumnIfNeeded(
    db,
    "chat_session",
    "agent_name",
    `
    alter table chat_session
    add column if not exists agent_name text
  `
  );

  await addColumnIfNeeded(
    db,
    "chat_session",
    "last_message_preview",
    `
    alter table chat_session
    add column if not exists last_message_preview text
  `
  );

  await db.query(`
    update chat_session
    set agent_name = agent_spec_snapshot -> 'identity' ->> 'name'
    where agent_name is null
      and agent_spec_snapshot is not null
  `);

  await seedDefaultAgent(db);

  await db.query(`
    update chat_session
    set agent_id = 'default'
    where agent_id is null
  `);

  const agentDefaultsInstalled = await installChatSessionAgentDefaults(db);

  if (agentDefaultsInstalled) {
    try {
      await db.query(`
        alter table chat_session
        alter column agent_id set not null
      `);
    } catch (error) {
      if (!isPgMemUnsupportedIfNotExists(error)) {
        throw error;
      }
    }
  }

  try {
    await db.query(`
      alter table chat_session
      alter column agent_spec_snapshot drop not null
    `);
  } catch (error) {
    if (!isPgMemUnsupportedIfNotExists(error)) {
      throw error;
    }
  }

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
