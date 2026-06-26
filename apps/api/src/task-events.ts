import type { TaskMessageEvent, TaskTerminalEvent } from "@agent-builder/shared";

export type TaskBroadcast =
  | { type: "task_message"; payload: TaskMessageEvent }
  | { type: "terminal"; payload: TaskTerminalEvent };

type Subscriber = (event: TaskBroadcast) => void;

export class TaskEventBroadcaster {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(chatSessionId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(chatSessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(chatSessionId, set);
    }
    set.add(subscriber);
    return () => this.unsubscribe(chatSessionId, subscriber);
  }

  unsubscribe(chatSessionId: string, subscriber: Subscriber): void {
    const set = this.subscribers.get(chatSessionId);
    if (!set) {
      return;
    }
    set.delete(subscriber);
    if (set.size === 0) {
      this.subscribers.delete(chatSessionId);
    }
  }

  publish(chatSessionId: string, event: TaskBroadcast): void {
    const set = this.subscribers.get(chatSessionId);
    if (!set) {
      return;
    }
    for (const subscriber of [...set]) {
      subscriber(event);
    }
  }
}
