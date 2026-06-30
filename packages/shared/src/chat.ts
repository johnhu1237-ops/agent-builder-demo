import type { AgentSpec } from "./agent-spec";

export type ChatSessionStatus = "active" | "archived";
export type ChatMessageRole = "user" | "assistant";
export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
export type TaskMessageType = "status" | "text" | "tool_use" | "tool_result" | "error" | "log";

export type ChatSession = {
  id: string;
  agentId: string;
  agentName: string;
  agentSpecSnapshot: AgentSpec | null;
  lastMessagePreview: string | null;
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
  pendingToolConfirmations?: ToolConfirmation[];
};

export type CreateChatSessionRequest = {
  agentId: string;
  title?: string;
};

export type SendChatMessageRequest = {
  message: string;
};

export type ScheduleChatMessageResponse = {
  chatSessionId: string;
  userMessage: ChatMessage;
  task: AgentTask;
  eventsUrl: string;
};

export type TaskSnapshotEvent = {
  task: AgentTask | null;
  taskMessages: TaskMessage[];
  pendingToolConfirmations?: ToolConfirmation[];
};

export type TaskMessageEvent = {
  taskId: string;
  seq: number;
  taskMessage: TaskMessage;
};

export type TaskTerminalEvent = {
  taskId: string;
  status: Extract<AgentTaskStatus, "completed" | "failed" | "timed_out" | "cancelled">;
  error?: string | null;
};

export type ToolConfirmationStatus = "pending" | "approved" | "denied" | "expired" | "revoked";

export type ToolConfirmation = {
  id: string;
  agentTaskId: string;
  chatSessionId: string;
  agentId: string;
  connectedAccountId: string;
  provider: string;
  mcpToolName: string;
  providerToolName: string;
  argsHash: string;
  previewJson: unknown;
  status: ToolConfirmationStatus;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

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

export type ToolConfigurationMode = "auto" | "ask_each_time" | "disabled";
export type ToolConfigurationSyncStatus = "syncing" | "synced" | "sync_failed";

export type ToolConfiguration = {
  id: string;
  agentId: string;
  connectedAccountId: string;
  appId: string;
  toolName: string;
  mode: ToolConfigurationMode;
  syncStatus: ToolConfigurationSyncStatus;
  syncError: string | null;
  syncVersion: string | null;
  lastSyncedMode: ToolConfigurationMode | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectedAppState = {
  appId: string;
  provider: "github";
  label: string;
  description: string;
  status: "available" | "connected";
  connectedAccount: ConnectedAccount | null;
  tools: ToolConfiguration[];
};

export type ToolConfirmationEvent = {
  confirmation: ToolConfirmation;
};

export type RunnerEventsTarget = {
  endpoint: string;
  token: string;
};

export type CreateAgentTaskRequest = {
  chatSessionId: string;
  taskId?: string;
  mcpGatewayUrl?: string;
  agentTaskLeaseId?: string;
  agentTaskLeaseToken?: string;
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

const terminalTaskStatuses = new Set<AgentTaskStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled"
]);

export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return terminalTaskStatuses.has(status);
}
