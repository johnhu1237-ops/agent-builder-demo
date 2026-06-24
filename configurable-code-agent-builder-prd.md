# Configurable Code Agent Builder PRD

## Problem Statement

We need to quickly validate what an engineering-grade "agent builder" should mean beyond a static Gumloop-like UI. The team needs a demo that shows how a user can configure an agent with a name, system prompt, LLM model, enabled apps, skills, abilities, and permissions, then launch that configured agent to perform a real task.

The central product question is whether "apps" should be modeled as pluginized tool providers, likely MCP-style, and whether the agent runtime should be a real code agent process such as Codex or Claude Code rather than a hand-rolled toy agent loop.

From the user's perspective, the problem is: "I want to show my boss a credible agentic framework / builder demo that proves we can configure and run a real code agent with pluginized apps and skills, without spending time rebuilding an agent runtime from scratch."

## Solution

Build an engineering concept demo for a configurable code agent builder.

The demo will let a user create or edit an agent, select runtime settings, enable MCP-style apps, enable reusable skills, enable built-in abilities, define permission policies, and run a task. When the user runs the task, the system will materialize an Agent Spec into an isolated run workspace, prepare instructions and tool configuration, launch a real CLI code-agent runtime, stream execution events back to the UI, and show the final result plus run artifacts.

The builder is not a visual workflow automation tool in the first version. It is a launcher and governance layer for code agents. The product value is in configuration, pluginization, runtime orchestration, traceability, and a clear path to replacing mock apps with real MCP servers.

## User Stories

1. As a product lead, I want to create a new agent quickly, so that I can demonstrate the concept of an agent builder without writing code.
2. As a product lead, I want to edit an agent name, so that the demo agent has a clear identity.
3. As a product lead, I want to edit the system prompt, so that I can define the agent's role and behavior.
4. As a product lead, I want to choose an LLM model, so that I can show that agent behavior is configurable.
5. As a product lead, I want to enable or disable apps, so that I can control which external tool providers the agent can access.
6. As a product lead, I want to enable or disable skills, so that I can add reusable operating instructions to the agent.
7. As a product lead, I want to enable or disable abilities, so that I can control built-in runtime capabilities such as web search, web fetch, or code execution.
8. As a product lead, I want to save an agent configuration as a portable Agent Spec, so that the configuration can be inspected, versioned, and re-run.
9. As a product lead, I want to run a task from the builder UI, so that the configuration is proven to drive a real runtime.
10. As a product lead, I want to see execution logs while the agent runs, so that I can prove the agent is doing real work.
11. As a product lead, I want to see which tools were made available to the agent, so that I can explain how apps and abilities map to runtime capabilities.
12. As a product lead, I want to see the final answer and artifacts, so that I can judge whether the run succeeded.
13. As a boss reviewing the demo, I want to see an agent configured and launched end-to-end, so that I can understand the proposed framework.
14. As a boss reviewing the demo, I want the demo to use a real code agent runtime, so that it feels more credible than a scripted chatbot.
15. As a boss reviewing the demo, I want to see how apps can become pluginized, so that I can judge whether this can scale beyond a single hard-coded integration.
16. As a boss reviewing the demo, I want to see how skills differ from apps, so that I understand the product model.
17. As a boss reviewing the demo, I want to see how abilities differ from apps, so that I understand what is built into the runtime versus provided by external tools.
18. As an engineer, I want apps represented as plugin manifests, so that app integrations can be added without changing the core builder.
19. As an engineer, I want apps to map cleanly to MCP-style tool providers, so that future integrations can use existing MCP servers where available.
20. As an engineer, I want skills represented as instruction packages, so that reusable behavior can be added without implementing new tools.
21. As an engineer, I want abilities represented as runtime capability plugins, so that built-in tools can be governed consistently with external apps.
22. As an engineer, I want a Plugin Registry, so that the system has a single place to discover apps, skills, and abilities.
23. As an engineer, I want an Agent Spec schema, so that builder configuration and runtime execution share the same contract.
24. As an engineer, I want a Runtime Adapter interface, so that Codex, Claude Code, or a future custom runtime can be launched behind the same abstraction.
25. As an engineer, I want per-run workspaces, so that each task has isolated files, generated instructions, and outputs.
26. As an engineer, I want the runner to materialize config files before launch, so that the runtime process receives all selected tools, skills, and prompts.
27. As an engineer, I want stdout and stderr streamed back to the UI, so that early versions can provide useful traceability even without structured agent events.
28. As an engineer, I want structured run events where possible, so that future UIs can show tool calls, status, approvals, artifacts, and errors cleanly.
29. As an engineer, I want run cancellation, so that runaway agent processes can be stopped.
30. As an engineer, I want timeouts and resource limits, so that a demo run cannot hang indefinitely.
31. As an engineer, I want permission policies represented in the Agent Spec, so that future guardrails are part of the design from day one.
32. As an engineer, I want the first version to avoid OAuth-heavy integrations, so that the demo can be built quickly.
33. As an engineer, I want at least one real ability such as web search or web fetch, so that the agent can perform a non-trivial real task.
34. As an engineer, I want mock apps such as GitHub, Notion, or Slack, so that the UI can demonstrate app enablement before real credentials exist.
35. As an engineer, I want the system to keep app plugins separate from runtime adapters, so that adding an app does not require changing how Codex or Claude Code is launched.
36. As an engineer, I want the system to keep skill loading separate from app loading, so that instructions and tools can evolve independently.
37. As an engineer, I want the builder to expose model selection, so that the runtime can later support multiple model providers.
38. As an engineer, I want run artifacts to be collected, so that the demo can show what changed or what was produced.
39. As an engineer, I want errors to be visible in the trace, so that failed runs are understandable.
40. As an engineer, I want the first demo to be simple enough to build quickly, so that it can warm up the team and guide further product discussions.

