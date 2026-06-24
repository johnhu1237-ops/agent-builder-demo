import { nanoid } from "nanoid";
import type { Pool, PoolClient } from "pg";
import {
  defaultAgentSpec,
  exportAgentSpec,
  type AgentSpec,
  type AgentTask,
  type AgentTaskStatus,
  type ChatMessage,
  type ChatMessageRole,
  type ChatSession,
  type ChatSessionDetail,
  type RunnerTaskMessage,
  type TaskMessage
} from "@agent-builder/shared";
import { redactSecrets, redactUnknownJson } from "./redaction";

type Queryable = Pool | PoolClient;

type ChatSessionRow = {
  id: string;
  agent_spec_snapshot: AgentSpec;
  title: string;
  session_id: string | null;
  work_dir: string | null;
  status: ChatSession["status"];
  created_at: Date | string;
  updated_at: Date | string;
};

type ChatMessageRow = {
  id: string;
  chat_session_id: string;
  role: ChatMessageRole;
  content_markdown: string;
  task_id: string | null;
  created_at: Date | string;
};

type AgentTaskRow = {
  id: string;
  chat_session_id: string;
  trigger_message_id: string;
  agent_spec_snapshot: AgentSpec;
  status: AgentTaskStatus;
  session_id: string | null;
  work_dir: string | null;
  result_markdown: string | null;
  raw_output_redacted: string | null;
  error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

type TaskMessageRow = {
  id: string;
  task_id: string;
  seq: number;
  type: TaskMessage["type"];
  tool: string | null;
  content: string;
  input_json: unknown | null;
  output: string | null;
  created_at: Date | string;
};

const terminalTaskStatuses = new Set<AgentTaskStatus>(["completed", "failed", "timed_out", "cancelled"]);

type CompleteAgentTaskInput = {
  status: "completed";
  resultMarkdown: string;
  rawOutputRedacted: string;
  sessionId: string | null;
  workDir: string | null;
  taskMessages: RunnerTaskMessage[];
};

type FailAgentTaskInput = {
  status: Exclude<AgentTaskStatus, "pending" | "running" | "completed" | "cancelled">;
  error: string;
  rawOutputRedacted: string;
  sessionId: string | null;
  workDir: string | null;
  taskMessages: RunnerTaskMessage[];
};

function toIsoString(value: Date | string | null): string | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapChatSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    agentSpecSnapshot: row.agent_spec_snapshot,
    title: row.title,
    sessionId: row.session_id,
    workDir: row.work_dir,
    status: row.status,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
  };
}

function mapChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    role: row.role,
    contentMarkdown: row.content_markdown,
    taskId: row.task_id,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
  };
}

function mapAgentTask(row: AgentTaskRow): AgentTask {
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
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    startedAt: toIsoString(row.started_at),
    completedAt: toIsoString(row.completed_at)
  };
}

function mapTaskMessage(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    seq: row.seq,
    type: row.type,
    tool: row.tool,
    content: row.content,
    inputJson: row.input_json,
    output: row.output,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString()
  };
}

function redactTaskMessage(message: RunnerTaskMessage): RunnerTaskMessage {
  return {
    ...message,
    content: redactSecrets(message.content),
    inputJson: redactUnknownJson(message.inputJson),
    output: message.output == null ? null : redactSecrets(message.output)
  };
}

