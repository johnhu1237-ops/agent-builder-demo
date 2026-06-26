# Agent Builder

Agent Builder is a configurable code-agent workbench where users configure agents,
start chat sessions, and observe agent work as part of the conversation.

## Language

**Chat Session**:
A conversation between a user and one configured **Agent**. A chat session owns zero
or more user messages, assistant messages, and agent tasks, but only one **Agent
Task** may run at a time within the chat session.
_Avoid_: Conversation when referring to the persisted product object.

**Agent Task**:
A single unit of work triggered by a user message in a **Chat Session**. An agent
task may produce visible activity events before it produces a final assistant
message.
_Avoid_: Job, run.

**Task Event Stream**:
The persisted and realtime stream of visible activity produced while an **Agent
Task** is running. It is the system term for task progress, tool use, logs, and
errors.
_Avoid_: Thinking, reasoning, chain of thought.

**Activity**:
The chat UI presentation of a **Task Event Stream**. Activity appears inline with
the chat while an **Agent Task** is running and may be collapsed after completion.
_Avoid_: Thought process, model reasoning.

## Example Dialogue

Developer: "When the user sends a message, should we create a new Agent Task?"

Domain expert: "Yes. The Chat Session records the user's message, and that message
triggers one Agent Task."

Developer: "Do we show the task's reasoning in the chat?"

Domain expert: "No. We show Activity: visible status, tool use, logs, and errors
from the Task Event Stream. We do not claim to expose hidden reasoning."
