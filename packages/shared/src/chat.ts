import type { AgentSpec } from "./agent-spec";

export type ChatSessionStatus = "active" | "archived";
export type ChatMessageRole = "user" | "assistant";
export type AgentTaskStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
export type TaskMessageType = "status" | "text" | "tool_use" | "tool_result" | "error" | "log";

export type ChatSession = {
  id: string;
  agentSpecSnapshot: AgentSpec;
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
};

export type CreateChatSessionRequest = {
  agentSpec: AgentSpec;
  title?: string;
};

export type SendChatMessageRequest = {
  message: string;
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
};

export type CreateAgentTaskRequest = {
  chatSessionId: string;
  message: string;
  agentSpec: AgentSpec;
  runtimeSecrets: {
    apiKey: string;
  };
  sessionId: string | null;
  workDir: string | null;
};

export type RunnerTaskMessage = Omit<TaskMessage, "id" | "taskId" | "seq" | "createdAt">;

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
