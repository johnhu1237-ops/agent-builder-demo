import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePrompt, type CreateRunRequest, type RunnerResponse } from "@agent-builder/shared";

export type CodexCommandInput = {
  modelName: string;
  workspacePath: string;
  finalPath: string;
  prompt: string;
};

export type CodexCommand = {
  command: "codex";
  args: string[];
};

export function createCodexCommand(input: CodexCommandInput): CodexCommand {
  return {
    command: "codex",
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
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

export async function runCodexAgent(request: CreateRunRequest, timeoutMs: number): Promise<RunnerResponse> {
  const workspacePath = await mkdir(join(tmpdir(), `agent-run-${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true
  });

  if (!workspacePath) {
    throw new Error("Failed to create runner workspace");
  }

  const finalPath = join(workspacePath, "final.md");
  const prompt = materializePrompt({ agentSpec: request.agentSpec, task: request.task });
  await writeFile(join(workspacePath, "prompt.md"), prompt, "utf8");

  const command = createCodexCommand({
    modelName: request.agentSpec.model.name,
    workspacePath,
    finalPath,
    prompt
  });

  const rawChunks: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: workspacePath,
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
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex exited with code ${code}`));
        }
      });
    });

    const finalMarkdown = await readFile(finalPath, "utf8").catch(() => "");
    if (!finalMarkdown.trim()) {
      throw new Error("Codex completed without final Markdown output");
    }

    return {
      finalMarkdown,
      rawOutput: rawChunks.join(""),
      events: [
        { type: "starting", message: "Starting runner" },
        { type: "researching", message: "Researching task context" },
        { type: "generating_report", message: "Generating Markdown report" },
        { type: "completed", message: "Run completed" }
      ]
    };
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}
