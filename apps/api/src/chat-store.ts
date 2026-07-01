import { createHash, createHmac, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import type { Pool, PoolClient } from "pg";
import {
  defaultAgentSpec,
  exportAgentSpec,
  type Agent,
  type AgentSpec,
  type AgentTask,
  type AgentTaskStatus,
  type ChatMessage,
  type ChatMessageRole,
  type ChatSession,
  type ChatSessionDetail,
  type ConnectedAppState,
  type CreateAgentRequest,
  type RunnerTaskMessage,
  type TaskMessage,
  type ToolConfirmation,
  type ToolConfiguration as SharedToolConfiguration,
  type ToolConfigurationSyncStatus,
  type ToolConfirmationStatus,
  type UpdateAgentRequest
} from "@agent-builder/shared";
import { redactSecrets, redactUnknownJson } from "./redaction";
import { encryptApiKey } from "./encryption";

type Queryable = Pool | PoolClient;

type ChatSessionRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_spec_snapshot: AgentSpec | null;
  last_message_preview: string | null;
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

type AgentRow = {
  id: string;
  name: string;
  description: string;
  spec: AgentSpec;
  encrypted_api_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ConnectedAccountRow = {
  id: string;
  workspace_id: string;
  app_id: string;
  account_label: string;
  external_account_id: string;
  status: ConnectedAccount["status"];
  created_at: Date | string;
  updated_at: Date | string;
};

type ToolConfigurationRow = {
  id: string;
  agent_id: string;
  connected_account_id: string;
  app_id: string;
  tool_name: string;
  mode: ToolConfigurationMode;
  sync_status: ToolConfigurationSyncStatus;
  sync_error: string | null;
  sync_version: string | null;
  last_synced_mode: ToolConfigurationMode | null;
  last_synced_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ToolConfigurationWithAccountRow = ToolConfigurationRow & {
  external_account_id: string;
  connected_account_status: ConnectedAccount["status"];
};

type ToolConfirmationRow = {
  id: string;
  agent_task_id: string;
  chat_session_id: string;
  agent_id: string;
  connected_account_id: string;
  provider: string;
  mcp_tool_name: string;
  provider_tool_name: string;
  args_hash: string;
  preview_json: unknown;
  status: ToolConfirmationStatus;
  expires_at: Date | string;
  resolved_at: Date | string | null;
  created_at: Date | string;
};

export type IssuedAgentTaskLease = {
  id: string;
  token: string;
};

export type ValidatedAgentTaskLease = {
  id: string;
  agentTaskId: string;
  chatSessionId: string;
  agentId: string;
  agentSpec: AgentSpec;
};

export type AgentWithSecret = Agent & { encryptedApiKey: string | null };
export type ToolConfigurationMode = "auto" | "ask_each_time" | "disabled";

export type ConnectedAccount = {
  id: string;
  workspaceId: string;
  appId: string;
  accountLabel: string;
  externalAccountId: string;
  status: "connected" | "disconnected";
  createdAt: string;
  updatedAt: string;
};

export type ToolConfiguration = SharedToolConfiguration;

export type ToolConfigurationWithAccount = ToolConfiguration & {
  externalAccountId: string;
  connectedAccountStatus: ConnectedAccount["status"];
};

export type CreateConnectedAccountInput = {
  workspaceId: string;
  appId: string;
  accountLabel: string;
  externalAccountId: string;
  agentIds: string[];
};

export type UpdateToolConfigurationModeInput = {
  agentId: string;
  toolConfigurationId: string;
  mode: ToolConfigurationMode;
};

export type CompleteToolConfigurationSyncInput = {
  agentId: string;
  toolConfigurationId: string;
  syncVersion?: string | null;
};

export type FailToolConfigurationSyncInput = {
  agentId: string;
  toolConfigurationId: string;
  error: string;
};

export type RecordToolCallAuditInput = {
  agentTaskId: string;
  chatSessionId: string;
  agentId: string;
  connectedAccountId: string | null;
  provider: string;
  mcpToolName: string;
  providerToolName: string | null;
  mode: ToolConfigurationMode | null;
  args: unknown;
  status: "allowed" | "denied" | "confirmation_required" | "executed" | "failed" | "timed_out";
  error?: string | null;
};

export type CreateToolConfirmationInput = {
  agentTaskId: string;
  chatSessionId: string;
  agentId: string;
  connectedAccountId: string;
  provider: string;
  mcpToolName: string;
  providerToolName: string;
  args: unknown;
  expiresAt: Date;
};

const terminalTaskStatuses = new Set<AgentTaskStatus>(["completed", "failed", "timed_out", "cancelled"]);
const toolConfigurationModes = new Set<ToolConfigurationMode>(["auto", "ask_each_time", "disabled"]);
const seededConnectorTools: Record<string, string[]> = {
  "github": ["github_search_issues", "github_create_issue"],
  "mock-slack": ["slack_post_message"],
  "mock-notion": ["notion_create_page"]
};

const githubConnectedAppTemplate = {
  appId: "github",
  provider: "github" as const,
  label: "GitHub",
  description: "Connect GitHub issues to Agent Tasks through the product MCP gateway."
};

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
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentSpecSnapshot: row.agent_spec_snapshot,
    lastMessagePreview: row.last_message_preview,
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

function mapAgent(row: AgentRow): AgentWithSecret {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    spec: row.spec,
    hasApiKey: Boolean(row.encrypted_api_key),
    encryptedApiKey: row.encrypted_api_key ?? null,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
  };
}

function mapConnectedAccount(row: ConnectedAccountRow): ConnectedAccount {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    appId: row.app_id,
    accountLabel: row.account_label,
    externalAccountId: row.external_account_id,
    status: row.status,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
  };
}

function mapToolConfiguration(row: ToolConfigurationRow): ToolConfiguration {
  return {
    id: row.id,
    agentId: row.agent_id,
    connectedAccountId: row.connected_account_id,
    appId: row.app_id,
    toolName: row.tool_name,
    mode: row.mode,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    syncVersion: row.sync_version,
    lastSyncedMode: row.last_synced_mode,
    lastSyncedAt: toIsoString(row.last_synced_at),
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString()
  };
}

function mapToolConfigurationWithAccount(row: ToolConfigurationWithAccountRow): ToolConfigurationWithAccount {
  return {
    ...mapToolConfiguration(row),
    externalAccountId: row.external_account_id,
    connectedAccountStatus: row.connected_account_status
  };
}

function mapToolConfirmation(row: ToolConfirmationRow): ToolConfirmation {
  return {
    id: row.id,
    agentTaskId: row.agent_task_id,
    chatSessionId: row.chat_session_id,
    agentId: row.agent_id,
    connectedAccountId: row.connected_account_id,
    provider: row.provider,
    mcpToolName: row.mcp_tool_name,
    providerToolName: row.provider_tool_name,
    argsHash: row.args_hash,
    previewJson: row.preview_json,
    status: row.status,
    expiresAt: toIsoString(row.expires_at) ?? new Date(0).toISOString(),
    resolvedAt: toIsoString(row.resolved_at),
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

function shouldUpdateResumePointerPair(input: { sessionId: string | null; workDir: string | null }): boolean {
  return Boolean(input.sessionId?.trim() && input.workDir?.trim());
}

function hasNonEmptyText(value: string | null): value is string {
  return value != null && value.trim().length > 0;
}

function assistantFailureMessage(status: FailAgentTaskInput["status"], error: string): string {
  if (status === "timed_out") {
    return "Task timed out.";
  }
  const trimmed = error.trim();
  return trimmed ? `Task failed: ${trimmed}` : "Task failed.";
}

function pickMissingText(current: string | null, incoming: string | null): string | null {
  if (hasNonEmptyText(current)) {
    return current;
  }
  return hasNonEmptyText(incoming) ? incoming : current;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function toolArgsHash(args: unknown): string {
  const secret = process.env.TOOL_CONFIRMATION_HMAC_SECRET ?? "agent-builder-demo-tool-confirmations";
  return createHmac("sha256", secret).update(canonicalJson(args)).digest("hex");
}

function createLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

async function insertTaskMessages(
  db: Queryable,
  taskId: string,
  messages: RunnerTaskMessage[]
): Promise<TaskMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  const nextSeqResult = await db.query<{ next_seq: number }>(
    `
      select coalesce(max(seq) + 1, 0) as next_seq
      from task_message
      where task_id = $1
    `,
    [taskId]
  );
  const startSeq = Number(nextSeqResult.rows[0]?.next_seq ?? 0);

  const inserted: TaskMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const sanitizedMessage = redactTaskMessage(message);
    const result = await db.query<TaskMessageRow>(
      `
        insert into task_message (id, task_id, seq, type, tool, content, input_json, output)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning *
      `,
      [
        nanoid(),
        taskId,
        startSeq + index,
        sanitizedMessage.type,
        sanitizedMessage.tool,
        sanitizedMessage.content,
        sanitizedMessage.inputJson,
        sanitizedMessage.output
      ]
    );
    inserted.push(mapTaskMessage(result.rows[0]));
  }
  return inserted;
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

async function fillTerminalTaskMetadata(
  db: Queryable,
  currentTask: AgentTaskRow,
  input: {
    sessionId: string | null;
    workDir: string | null;
    rawOutputRedacted: string | null;
    resultMarkdown?: string | null;
    error?: string | null;
  }
): Promise<AgentTaskRow> {
  const nextSessionId = pickMissingText(currentTask.session_id, input.sessionId);
  const nextWorkDir = pickMissingText(currentTask.work_dir, input.workDir);
  const nextRawOutput = pickMissingText(currentTask.raw_output_redacted, input.rawOutputRedacted);
  const nextResultMarkdown =
    currentTask.status === "completed"
      ? pickMissingText(currentTask.result_markdown, input.resultMarkdown ?? null)
      : currentTask.result_markdown;
  const nextError =
    currentTask.status === "failed" || currentTask.status === "timed_out"
      ? pickMissingText(currentTask.error, input.error ?? null)
      : currentTask.error;

  const shouldUpdateTask =
    nextSessionId !== currentTask.session_id ||
    nextWorkDir !== currentTask.work_dir ||
    nextRawOutput !== currentTask.raw_output_redacted ||
    nextResultMarkdown !== currentTask.result_markdown ||
    nextError !== currentTask.error;

  let taskRow = currentTask;

  if (shouldUpdateTask) {
    const updatedTask = await db.query<AgentTaskRow>(
      `
        update agent_tasks
        set session_id = $2,
            work_dir = $3,
            raw_output_redacted = $4,
            result_markdown = $5,
            error = $6
        where id = $1
        returning *
      `,
      [currentTask.id, nextSessionId, nextWorkDir, nextRawOutput, nextResultMarkdown, nextError]
    );

    taskRow = updatedTask.rows[0] ?? currentTask;
  }

  if (nextSessionId !== currentTask.session_id || nextWorkDir !== currentTask.work_dir) {
    const shouldUpdatePointers = shouldUpdateResumePointerPair({
      sessionId: nextSessionId,
      workDir: nextWorkDir
    });
    if (shouldUpdatePointers) {
      await db.query(
        `
          update chat_session
          set session_id = $2,
              work_dir = $3,
              updated_at = now()
          where id = $1
        `,
        [currentTask.chat_session_id, nextSessionId, nextWorkDir]
      );
    }
  }

  return taskRow;
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

  async createAgent(input: CreateAgentRequest): Promise<AgentWithSecret> {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) {
      throw new Error("API key is required");
    }
    const spec = input.spec ?? defaultAgentSpec;
    const sanitized = exportAgentSpec(spec);
    const name = spec.identity.name;
    const description = spec.identity.description;
    const encryptedApiKey = encryptApiKey(apiKey);

    const result = await this.pool.query<AgentRow>(
      `
        insert into agents (id, name, description, spec, encrypted_api_key)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [nanoid(), name, description, sanitized, encryptedApiKey]
    );

    return mapAgent(result.rows[0]);
  }

  async getAgent(id: string): Promise<AgentWithSecret | null> {
    const result = await this.pool.query<AgentRow>(
      `
        select *
        from agents
        where id = $1
      `,
      [id]
    );

    if (!result.rows[0]) return null;
    return mapAgent(result.rows[0]);
  }

  async listAgents(): Promise<AgentWithSecret[]> {
    const result = await this.pool.query<AgentRow>(
      `
        select *
        from agents
        order by created_at asc, id asc
      `
    );

    return result.rows.map(mapAgent);
  }

  async updateAgent(id: string, input: UpdateAgentRequest): Promise<AgentWithSecret> {
    const spec = input.spec;
    const sanitized = exportAgentSpec(spec);
    const name = spec.identity.name;
    const description = spec.identity.description;
    const apiKey = input.apiKey?.trim();

    const setClauses = ["name = $2", "description = $3", "spec = $4", "updated_at = now()"];
    const params: unknown[] = [id, name, description, sanitized];
    if (apiKey) {
      params.push(encryptApiKey(apiKey));
      setClauses.push(`encrypted_api_key = $${params.length}`);
    }

    const result = await this.pool.query<AgentRow>(
      `
        update agents
        set ${setClauses.join(", ")}
        where id = $1
        returning *
      `,
      params
    );

    if (!result.rows[0]) {
      throw new Error(`Agent not found: ${id}`);
    }

    return mapAgent(result.rows[0]);
  }

  async createConnectedAccount(input: CreateConnectedAccountInput): Promise<ConnectedAccount> {
    const appId = input.appId.trim();
    const tools = seededConnectorTools[appId] ?? [];
    if (tools.length === 0) {
      throw new Error(`Unknown connected app id: ${appId}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ConnectedAccountRow>(
        `
          insert into connected_accounts (
            id,
            workspace_id,
            app_id,
            account_label,
            external_account_id,
            status
          )
          values ($1, $2, $3, $4, $5, 'connected')
          on conflict (workspace_id, app_id, external_account_id) do update
          set account_label = excluded.account_label,
              status = 'connected',
              updated_at = now()
          returning *
        `,
        [
          nanoid(),
          input.workspaceId.trim(),
          appId,
          input.accountLabel.trim(),
          input.externalAccountId.trim()
        ]
      );
      const connectedAccount = result.rows[0];

      for (const agentId of input.agentIds) {
        await client.query(
          `
            insert into connected_account_agents (connected_account_id, agent_id)
            values ($1, $2)
            on conflict (connected_account_id, agent_id) do nothing
          `,
          [connectedAccount.id, agentId]
        );

        for (const toolName of tools) {
          await client.query(
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
              values ($1, $2, $3, $4, $5, 'ask_each_time', 'synced', 'ask_each_time', now())
              on conflict (agent_id, connected_account_id, tool_name) do nothing
            `,
            [nanoid(), agentId, connectedAccount.id, appId, toolName]
          );
        }
      }

      await client.query("commit");
      return mapConnectedAccount(connectedAccount);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listToolConfigurationsForAgent(agentId: string): Promise<ToolConfiguration[]> {
    const result = await this.pool.query<ToolConfigurationRow>(
      `
        select tc.*
        from tool_configurations tc
        join connected_accounts ca on ca.id = tc.connected_account_id
        join connected_account_agents caa
          on caa.connected_account_id = ca.id
         and caa.agent_id = tc.agent_id
        where tc.agent_id = $1
          and ca.status = 'connected'
        order by ca.app_id asc, tc.tool_name asc
      `,
      [agentId]
    );

    return result.rows.map(mapToolConfiguration);
  }

  async listConnectedAppsForAgent(agentId: string): Promise<ConnectedAppState[]> {
    const result = await this.pool.query<ConnectedAccountRow>(
      `
        select ca.*
        from connected_accounts ca
        join connected_account_agents caa on caa.connected_account_id = ca.id
        where caa.agent_id = $1
          and ca.app_id = $2
          and ca.status = 'connected'
        order by ca.updated_at desc, ca.created_at desc, ca.id asc
        limit 1
      `,
      [agentId, githubConnectedAppTemplate.appId]
    );
    const connectedAccount = result.rows[0] ? mapConnectedAccount(result.rows[0]) : null;
    const tools = connectedAccount
      ? (await this.listToolConfigurationsForAgent(agentId)).filter(
          (toolConfiguration) => toolConfiguration.connectedAccountId === connectedAccount.id
        )
      : [];

    return [
      {
        ...githubConnectedAppTemplate,
        status: connectedAccount ? "connected" : "available",
        connectedAccount,
        tools
      }
    ];
  }

  async getToolConfigurationForAgentTool(
    agentId: string,
    toolName: string
  ): Promise<ToolConfigurationWithAccount | null> {
    const result = await this.pool.query<ToolConfigurationWithAccountRow>(
      `
        select
          tc.*,
          ca.external_account_id,
          ca.status as connected_account_status
        from tool_configurations tc
        join connected_accounts ca on ca.id = tc.connected_account_id
        join connected_account_agents caa
          on caa.connected_account_id = ca.id
         and caa.agent_id = tc.agent_id
        where tc.agent_id = $1
          and tc.tool_name = $2
        limit 1
      `,
      [agentId, toolName]
    );

    return result.rows[0] ? mapToolConfigurationWithAccount(result.rows[0]) : null;
  }

  async updateToolConfigurationMode(input: UpdateToolConfigurationModeInput): Promise<ToolConfiguration> {
    if (!toolConfigurationModes.has(input.mode)) {
      throw new Error(`Unsupported Tool Configuration mode: ${input.mode}`);
    }

    const result = await this.pool.query<ToolConfigurationRow>(
      `
        update tool_configurations
        set mode = $3,
            sync_status = 'syncing',
            sync_error = null,
            updated_at = now()
        where id = $1
          and agent_id = $2
        returning *
      `,
      [input.toolConfigurationId, input.agentId, input.mode]
    );

    if (!result.rows[0]) {
      throw new Error(`Tool Configuration not found: ${input.toolConfigurationId}`);
    }

    return mapToolConfiguration(result.rows[0]);
  }

  async markToolConfigurationSyncSucceeded(input: CompleteToolConfigurationSyncInput): Promise<ToolConfiguration> {
    const result = await this.pool.query<ToolConfigurationRow>(
      `
        update tool_configurations
        set sync_status = 'synced',
            sync_error = null,
            sync_version = $3,
            last_synced_mode = mode,
            last_synced_at = now(),
            updated_at = now()
        where id = $1
          and agent_id = $2
        returning *
      `,
      [input.toolConfigurationId, input.agentId, input.syncVersion ?? null]
    );

    if (!result.rows[0]) {
      throw new Error(`Tool Configuration not found: ${input.toolConfigurationId}`);
    }

    return mapToolConfiguration(result.rows[0]);
  }

  async markToolConfigurationSyncFailed(input: FailToolConfigurationSyncInput): Promise<ToolConfiguration> {
    const result = await this.pool.query<ToolConfigurationRow>(
      `
        update tool_configurations
        set sync_status = 'sync_failed',
            sync_error = $3,
            updated_at = now()
        where id = $1
          and agent_id = $2
        returning *
      `,
      [input.toolConfigurationId, input.agentId, input.error]
    );

    if (!result.rows[0]) {
      throw new Error(`Tool Configuration not found: ${input.toolConfigurationId}`);
    }

    return mapToolConfiguration(result.rows[0]);
  }

  async recordToolCallAudit(input: RecordToolCallAuditInput): Promise<void> {
    await this.pool.query(
      `
        insert into tool_call_audit_logs (
          id,
          agent_task_id,
          chat_session_id,
          agent_id,
          connected_account_id,
          provider,
          mcp_tool_name,
          provider_tool_name,
          mode,
          args_redacted,
          status,
          error
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        nanoid(),
        input.agentTaskId,
        input.chatSessionId,
        input.agentId,
        input.connectedAccountId,
        input.provider,
        input.mcpToolName,
        input.providerToolName,
        input.mode,
        redactUnknownJson(input.args),
        input.status,
        input.error ?? null
      ]
    );
  }

  async createToolConfirmation(input: CreateToolConfirmationInput): Promise<ToolConfirmation> {
    const result = await this.pool.query<ToolConfirmationRow>(
      `
        insert into tool_confirmations (
          id,
          agent_task_id,
          chat_session_id,
          agent_id,
          connected_account_id,
          provider,
          mcp_tool_name,
          provider_tool_name,
          args_hash,
          preview_json,
          status,
          expires_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
        returning *
      `,
      [
        nanoid(),
        input.agentTaskId,
        input.chatSessionId,
        input.agentId,
        input.connectedAccountId,
        input.provider,
        input.mcpToolName,
        input.providerToolName,
        toolArgsHash(input.args),
        redactUnknownJson(input.args),
        input.expiresAt
      ]
    );

    return mapToolConfirmation(result.rows[0]);
  }

  async getToolConfirmation(id: string): Promise<ToolConfirmation | null> {
    const result = await this.pool.query<ToolConfirmationRow>(
      `
        select *
        from tool_confirmations
        where id = $1
      `,
      [id]
    );
    return result.rows[0] ? mapToolConfirmation(result.rows[0]) : null;
  }

  async listPendingToolConfirmationsForChatSession(chatSessionId: string): Promise<ToolConfirmation[]> {
    const result = await this.pool.query<ToolConfirmationRow>(
      `
        select *
        from tool_confirmations
        where chat_session_id = $1
          and status = 'pending'
          and expires_at > now()
        order by created_at asc, id asc
      `,
      [chatSessionId]
    );
    return result.rows.map(mapToolConfirmation);
  }

  async resolveToolConfirmation(
    id: string,
    input: { status: Exclude<ToolConfirmationStatus, "pending">; expectedArgsHash?: string }
  ): Promise<
    | { status: "resolved"; confirmation: ToolConfirmation }
    | { status: "not_found" }
    | { status: "not_pending"; confirmation: ToolConfirmation }
    | { status: "args_mismatch" }
  > {
    const current = await this.getToolConfirmation(id);
    if (!current) {
      return { status: "not_found" };
    }
    if (current.status !== "pending") {
      return { status: "not_pending", confirmation: current };
    }
    if (input.expectedArgsHash && current.argsHash !== input.expectedArgsHash) {
      return { status: "args_mismatch" };
    }

    const result = await this.pool.query<ToolConfirmationRow>(
      `
        update tool_confirmations
        set status = $2,
            resolved_at = now()
        where id = $1
          and status = 'pending'
        returning *
      `,
      [id, input.status]
    );

    const row = result.rows[0];
    if (!row) {
      const latest = await this.getToolConfirmation(id);
      return latest ? { status: "not_pending", confirmation: latest } : { status: "not_found" };
    }

    return { status: "resolved", confirmation: mapToolConfirmation(row) };
  }

  async expirePendingToolConfirmations(now: Date = new Date()): Promise<number> {
    const result = await this.pool.query(
      `
        update tool_confirmations
        set status = 'expired',
            resolved_at = now()
        where status = 'pending'
          and expires_at <= $1
      `,
      [now]
    );
    return result.rowCount ?? 0;
  }

  async createChatSession(
    input:
      | { agentId: string; title?: string }
      | { agentSpec: AgentSpec; title: string }
  ): Promise<ChatSession> {
    if ("agentId" in input) {
      const agentResult = await this.pool.query<AgentRow>(
        `select id, name from agents where id = $1`,
        [input.agentId]
      );

      if (!agentResult.rows[0]) {
        throw new Error(`Agent not found: ${input.agentId}`);
      }

      const agentName = agentResult.rows[0].name;
      const title = input.title ?? agentName;

      const result = await this.pool.query<ChatSessionRow>(
        `
          insert into chat_session (id, agent_id, agent_name, agent_spec_snapshot, title, status)
          values ($1, $2, $3, null, $4, 'active')
          returning *
        `,
        [nanoid(), input.agentId, agentName, title]
      );

      return mapChatSession(result.rows[0]);
    }

    const sanitizedSpec = exportAgentSpec(input.agentSpec);
    const fallbackAgentId = await this.ensureDefaultAgent(sanitizedSpec);
    const fallbackAgentName = sanitizedSpec.identity.name;

    const result = await this.pool.query<ChatSessionRow>(
      `
        insert into chat_session (id, agent_id, agent_name, agent_spec_snapshot, title, status)
        values ($1, $2, $3, $4, $5, 'active')
        returning *
      `,
      [nanoid(), fallbackAgentId, fallbackAgentName, sanitizedSpec, input.title]
    );

    return mapChatSession(result.rows[0]);
  }

  private async ensureDefaultAgent(spec: AgentSpec): Promise<string> {
    const existing = await this.pool.query<{ id: string }>(
      `select id from agents where id = 'default'`
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    await this.pool.query(
      `insert into agents (id, name, description, spec) values ($1, $2, $3, $4)`,
      ["default", spec.identity.name, spec.identity.description, spec]
    );
    return "default";
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
      taskMessages: taskMessagesResult.rows.map(mapTaskMessage),
      pendingToolConfirmations: await this.listPendingToolConfirmationsForChatSession(id)
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

  async issueAgentTaskLease(taskId: string): Promise<IssuedAgentTaskLease> {
    const token = createLeaseToken();
    const now = Date.now();
    const idleExpiresAt = new Date(now + 15 * 60 * 1000);
    const absoluteExpiresAt = new Date(now + 2 * 60 * 60 * 1000);
    const result = await this.pool.query<{ id: string }>(
      `
        insert into agent_task_leases (
          id,
          agent_task_id,
          token_hash,
          issuer,
          audience,
          status,
          expires_at,
          absolute_expires_at
        )
        values ($1, $2, $3, $4, $5, 'active', $6, $7)
        returning id
      `,
      [
        nanoid(),
        taskId,
        sha256Hex(token),
        "agent-builder-api",
        "agent-builder-mcp-gateway",
        idleExpiresAt,
        absoluteExpiresAt
      ]
    );

    return { id: result.rows[0].id, token };
  }

  async validateAgentTaskLease(token: string): Promise<ValidatedAgentTaskLease | null> {
    const result = await this.pool.query<{
      id: string;
      agent_task_id: string;
      chat_session_id: string;
      agent_id: string;
      agent_spec: AgentSpec;
      issuer: string;
      audience: string;
      status: string;
      expires_at: Date | string;
      absolute_expires_at: Date | string;
      revoked_at: Date | string | null;
    }>(
      `
        select
          l.id,
          l.agent_task_id,
          t.chat_session_id,
          s.agent_id,
          a.spec as agent_spec,
          l.issuer,
          l.audience,
          l.status,
          l.expires_at,
          l.absolute_expires_at,
          l.revoked_at
        from agent_task_leases l
        join agent_tasks t on t.id = l.agent_task_id
        join chat_session s on s.id = t.chat_session_id
        join agents a on a.id = s.agent_id
        where l.token_hash = $1
        limit 1
      `,
      [sha256Hex(token)]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const now = new Date();
    if (
      row.status !== "active" ||
      row.revoked_at != null ||
      row.issuer !== "agent-builder-api" ||
      row.audience !== "agent-builder-mcp-gateway" ||
      new Date(row.expires_at).getTime() <= now.getTime() ||
      new Date(row.absolute_expires_at).getTime() <= now.getTime()
    ) {
      return null;
    }

    const renewedIdleExpiry = new Date(now.getTime() + 15 * 60 * 1000);
    const absoluteExpiry = new Date(row.absolute_expires_at);
    const nextExpiresAt = renewedIdleExpiry.getTime() < absoluteExpiry.getTime() ? renewedIdleExpiry : absoluteExpiry;
    await this.pool.query(
      `
        update agent_task_leases
        set expires_at = $2,
            updated_at = now()
        where id = $1
      `,
      [row.id, nextExpiresAt]
    );

    return {
      id: row.id,
      agentTaskId: row.agent_task_id,
      chatSessionId: row.chat_session_id,
      agentId: row.agent_id,
      agentSpec: row.agent_spec
    };
  }

  async bindAgentTaskLeaseSandbox(leaseId: string, sandboxId: string): Promise<"bound" | "not_found" | "conflict"> {
    const trimmedSandboxId = sandboxId.trim();
    if (!trimmedSandboxId) {
      throw new Error("sandboxId is required");
    }

    const updated = await this.pool.query<{ id: string }>(
      `
        update agent_task_leases
        set sandbox_id = $2,
            updated_at = now()
        where id = $1
          and status = 'active'
          and (sandbox_id is null or sandbox_id = $2)
        returning id
      `,
      [leaseId, trimmedSandboxId]
    );
    if (updated.rows[0]) {
      return "bound";
    }

    const existing = await this.pool.query<{ sandbox_id: string | null }>(
      `
        select sandbox_id
        from agent_task_leases
        where id = $1
      `,
      [leaseId]
    );
    if (!existing.rows[0]) {
      return "not_found";
    }
    return existing.rows[0].sandbox_id && existing.rows[0].sandbox_id !== trimmedSandboxId
      ? "conflict"
      : "not_found";
  }

  async revokeAgentTaskLeases(taskId: string): Promise<void> {
    await this.pool.query(
      `
        update agent_task_leases
        set status = 'revoked',
            revoked_at = coalesce(revoked_at, now()),
            updated_at = now()
        where agent_task_id = $1
          and status = 'active'
      `,
      [taskId]
    );
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

  async appendRunnerTaskMessages(
    taskId: string,
    messages: RunnerTaskMessage[],
    secretValues: string[] = []
  ): Promise<{ chatSessionId: string; messages: TaskMessage[] }> {
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

      if (messages.length === 0) {
        await client.query("commit");
        return { chatSessionId: task.chat_session_id, messages: [] };
      }

      const redactedMessages = messages.map((message) => ({
        ...message,
        content: redactSecrets(message.content, secretValues),
        inputJson: redactUnknownJson(message.inputJson, undefined, secretValues),
        output: message.output ? redactSecrets(message.output, secretValues) : null
      }));

      const inserted = await insertTaskMessages(client, taskId, redactedMessages);
      await this.touchChatSession(task.chat_session_id);
      await client.query("commit");
      return { chatSessionId: task.chat_session_id, messages: inserted };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
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
        const mergedTask = await fillTerminalTaskMetadata(client, currentTask, {
          sessionId: input.sessionId,
          workDir: input.workDir,
          rawOutputRedacted: redactedRawOutput,
          resultMarkdown: redactedResultMarkdown
        });
        await client.query("commit");
        return mapAgentTask(mergedTask);
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
        const mergedTask = await fillTerminalTaskMetadata(client, currentTask, {
          sessionId: input.sessionId,
          workDir: input.workDir,
          rawOutputRedacted: redactedRawOutput,
          error: redactedError
        });
        await client.query("commit");
        return mapAgentTask(mergedTask);
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
          insert into chat_message (id, chat_session_id, role, content_markdown, task_id)
          values ($1, $2, 'assistant', $3, $4)
        `,
        [nanoid(), taskRow.chat_session_id, assistantFailureMessage(input.status, redactedError), taskId]
      );
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
