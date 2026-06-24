# Demo Script

## Opening

This is a configurable code-agent builder. The user configures an agent, model settings, mock app access, reusable skills, and a task. The UI does not expose the underlying runner implementation.

## Flow

1. Show the Research Agent profile.
2. Show model fields: provider, model name, API endpoint, API key.
3. Explain that API key is runtime-only and not exported.
4. Toggle one mock app and explain future MCP app integration.
5. Show Web Research as the real v0.1 ability.
6. Enter: `Research RunwayML and produce a concise company profile.`
7. Click `Run agent`.
8. Show the trace.
9. Show the Markdown final output.
10. Export Agent Spec and point out the API key is absent.

## Talking points

- Apps are future MCP-style tool providers.
- Skills are reusable instructions, not tools.
- Abilities are native runner capabilities.
- The runner is a Railway worker hidden behind the product abstraction.
- v0.1 starts with one agent and evolves later into multi-agent CRUD.
