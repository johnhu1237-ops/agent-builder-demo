# Agent Builder

Agent Builder is a configurable code-agent workbench where users configure agents,
start chat sessions, and observe agent work as part of the conversation.

## Language

**Agent**:
A configurable code-working persona that a user edits and tests through **Chat Sessions**. Future **Agent Tasks** use the Agent's current configuration, while past tasks keep their own task-time record.
_Avoid_: Bot, assistant template.

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

**Tool Configuration**:
The set of external app tools that an **Agent** may use, including whether each tool is available automatically, requires confirmation, or is unavailable. Tool configuration changes affect future **Agent Tasks**, not tasks already running or completed.
_Avoid_: Plugin settings, connector permissions.

**Tool Definition**:
A product-approved external app capability that may appear in an **Agent's** **Tool Configuration**. A Tool Definition belongs to a provider and has a stable product-facing name.
_Avoid_: Raw connector tool, provider method.

**Product Tool Registry**:
The product-owned catalogue of **Tool Definitions** that may be granted to **Agents**. It defines which external app capabilities are available through Agent Builder, separate from any provider's full tool catalogue.
_Avoid_: Dynamic provider catalogue, raw tool list.

**Connected Account**:
A user's authorized connection to an external app account that may be granted to one or more **Agents**. A connected account is distinct from an Agent's **Tool Configuration**, which decides whether and how that Agent can use the account's tools.
_Avoid_: Agent credential, tool permission.

**Connected App Authorization**:
The user-facing flow that turns an available external app into a **Connected Account**. Completion of connected app authorization proves the external app account is authorized; it does not by itself decide which **Agents** or tools may use it.
_Avoid_: OAuth callback when referring to the whole product flow, fake connection.

**Agent Task Lease**:
A short-lived authorization lease that lets the runtime for one **Agent Task** reach product-controlled execution services such as the MCP permission gateway. The lease belongs to the Agent Task, not to the long-lived **Chat Session**.
_Avoid_: Session token, sandbox credential.

**Tool Confirmation**:
A user decision for one exact external tool call requested during an **Agent Task**. A tool confirmation approves, denies, or expires the original call; it does not grant broader access to the tool.
_Avoid_: Permission grant, tool unlock.

## Example Dialogue

Developer: "When the user sends a message, should we create a new Agent Task?"

Domain expert: "Yes. The Chat Session records the user's message, and that message
triggers one Agent Task."

Developer: "Do we show the task's reasoning in the chat?"

Domain expert: "No. We show Activity: visible status, tool use, logs, and errors
from the Task Event Stream. We do not claim to expose hidden reasoning."
