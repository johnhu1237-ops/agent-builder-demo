import type { RunnerEventsTarget, RunnerTaskMessage } from "@agent-builder/shared";
import { redactRunnerOutput } from "./redaction";

export type RunnerEventEmitter = (message: RunnerTaskMessage) => Promise<void>;

type FetchLike = typeof fetch;

export function createRunnerEventEmitter(input: {
  taskId?: string;
  runnerEvents?: RunnerEventsTarget | null;
  secretValues: string[];
  fetchImpl?: FetchLike;
}): RunnerEventEmitter {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async (message) => {
    if (!input.taskId || !input.runnerEvents) {
      return;
    }

    const redactedMessage: RunnerTaskMessage = {
      ...message,
      content: redactRunnerOutput(message.content, input.secretValues),
      output: message.output ? redactRunnerOutput(message.output, input.secretValues) : null
    };

    const response = await fetchImpl(input.runnerEvents.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.runnerEvents.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        taskId: input.taskId,
        messages: [redactedMessage]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Runner event append failed with ${response.status}: ${body}`);
    }
  };
}