## Implementation Decisions

- Build the first version as an engineering concept demo, not a full Gumloop clone.
- Treat the product as a configurable code-agent builder and launcher.
- Use a real CLI code-agent runtime, such as Codex or Claude Code, instead of implementing a custom LLM agent loop in the first version.
- Introduce a Runtime Adapter abstraction with a stable interface for starting, stopping, and streaming a run.
- Make the Runtime Adapter responsible for translating an Agent Spec into the concrete launch format expected by the chosen CLI agent.
- Represent each agent as an Agent Spec containing identity, model, system prompt, enabled apps, enabled skills, enabled abilities, permissions, and runtime selection.
- Keep the Agent Spec portable and inspectable so it can later be saved as JSON or YAML.
- Treat apps as MCP-style tool provider plugins.
- Represent each app with metadata, authentication requirements, permission categories, and a runtime materialization strategy.
- Allow mock app plugins in the first demo to show the product model without OAuth setup.
- Treat skills as reusable instruction packages, not tools.
- A skill may include instructions, examples, required or suggested tools, and compatibility metadata.
- Treat abilities as runtime-native capability plugins such as web search, web fetch, file access, or controlled code execution.
- Use a Plugin Registry as the deep module that resolves available apps, skills, and abilities from manifests.
- Keep Plugin Registry independent from UI components and runtime process management.
- Use a Runner Service as the deep module that creates a per-run workspace, writes generated instructions, writes runtime configuration, launches the process, streams events, and collects artifacts.
- The Runner Service should expose a simple run lifecycle: create, start, stream, cancel, complete, and fail.
- First-version isolation can be a per-run local workspace. Container or microVM isolation is a later hardening step.
- The first version should stream stdout and stderr as run events.
- The first version should support a final result event even if the runtime only exposes process output.
- The first version should collect generated files or diffs when practical.
- The UI should include an Agent Builder panel, plugin selection panels, a task input, a run console, and a trace/artifact viewer.
- The UI should make it clear which apps, skills, and abilities are enabled for the current run.
- The demo should prioritize an end-to-end path over broad app coverage.
- The first real capability should be low-friction, preferably web search or web fetch, because it avoids OAuth while still proving real task execution.
- Third-party apps such as GitHub, Notion, Slack, Gmail, or CRM tools can appear as mock plugins until credentials and MCP server behavior are defined.
- Permission policies should be represented in configuration even if the first version only enforces coarse policies.
- Avoid building a visual workflow canvas in the first version.
- Avoid building multi-agent delegation in the first version.
- Avoid building production multi-tenant security in the first version.

## Testing Decisions

- Good tests should verify observable behavior across stable module boundaries rather than private implementation details.
- Agent Spec validation should be tested with valid and invalid configurations.
- Plugin Registry should be tested to ensure it resolves enabled apps, skills, and abilities correctly and rejects unknown plugin IDs.
- Skill loading should be tested to ensure selected skills contribute instructions to a run without being treated as executable tools.
- App materialization should be tested to ensure selected app plugins can produce runtime tool configuration or mock tool availability.
- Runtime Adapter should be tested with a fake process adapter that emits deterministic events.
- Runner Service should be tested for run lifecycle behavior: create workspace, start process, stream events, complete, fail, cancel, and timeout.
- Trace streaming should be tested from the API boundary so the UI can depend on stable event shapes.
- UI tests should cover the core happy path: create/edit an agent, enable plugins, enter a task, start a run, and observe streamed events.
- Error tests should cover invalid Agent Specs, missing runtime binaries, plugin materialization failure, process exit failure, and run cancellation.
- Tests should not assert the exact internal prompt string unless the prompt is a published contract. They should assert that selected skills, apps, abilities, and permissions are represented in the materialized run input.
- Real CLI agent execution should be covered by a small smoke test or manual verification path rather than broad automated tests, because it depends on local credentials, installed binaries, model availability, and network access.

## Out of Scope

- Full production clone of Gumloop.
- Visual workflow canvas.
- Full self-hosted MCP marketplace.
- OAuth setup for GitHub, Notion, Slack, Gmail, Salesforce, HubSpot, or other third-party apps.
- Enterprise RBAC, SSO, SCIM, audit retention, VPC deployment, and billing.
- Multi-user collaboration.
- Multi-agent delegation and subagent orchestration.
- Agent self-improvement that edits its own instructions automatically.
- Production-grade sandboxing with containers, microVMs, network allowlists, and secret isolation.
- Full structured tool-call tracing if the selected CLI runtime does not expose it.
- Building a custom LLM agent loop in the first version.

## Further Notes

- The core insight is that "apps" in this product model are best understood as MCP-style tool providers.
- The more differentiated product is not a chat UI; it is a builder that configures and launches constrained code agents.
- The first demo should prove that a user can configure an agent and run it through a real runtime.
- The most important architecture boundary is between Agent Spec, Plugin Registry, Runner Service, and Runtime Adapter.
- A future version can replace mock apps with real MCP servers without changing the overall product model.
- A future version can add Docker or microVM isolation after the launcher path is validated.
- A future version can support multiple runtimes through the same Runtime Adapter contract.
