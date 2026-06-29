import { createStatusTaskMessage, materializeChatPrompt, type CreateAgentTaskRequest, type RunnerAgentTaskResponse, type RunnerTaskMessage } from "@agent-builder/shared";
import { buildCodexCommand } from "./e2b-command";
import { parseCodexJsonLine } from "./e2b-events";
import { createE2BSandboxFactory, resolveSandbox } from "./e2b-sandbox";
import type { E2BSandboxFactory } from "./e2b-types";
import { redactRunnerOutput } from "./redaction";
import { createRunnerEventEmitter, type RunnerEventEmitter } from "./runner-events-client";

export type RunE2BAgentTaskOptions = {
  timeoutMs: number;
  templateId?: string;
  factory?: E2BSandboxFactory;
  emitEvent?: RunnerEventEmitter;
  bindAgentTaskLeaseSandbox?: AgentTaskLeaseSandboxBinder;
};

export type AgentTaskLeaseSandboxBinder = (input: {
  leaseId: string;
  sandboxId: string;
  runnerEventsEndpoint: string;
  runnerEventsToken: string;
}) => Promise<void>;

const WORKSPACE_PATH = "/home/user/workspace";
const PROMPT_PATH = `${WORKSPACE_PATH}/prompt.md`;
const FINAL_PATH = `${WORKSPACE_PATH}/final.md`;
export const DEFAULT_RUN_TIMEOUT_MS = 90000;

export const bindAgentTaskLeaseSandbox: AgentTaskLeaseSandboxBinder = async (input) => {
  const endpoint = new URL(input.runnerEventsEndpoint);
  endpoint.pathname = `/internal/agent-task-leases/${encodeURIComponent(input.leaseId)}/bind-sandbox`;
  endpoint.search = "";
  endpoint.hash = "";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.runnerEventsToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ sandboxId: input.sandboxId })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Agent Task Lease sandbox bind failed with ${response.status}: ${body}`);
  }
};

function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function presentSecret(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export async function runE2BAgentTask(
  request: CreateAgentTaskRequest,
  options?: RunE2BAgentTaskOptions
): Promise<RunnerAgentTaskResponse> {
  const templateId = options?.templateId ?? process.env.E2B_TEMPLATE_ID?.trim();
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (!templateId) {
    throw new Error("E2B_TEMPLATE_ID is required for RUNNER_MODE=e2b");
  }
  const factory = options?.factory ?? createE2BSandboxFactory({ apiKey: e2bApiKey ?? "" });
  if (!options?.factory && !e2bApiKey) {
    throw new Error("E2B_API_KEY is required for RUNNER_MODE=e2b");
  }

  const secretValues = [request.runtimeSecrets.apiKey, request.agentTaskLeaseToken].filter(presentSecret);
  const hasMcpGateway = Boolean(request.mcpGatewayUrl?.trim() && request.agentTaskLeaseToken?.trim() && request.agentTaskLeaseId?.trim());
  const codexEnv = {
    CODEX_API_KEY: request.runtimeSecrets.apiKey,
    ...(hasMcpGateway
      ? {
          AGENT_BUILDER_MCP_GATEWAY_URL: request.mcpGatewayUrl!,
          AGENT_BUILDER_AGENT_TASK_LEASE: request.agentTaskLeaseToken!
        }
      : {})
  };
  const resolved = await resolveSandbox({ workDir: request.workDir, templateId, factory, envs: codexEnv });
  if (hasMcpGateway) {
    if (!request.runnerEvents) {
      throw new Error("runnerEvents are required to bind an Agent Task Lease to an E2B sandbox");
    }
    const bindLease = options?.bindAgentTaskLeaseSandbox ?? bindAgentTaskLeaseSandbox;
    await bindLease({
      leaseId: request.agentTaskLeaseId!,
      sandboxId: resolved.sandbox.sandboxId,
      runnerEventsEndpoint: request.runnerEvents.endpoint,
      runnerEventsToken: request.runnerEvents.token
    });
  }
  const localEvents: RunnerTaskMessage[] = [];
  const emitEvent = options?.emitEvent ?? createRunnerEventEmitter({
    taskId: request.taskId,
    runnerEvents: request.runnerEvents,
    secretValues
  });
  const recordEvent = async (event: RunnerTaskMessage) => {
    const redactedEvent = {
      ...event,
      content: redactRunnerOutput(event.content, secretValues),
      output: event.output ? redactRunnerOutput(event.output, secretValues) : null
    };
    localEvents.push(redactedEvent);
    await emitEvent(redactedEvent);
  };

  if (resolved.kind === "workspace_lost") {
    await recordEvent({
      type: "error",
      tool: "e2b",
      content: `Workspace lost: ${resolved.resumeError.message}. Starting fresh sandbox.`,
      inputJson: null,
      output: null
    });
  }

  const effectiveSessionId = resolved.kind === "workspace_lost" ? null : request.sessionId;
  const prompt = materializeChatPrompt({
    agentSpec: request.agentSpec,
    message: request.message,
    isResume: Boolean(effectiveSessionId)
  });
  await resolved.sandbox.files.write(PROMPT_PATH, prompt);

  const command = buildCodexCommand({
    modelName: request.agentSpec.model.name,
    apiEndpoint: request.agentSpec.model.apiEndpoint,
    workspacePath: WORKSPACE_PATH,
    finalPath: FINAL_PATH,
    promptPath: PROMPT_PATH,
    sessionId: effectiveSessionId,
    registerMcpGateway: hasMcpGateway
  });
  const rawChunks: string[] = [];
  let sessionId: string | null = null;

  await recordEvent(createStatusTaskMessage(effectiveSessionId ? "Resuming Codex session in E2B" : "Starting Codex session in E2B"));
  const result = await resolved.sandbox.commands.run(command, {
    cwd: WORKSPACE_PATH,
    timeoutMs: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    envs: codexEnv,
    onStdout: async (data) => {
      rawChunks.push(data);
      for (const line of splitLines(data)) {
        const parsed = parseCodexJsonLine(line);
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        await recordEvent(parsed.message);
      }
    },
    onStderr: async (data) => {
      rawChunks.push(data);
      for (const line of splitLines(data)) {
        await recordEvent({ type: "log", tool: "codex", content: line, inputJson: null, output: null });
      }
    }
  });

  if (result.exitCode && result.exitCode !== 0) {
    throw new Error(`Codex exited with code ${result.exitCode}`);
  }

  const finalMarkdown = await resolved.sandbox.files.read(FINAL_PATH).catch(() => "");
  if (!finalMarkdown.trim()) {
    throw new Error("Codex completed without final Markdown output");
  }

  await recordEvent(createStatusTaskMessage("Task completed"));
  await resolved.sandbox.pause();

  return {
    status: "completed",
    finalMarkdown: redactRunnerOutput(finalMarkdown, secretValues),
    rawOutputRedacted: redactRunnerOutput(rawChunks.join(""), secretValues),
    taskMessages: localEvents,
    sessionId: sessionId ?? effectiveSessionId,
    workDir: resolved.sandbox.sandboxId
  };
}
