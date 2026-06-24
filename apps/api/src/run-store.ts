import { nanoid } from "nanoid";
import { exportAgentSpec, type AgentSpec, type RunEvent, type RunRecord, type RunStatus } from "@agent-builder/shared";

export class RunStore {
  private runs = new Map<string, RunRecord>();

  createQueuedRun(input: { task: string; agentSpec: AgentSpec }): RunRecord {
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: nanoid(),
      task: input.task,
      status: "queued",
      agentSpecSnapshot: exportAgentSpec(input.agentSpec),
      traceEvents: [],
      finalMarkdown: null,
      rawOutput: null,
      error: null,
      startedAt: now,
      completedAt: null
    };
    this.runs.set(run.id, run);
    return run;
  }

  addEvent(runId: string, event: Omit<RunEvent, "id" | "runId" | "createdAt">): RunRecord {
    const run = this.requireRun(runId);
    const nextEvent: RunEvent = {
      id: nanoid(),
      runId,
      createdAt: new Date().toISOString(),
      ...event
    };
    const updated = { ...run, traceEvents: [...run.traceEvents, nextEvent] };
    this.runs.set(runId, updated);
    return updated;
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, "status" | "finalMarkdown" | "rawOutput" | "error" | "completedAt">>
  ): RunRecord {
    const run = this.requireRun(runId);
    const updated = { ...run, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }
}

export function statusFromError(message: string): RunStatus {
  return message.toLowerCase().includes("timed out") ? "timed_out" : "failed";
}
