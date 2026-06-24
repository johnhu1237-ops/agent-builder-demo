import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusTaskMessage, materializeChatPrompt, type CreateAgentTaskRequest, type RunnerAgentTaskResponse } from "@agent-builder/shared";
import { redactRunnerOutput } from "./redaction";
import { resolveWorkspacePath } from "./workspace";

export type CodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  prompt: string;
  sessionId: string | null;
};

export type CodexCommand = {
  command: "codex";
  args: string[];
};

export function createCodexCommand(input: CodexCommandInput): CodexCommand {
  const execArgs = input.sessionId ? ["exec", "resume", input.sessionId] : ["exec"];
  return {
    command: "codex",
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      ...execArgs,
      "--json",
      "--model",
      input.modelName,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "--output-last-message",
      input.finalPath,
      "-C",
      input.workspacePath,
      input.prompt
    ]
  };
}

export async function runCodexAgentTask(request: CreateAgentTaskRequest, timeoutMs: number): Promise<RunnerAgentTaskResponse> {
  const rootDir = process.env.RUNNER_WORKSPACE_ROOT ?? join(tmpdir(), "agent-builder-demo-workspaces");
  const workspacePath = await resolveWorkspacePath({
    requestedWorkDir: request.workDir,
    chatSessionId: request.chatSessionId,
    rootDir
  });
  const finalPath = join(workspacePath, "final.md");
  const prompt = materializeChatPrompt({
    agentSpec: request.agentSpec,
    message: request.message,
    isResume: Boolean(request.sessionId)
  });
  await writeFile(join(workspacePath, "prompt.md"), prompt, "utf8");

  const firstCommand = createCodexCommand({
    modelName: request.agentSpec.model.name,
    workspacePath,
    finalPath,
    prompt,
    sessionId: request.sessionId
  });

  const rawChunks: string[] = [];
  const events = [
    createStatusTaskMessage(request.sessionId ? "Resuming Codex session" : "Starting Codex session")
  ];

  try {
    await runCommand(firstCommand, request, rawChunks, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex failed";
    const canFallback = Boolean(request.sessionId) && message.toLowerCase().includes("resume");
    if (!canFallback) {
      throw error;
    }
    events.push({ type: "error", tool: "codex", content: `Resume failed: ${message}. Starting fresh session.`, inputJson: null, output: null });
    const fallbackCommand = createCodexCommand({
      modelName: request.agentSpec.model.name,
      workspacePath,
      finalPath,
      prompt,
      sessionId: null
    });
    await runCommand(fallbackCommand, request, rawChunks, timeoutMs);
  }

  const finalMarkdown = await readFile(finalPath, "utf8").catch(() => "");
  if (!finalMarkdown.trim()) {
    throw new Error("Codex completed without final Markdown output");
  }

  const rawOutputRedacted = redactRunnerOutput(rawChunks.join(""), [request.runtimeSecrets.apiKey]);
  const parsedSessionId = extractSessionId(rawOutputRedacted) ?? request.sessionId;
  events.push(createStatusTaskMessage("Task completed"));

  return {
    status: "completed",
    finalMarkdown: redactRunnerOutput(finalMarkdown, [request.runtimeSecrets.apiKey]),
    rawOutputRedacted,
    taskMessages: events,
    sessionId: parsedSessionId,
    workDir: workspacePath
  };
}

async function runCommand(command: CodexCommand, request: CreateAgentTaskRequest, rawChunks: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.args[command.args.indexOf("-C") + 1],
      env: {
        ...process.env,
        OPENAI_API_KEY: request.runtimeSecrets.apiKey,
        OPENAI_BASE_URL: request.agentSpec.model.apiEndpoint
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Run timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => rawChunks.push(chunk.toString()));
    child.stderr.on("data", (chunk) => rawChunks.push(chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex exited with code ${code}`));
    });
  });
}

function extractSessionId(rawOutput: string): string | null {
  const match = rawOutput.match(/"session_id"\s*:\s*"([^"]+)"/) ?? rawOutput.match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}