async function insertTaskMessages(db: Queryable, taskId: string, messages: RunnerTaskMessage[]): Promise<void> {
  for (const [index, message] of messages.entries()) {
    const sanitizedMessage = redactTaskMessage(message);
    await db.query(
      `
        insert into task_message (id, task_id, seq, type, tool, content, input_json, output)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        nanoid(),
        taskId,
        index,
        sanitizedMessage.type,
        sanitizedMessage.tool,
        sanitizedMessage.content,
        sanitizedMessage.inputJson,
        sanitizedMessage.output
      ]
    );
  }
}

function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return terminalTaskStatuses.has(status);
}

function isUniqueTriggerTaskInsertError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === "uq_agent_tasks_trigger_message_id";
}

async function getTaskById(db: Queryable, taskId: string): Promise<AgentTaskRow | null> {
  const result = await db.query<AgentTaskRow>(
    `
      select *
      from agent_tasks
      where id = $1
    `,
    [taskId]
  );

  return result.rows[0] ?? null;
}

function missingTriggerMessageError(triggerMessageId: string, chatSessionId: string): Error {
  return new Error(`Trigger message ${triggerMessageId} was not found in chat session ${chatSessionId}`);
}

function linkedTaskCorruptionError(triggerMessageId: string, linkedTaskId: string, linkedTaskTriggerMessageId: string): Error {
  return new Error(
    `Corrupt trigger message link: chat_message ${triggerMessageId} points to task ${linkedTaskId} for trigger ${linkedTaskTriggerMessageId}`
  );
}

export class PgChatStore {
  constructor(private readonly pool: Pool) {}

  async getDefaultAgentSpec(): Promise<AgentSpec> {
    const result = await this.pool.query<{ agent_spec: AgentSpec }>(
      `
        select agent_spec
        from default_agent_config
        where id = $1
      `,
      ["default"]
    );

    return result.rows[0]?.agent_spec ?? defaultAgentSpec;
  }

  async saveDefaultAgentSpec(agentSpec: AgentSpec): Promise<AgentSpec> {
    const snapshot = exportAgentSpec(agentSpec);
    await this.pool.query(
      `
        insert into default_agent_config (id, agent_spec, updated_at)
        values ($1, $2, now())
        on conflict (id) do update
        set agent_spec = excluded.agent_spec,
            updated_at = now()
      `,
      ["default", snapshot]
    );
    return snapshot;
  }

  async createChatSession(input: { agentSpec: AgentSpec; title: string }): Promise<ChatSession> {
    const result = await this.pool.query<ChatSessionRow>(
      `
        insert into chat_session (id, agent_spec_snapshot, title, status)
        values ($1, $2, $3, 'active')
        returning *
      `,
      [nanoid(), exportAgentSpec(input.agentSpec), input.title]
    );

    return mapChatSession(result.rows[0]);
  }

  async listChatSessions(): Promise<ChatSession[]> {
    const result = await this.pool.query<ChatSessionRow>(
      `
        select *
        from chat_session
        order by updated_at desc, created_at desc, id desc
      `
    );

    return result.rows.map(mapChatSession);
  }

  async getChatSessionDetail(id: string): Promise<ChatSessionDetail | null> {
    const sessionResult = await this.pool.query<ChatSessionRow>(
      `
        select *
        from chat_session
        where id = $1
      `,
      [id]
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) {
      return null;
    }

    const messagesResult = await this.pool.query<ChatMessageRow>(
      `
        select *
        from chat_message
        where chat_session_id = $1
        order by created_at asc, created_order asc nulls last, id asc
      `,
      [id]
    );
    const latestTaskResult = await this.pool.query<AgentTaskRow>(
      `
        select *
        from agent_tasks
        where chat_session_id = $1
        order by created_at desc, created_order desc nulls last, id desc
        limit 1
      `,
      [id]
    );

    const latestTask = latestTaskResult.rows[0] ? mapAgentTask(latestTaskResult.rows[0]) : null;
    const taskMessagesResult = latestTask
      ? await this.pool.query<TaskMessageRow>(
          `
            select *
            from task_message
            where task_id = $1
            order by seq asc
          `,
          [latestTask.id]
        )
      : { rows: [] as TaskMessageRow[] };

    return {
      ...mapChatSession(sessionRow),
      messages: messagesResult.rows.map(mapChatMessage),
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
    const result = await this.pool.query<ChatMessageRow>(
      `
        insert into chat_message (id, chat_session_id, role, content_markdown, task_id)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [nanoid(), input.chatSessionId, input.role, input.contentMarkdown, input.taskId]
    );
    await this.touchChatSession(input.chatSessionId);
    return mapChatMessage(result.rows[0]);
  }

  async createAgentTask(input: {
    chatSessionId: string;
    triggerMessageId: string;
    agentSpec: AgentSpec;
  }): Promise<AgentTask> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const triggerMessageResult = await client.query<{ id: string; role: ChatMessageRole; task_id: string | null }>(
        `
          select id, role, task_id
          from chat_message
          where id = $1
            and chat_session_id = $2
          for update
        `,
        [input.triggerMessageId, input.chatSessionId]
      );

      if (!triggerMessageResult.rows[0]) {
        throw missingTriggerMessageError(input.triggerMessageId, input.chatSessionId);
      }

      if (triggerMessageResult.rows[0].role !== "user") {
        throw new Error(`Trigger message must be a user message: ${input.triggerMessageId}`);
      }

      const existingTaskId = triggerMessageResult.rows[0].task_id;
      if (existingTaskId) {
        const existingTaskResult = await client.query<AgentTaskRow>(
          `
            select *
            from agent_tasks
            where id = $1
              and chat_session_id = $2
          `,
          [existingTaskId, input.chatSessionId]
        );

        if (existingTaskResult.rows[0]) {
          if (existingTaskResult.rows[0].trigger_message_id !== input.triggerMessageId) {
            throw linkedTaskCorruptionError(
              input.triggerMessageId,
              existingTaskId,
              existingTaskResult.rows[0].trigger_message_id
            );
          }
          await client.query("commit");
          return mapAgentTask(existingTaskResult.rows[0]);
        }

        throw new Error(`Linked agent task not found for trigger message: ${input.triggerMessageId}`);
      }

      const taskId = nanoid();
      let taskRow: AgentTaskRow;

      try {
        const result = await client.query<AgentTaskRow>(
          `
            insert into agent_tasks (id, chat_session_id, trigger_message_id, agent_spec_snapshot, status)
            values ($1, $2, $3, $4, 'pending')
            returning *
          `,
          [taskId, input.chatSessionId, input.triggerMessageId, exportAgentSpec(input.agentSpec)]
        );
        taskRow = result.rows[0];
      } catch (error) {
        if (!isUniqueTriggerTaskInsertError(error)) {
          throw error;
        }

        const existingTaskResult = await client.query<AgentTaskRow>(
          `
            select *
            from agent_tasks
            where trigger_message_id = $1
              and chat_session_id = $2
          `,
          [input.triggerMessageId, input.chatSessionId]
        );

        if (existingTaskResult.rows[0]) {
          await client.query(
            `
              update chat_message
              set task_id = $3
              where id = $1
                and chat_session_id = $2
                and task_id is null
            `,
            [input.triggerMessageId, input.chatSessionId, existingTaskResult.rows[0].id]
          );
          await client.query("commit");
          return mapAgentTask(existingTaskResult.rows[0]);
        }

        throw error;
      }

      const messageUpdate = await client.query(
        `
          update chat_message
          set task_id = $3
          where id = $1
            and chat_session_id = $2
        `,
        [input.triggerMessageId, input.chatSessionId, taskId]
      );

      if (messageUpdate.rowCount !== 1) {
        throw missingTriggerMessageError(input.triggerMessageId, input.chatSessionId);
      }

      await client.query(
        `
          update chat_session
          set updated_at = now()
          where id = $1
        `,
        [input.chatSessionId]
      );

      await client.query("commit");
      return mapAgentTask(taskRow);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAgentTaskRunning(taskId: string): Promise<AgentTask | null> {
    const currentTask = await getTaskById(this.pool, taskId);
    if (!currentTask) {
      return null;
    }
    if (currentTask.status === "running" || isTerminalTaskStatus(currentTask.status)) {
      return mapAgentTask(currentTask);
    }

    const result = await this.pool.query<AgentTaskRow>(
      `
        update agent_tasks
        set status = 'running',
            started_at = coalesce(started_at, now())
        where id = $1
          and status = 'pending'
        returning *
      `,
      [taskId]
    );

    const row = result.rows[0];
    if (!row) {
      return mapAgentTask((await getTaskById(this.pool, taskId)) ?? currentTask);
    }
    await this.touchChatSession(row.chat_session_id);
    return mapAgentTask(row);
  }

  async completeAgentTask(taskId: string, input: CompleteAgentTaskInput): Promise<AgentTask> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const redactedResultMarkdown = redactSecrets(input.resultMarkdown);
      const redactedRawOutput = redactSecrets(input.rawOutputRedacted);
      const currentTask = await getTaskById(client, taskId);
      if (!currentTask) {
        throw new Error(`Agent task not found: ${taskId}`);
      }
      if (isTerminalTaskStatus(currentTask.status)) {
        await client.query("commit");
        return mapAgentTask(currentTask);
      }

      const taskResult = await client.query<AgentTaskRow>(
        `
          update agent_tasks
          set status = $2,
              result_markdown = $3,
              raw_output_redacted = $4,
              error = null,
              session_id = coalesce($5, session_id),
              work_dir = coalesce($6, work_dir),
              started_at = coalesce(started_at, now()),
              completed_at = now()
          where id = $1
            and status in ('pending', 'running')
          returning *
        `,
        [taskId, input.status, redactedResultMarkdown, redactedRawOutput, input.sessionId, input.workDir]
      );

      const taskRow = taskResult.rows[0];
      if (!taskRow) {
        const existingTask = await getTaskById(client, taskId);
        if (!existingTask) {
          throw new Error(`Agent task not found: ${taskId}`);
        }
        await client.query("commit");
        return mapAgentTask(existingTask);
      }

      await insertTaskMessages(client, taskId, input.taskMessages);
      await client.query(
        `
          insert into chat_message (id, chat_session_id, role, content_markdown, task_id)
          values ($1, $2, 'assistant', $3, $4)
        `,
        [nanoid(), taskRow.chat_session_id, redactedResultMarkdown, taskId]
      );
      await client.query(
        `
          update chat_session
          set session_id = coalesce($2, session_id),
              work_dir = coalesce($3, work_dir),
              updated_at = now()
          where id = $1
        `,
        [taskRow.chat_session_id, input.sessionId, input.workDir]
      );
      await client.query("commit");
      return mapAgentTask(taskRow);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async failAgentTask(taskId: string, input: FailAgentTaskInput): Promise<AgentTask> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const redactedError = redactSecrets(input.error);
      const redactedRawOutput = redactSecrets(input.rawOutputRedacted);
      const currentTask = await getTaskById(client, taskId);
      if (!currentTask) {
        throw new Error(`Agent task not found: ${taskId}`);
      }
      if (isTerminalTaskStatus(currentTask.status)) {
        await client.query("commit");
        return mapAgentTask(currentTask);
      }

      const taskResult = await client.query<AgentTaskRow>(
        `
          update agent_tasks
          set status = $2,
              error = $3,
              raw_output_redacted = $4,
              session_id = coalesce($5, session_id),
              work_dir = coalesce($6, work_dir),
              started_at = coalesce(started_at, now()),
              completed_at = now()
          where id = $1
            and status in ('pending', 'running')
          returning *
        `,
        [taskId, input.status, redactedError, redactedRawOutput, input.sessionId, input.workDir]
      );

      const taskRow = taskResult.rows[0];
      if (!taskRow) {
        const existingTask = await getTaskById(client, taskId);
        if (!existingTask) {
          throw new Error(`Agent task not found: ${taskId}`);
        }
        await client.query("commit");
        return mapAgentTask(existingTask);
      }

      await insertTaskMessages(client, taskId, input.taskMessages);
      await client.query(
        `
          update chat_session
          set session_id = coalesce($2, session_id),
              work_dir = coalesce($3, work_dir),
              updated_at = now()
          where id = $1
        `,
        [taskRow.chat_session_id, input.sessionId, input.workDir]
      );
      await client.query("commit");
      return mapAgentTask(taskRow);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateChatSessionResumePointers(
    id: string,
    input: {
      sessionId: string | null;
      workDir: string | null;
    }
  ): Promise<void> {
    await this.pool.query(
      `
        update chat_session
        set session_id = coalesce($2, session_id),
            work_dir = coalesce($3, work_dir),
            updated_at = now()
        where id = $1
      `,
      [id, input.sessionId, input.workDir]
    );
  }

  private async touchChatSession(chatSessionId: string): Promise<void> {
    await this.pool.query(
      `
        update chat_session
        set updated_at = now()
        where id = $1
      `,
      [chatSessionId]
    );
  }
}
