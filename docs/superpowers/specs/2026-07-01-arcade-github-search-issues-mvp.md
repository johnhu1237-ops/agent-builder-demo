# Arcade GitHub Search Issues Tool MVP

## Goal

Make one real Product MCP Gateway tool executable from Codex running inside E2B:
`github_search_issues`.

The MVP proves the full path:

```text
Codex in E2B
-> Product MCP Gateway
-> live Tool Configuration policy
-> Arcade API executor
-> GitHub issue search
-> MCP result back to Codex
```

This slice follows:

- `2026-06-29-arcade-mcp-gateway.md`
- `2026-06-30-arcade-github-oauth-mvp.md`

## Non-Goals

- Implementing GitHub issue creation.
- Adding more providers.
- Dynamically exposing Arcade's full tool catalogue.
- Using Arcade MCP directly from Codex.
- Using `AgentSpec.apps` as runtime external tool policy.
- Building custom result formatting per GitHub tool.
- Renaming or cleaning Slack/Notion mock app identifiers.

## Confirmed Decisions

- The MVP Tool Definition is only `github_search_issues`.
- `github_search_issues` uses the Product Tool Registry as the extension point.
- The Product Tool Registry is provider-agnostic and maps product-stable MCP tool names to provider tool names.
- The GitHub connected app id should be cleaned from `mock-github` to `github` in this MVP.
- The GitHub app id cleanup includes idempotent migration of existing product DB rows.
- Existing `AgentSpec.apps` values with `id = "mock-github"` should be normalized to `github` for compatibility only.
- `AgentSpec.apps` remains outside the runtime authorization path.
- `github_search_issues.defaultMode = "ask_each_time"`.
- Users may switch `github_search_issues` to `auto` in the UI.
- The recommended manual smoke sets `github_search_issues` to `auto` before asking Codex to search issues.
- Runtime execution always reads live `Tool Configuration.mode` from product DB.
- `github_search_issues` input schema is only `{ query: string }`.
- Arcade execution uses the structured SDK/API path behind `ExternalToolExecutor`.
- The Arcade executor is generic; adding a new tool should not require a new executor method.
- Arcade results are returned to Codex as MCP text content containing JSON.

## Domain Model

**Tool Definition** is the product-approved external app capability exposed through Agent Builder.

**Product Tool Registry** is the product-owned catalogue of Tool Definitions. It is not Arcade's full dynamic catalogue.

**Tool Configuration** remains the Agent-specific runtime policy. `defaultMode` initializes Tool Configuration rows, but `tools/list` and `tools/call` must read the live Tool Configuration row.

## Product Tool Registry Shape

The registry should not be GitHub-specific. GitHub is only the first provider entry.

```ts
type ProductToolDefinition = {
  provider: "github" | string;
  connectedAppId: string;
  mcpToolName: string;
  providerToolName: string;
  displayName: string;
  description: string;
  defaultMode: "ask_each_time";
  inputSchema: unknown;
  previewFields: string[];
};
```

Initial MVP entry:

```ts
{
  provider: "github",
  connectedAppId: "github",
  mcpToolName: "github_search_issues",
  providerToolName: "Github.SearchIssues",
  displayName: "Search issues",
  description: "Search GitHub issues through the product MCP gateway.",
  defaultMode: "ask_each_time",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" }
    },
    required: ["query"]
  },
  previewFields: ["query"]
}
```

If Arcade's exact GitHub search tool name differs in the installed environment, update only `providerToolName`.

## GitHub App Id Cleanup

The product runtime app id for GitHub should become:

```text
github
```

Cleanup scope:

- Update product code constants from `mock-github` to `github`.
- Update shared default Agent app entries from `mock-github` to `github`.
- Update plugin/app registry entries from `mock-github` to `github`.
- Update API and web tests.
- Update local smoke docs.
- Add idempotent DB migration for existing rows:

```sql
update connected_accounts
set app_id = 'github'
where app_id = 'mock-github';

update tool_configurations
set app_id = 'github'
where app_id = 'mock-github';
```

Compatibility scope:

- Old `AgentSpec.apps` entries with `id = "mock-github"` should normalize to `github`.
- Compatibility must not make `AgentSpec.apps` a source of Connected Account or Tool Configuration policy.

