import type { RunnerTaskMessage } from "@agent-builder/shared";

export type ParsedCodexEvent = {
  message: RunnerTaskMessage;
  sessionId: string | null;
};

export function extractSessionIdFromCodexEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as Record<string, unknown>;
  const value = record.session_id ?? record.sessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseCodexJsonLine(line: string): ParsedCodexEvent {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const sessionId = extractSessionIdFromCodexEvent(event);
    if (sessionId) {
      return {
        sessionId,
        message: { type: "status", tool: "codex", content: "Codex session established", inputJson: null, output: null }
      };
    }
    if (event.type === "tool_call") {
      const tool = typeof event.tool === "string" ? event.tool : "tool";
      return {
        sessionId: null,
        message: {
          type: "tool_use",
          tool,
          content: `Tool call: ${tool}`,
          inputJson: event.arguments ?? null,
          output: null
        }
      };
    }
    if (event.type === "tool_result") {
      const tool = typeof event.tool === "string" ? event.tool : "tool";
      return {
        sessionId: null,
        message: {
          type: "tool_result",
          tool,
          content: `Tool result: ${tool}`,
          inputJson: null,
          output: typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? null)
        }
      };
    }
    return {
      sessionId: null,
      message: { type: "log", tool: "codex", content: line, inputJson: event, output: null }
    };
  } catch {
    return {
      sessionId: null,
      message: { type: "log", tool: "codex", content: line, inputJson: null, output: null }
    };
  }
}