Out of scope:

- Renaming `mock-slack`.
- Renaming `mock-notion`.

## MCP Gateway Behavior

### tools/list

`tools/list` must:

1. Validate the Agent Task Lease.
2. Resolve the Agent from the lease.
3. Read live Tool Configuration rows for that Agent.
4. Join each Tool Configuration to a Product Tool Registry entry by MCP tool name and connected app id.
5. Return only non-disabled tools.
6. Return the Product Tool Registry input schema and description.

### tools/call

`tools/call` must:

1. Validate the Agent Task Lease.
2. Resolve the Agent from the lease.
3. Read the live Tool Configuration for the requested MCP tool name.
4. Resolve the Product Tool Registry entry.
5. Reject unavailable, disabled, or unmapped tools.
6. For `ask_each_time`, create a Tool Confirmation and execute only after approval.
7. For `auto`, execute directly.
8. Execute Arcade with the registry's `providerToolName`.
9. Record audit rows with the live mode and provider tool name.

## Arcade Executor

`ExternalToolExecutor` stays generic:

```ts
type ExternalToolExecutor = {
  executeTool(input: {
    arcadeUserId: string;
    provider: string;
    mcpToolName: string;
    providerToolName: string;
    args: unknown;
  }): Promise<ExternalToolExecutionResult>;
};
```

`ArcadeApiToolExecutor` should call Arcade through the SDK/API:

```ts
client.tools.execute({
  user_id: arcadeUserId,
  tool_name: providerToolName,
  input: args
})
```

The executor must read `ARCADE_API_KEY` from the API environment and must never expose Arcade credentials to the web app, runner, E2B, AgentSpec, task prompts, or task logs.

## MCP Result Shape

For successful Arcade execution:

```ts
{
  content: [
    {
      type: "text",
      text: JSON.stringify(execution.output?.value ?? execution, null, 2)
    }
  ]
}
```

For Arcade execution errors:

```ts
{
  isError: true,
  content: [{ type: "text", text: message }]
}
```

This is intentionally generic. GitHub-specific result summaries can be added later through a registry-level formatter if needed.

## Manual Smoke

1. Ensure `ARCADE_API_KEY` and `ARCADE_GITHUB_PROVIDER_ID` are set in the API environment.
2. Ensure `API_PUBLIC_BASE_URL` points to the E2B-reachable public API URL.
3. Start API, runner, and web app.
4. Connect GitHub through the existing Arcade Connected App Authorization flow.
5. Confirm GitHub appears connected.
6. Confirm `github_search_issues` exists and defaults to `ask_each_time`.
7. Change `github_search_issues` mode to `auto` in the UI.
8. Start an Agent Task asking Codex to search GitHub issues with a concrete query.
9. Confirm the Agent Task completes with GitHub search results.
10. Confirm audit logs record `mcp_tool_name = github_search_issues`, `provider_tool_name = Github.SearchIssues`, `mode = auto`, and `status = executed`.

## Testing

API tests:

- Migration changes existing `mock-github` Connected Account and Tool Configuration rows to `github`.
- Old `AgentSpec.apps` values with `mock-github` normalize to `github`.
- Connecting GitHub creates `github` Connected Account state and a `github_search_issues` Tool Configuration with `ask_each_time`.
- `tools/list` returns `github_search_issues` from the Product Tool Registry.
- `tools/call` reads live Tool Configuration mode.
- `tools/call` maps `github_search_issues` to `Github.SearchIssues`.
- `tools/call` executes auto-mode calls through `ArcadeApiToolExecutor`.
- Audit logs include the provider tool name and live mode.
- Arcade executor returns JSON text MCP content for success.
- Arcade executor returns MCP error content for failed Arcade execution.

Web tests:

- GitHub connected app state uses app id `github`.
- The Tools UI can switch `github_search_issues` from `ask_each_time` to `auto`.
- Existing callback flow still refreshes connected app and Tool Configuration state.

Regression checks:

- Existing Agent Task Lease and MCP gateway tests remain intact.
- Existing Tool Confirmation tests remain intact.
- `pnpm --filter @agent-builder/api test`
- web tests for connected app/tool configuration behavior
