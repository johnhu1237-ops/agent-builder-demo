# Arcade MCP Gateway Integration

## Goal

Add Gumloop-style connected app tools to Agent Builder. Users connect a GitHub account, grant the current Agent access to selected tools, and Codex running inside E2B can call only the tools exposed by the product MCP permission gateway.

The gateway is product-owned. Arcade provides OAuth, connector, and tool execution capabilities, but Agent tool policy, confirmation, audit, and task/session checks are enforced by Agent Builder.

## Non-Goals

- Multi-user or multi-tenant auth in this demo phase.
- More than one provider in v1.
- Direct Codex-to-Arcade MCP access.
- Storing external app state inside `AgentSpec`.
- A separate MCP gateway service in v1.
- Risk-based default modes beyond the conservative v1 default.

## Confirmed Decisions

- Agent tool configuration follows live Agent semantics. Existing Chat Sessions use the Agent's current tool configuration for future Agent Tasks.
- Already-created Agent Tasks keep their own task-time snapshots for audit/debugging.
- Connected Accounts are user-level resources and may be granted to multiple Agents.
- Demo identity is fixed to `owner_user_id = "demo-user"` and `arcade_user_id = "demo-user"`.
- Product DB plus Product MCP Gateway are the policy source of truth.
- Arcade is the OAuth/tool execution backend.
- Product Gateway speaks MCP to Codex and uses an `ExternalToolExecutor` interface to call Arcade SDK/API.
- Product Gateway starts inside the API service, with service-like module boundaries for later extraction.
- `ask_each_time` blocks the original MCP `tools/call` until approve, deny, or timeout.
- Tool Confirmation approves one exact original tool call, not broad tool access.
- Chat Session SSE carries confirmation pending/resolved events; approve/deny use HTTP.
- MCP `tools/list` returns only tools that are callable automatically or callable with confirmation.
- Disabled tools are hidden from `tools/list`, but `tools/call` still rechecks live policy.
- v1 uses a curated product tool registry, not Arcade dynamic catalog, as the UI/MCP schema source.
- v1 provider scope is GitHub only: `github_search_issues` and `github_create_issue`.
- MCP tool names are product-stable names; Arcade tool names are internal mappings.
- Product MCP Gateway is exposed from the existing API service at a stable E2B-reachable HTTPS URL: `${API_PUBLIC_BASE_URL}/mcp/agent-task`.
- Agent Task Leases use opaque random bearer tokens. Only `sha256(token)` is stored in product DB.
- Agent Task Leases use a 15 minute idle expiration and 2 hour absolute expiration.
- Agent Task terminal states immediately revoke the lease and resolve pending confirmations as expired or revoked.
- Agent Task Leases are two-phase bound to E2B `sandbox_id`: API issues the lease before sandbox creation; runner binds the sandbox once before starting Codex.
- Gateway identity is derived only from the lease DB record. Request-provided Agent, Chat Session, Agent Task, sandbox, or Codex session identifiers are never trusted as authorization source.
- Codex discovers the Product MCP Gateway through Codex CLI streamable HTTP MCP registration, not E2B custom MCP servers.
- v1 requires the Product MCP Gateway URL to be reachable from E2B. Development can use a tunnel; deployed demos use the public API base URL.
- The E2B sandbox may receive only `CODEX_API_KEY`, `AGENT_BUILDER_AGENT_TASK_LEASE`, and `AGENT_BUILDER_MCP_GATEWAY_URL` as runtime credentials/configuration for this integration.
- The first implementation slice is lease contract plumbing plus runner injection plus an MCP `tools/list` skeleton.

## Domain Model

**Agent** remains the editable configuration object. Tool Configuration is not stored in `AgentSpec`.

**Connected Account** is a user's authorized external app account. In the demo there is one fixed user, but the model still keeps the account separate from any Agent.

**Tool Configuration** controls which Connected Account tools an Agent may use and whether each tool is `auto`, `ask_each_time`, or `disabled`.

**Agent Task Lease** is a short-lived authorization lease for one Agent Task's runtime access to the Product MCP Gateway.

**Tool Confirmation** is a user decision for one exact tool call requested during one Agent Task.

## Data Model

Add these tables with idempotent migrations:

```sql
connected_accounts (
  id text primary key,
  owner_user_id text not null,
  arcade_user_id text not null,
  provider text not null,
  external_account_label text,
  arcade_connection_id text,
  status text not null, -- pending / connected / failed / revoked
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

```sql
agent_connected_apps (
  id text primary key,
  agent_id text not null references agents(id),
  connected_account_id text not null references connected_accounts(id),
  provider text not null,
  status text not null, -- enabled / disabled
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(agent_id, connected_account_id, provider)
)
```

```sql
agent_enabled_tools (
  id text primary key,
  agent_id text not null references agents(id),
  connected_account_id text not null references connected_accounts(id),
  provider text not null,
  mcp_tool_name text not null,
  provider_tool_name text not null,
  mode text not null, -- auto / ask_each_time / disabled
  policy_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(agent_id, connected_account_id, mcp_tool_name)
)
```

```sql
agent_task_leases (
  id text primary key,
  token_hash text not null unique,
  issuer text not null default 'agent-builder-api',
  audience text not null default 'agent-builder-mcp-gateway',
  agent_task_id text not null references agent_tasks(id),
  chat_session_id text not null references chat_session(id),
  agent_id text not null references agents(id),
  sandbox_id text,
  status text not null, -- active / revoked / expired
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

```sql
tool_confirmations (
  id text primary key,
  agent_task_id text not null references agent_tasks(id),
  chat_session_id text not null references chat_session(id),
  agent_id text not null references agents(id),
  connected_account_id text not null references connected_accounts(id),
  provider text not null,
  mcp_tool_name text not null,
  provider_tool_name text not null,
  args_hash text not null,
  args_encrypted text,
  preview_json jsonb not null default '{}'::jsonb,
  status text not null, -- pending / approved / denied / expired / revoked
  expires_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
)
```

```sql
tool_call_audit_logs (
  id text primary key,
  agent_task_id text not null references agent_tasks(id),
  chat_session_id text not null references chat_session(id),
  agent_id text not null references agents(id),
  connected_account_id text,
  provider text not null,
  mcp_tool_name text not null,
  provider_tool_name text,
  mode text,
  args_redacted jsonb,
  status text not null, -- allowed / denied / confirmation_required / executed / failed / timed_out
  error text,
  created_at timestamptz not null default now()
)
```

Add to `agent_tasks`:

```sql
tool_policy_snapshot jsonb
```

This snapshot is for audit/debugging only. Live DB policy remains authoritative for `tools/list` and `tools/call`.

## Tool Registry

v1 uses a curated registry owned by the product:

```ts
type ExternalToolDefinition = {
  provider: "github";
  mcpName: string;
  arcadeToolName: string;
  displayName: string;
  description: string;
  defaultMode: "ask_each_time";
  inputSchema: unknown;
  previewFields: string[];
};
```

Initial entries:

```ts
github_search_issues -> GitHub.SearchIssues
github_create_issue -> GitHub.CreateIssue
```

All newly connected tools default to `ask_each_time` in v1. Users can later switch a tool to `auto` or `disabled`.

## API Routes

Agent app management:

```text
GET  /api/agents/:agentId/connected-apps
POST /api/agents/:agentId/connected-apps/github/authorize
POST /api/agents/:agentId/connected-apps/github/complete
PUT  /api/agents/:agentId/tools/:mcpToolName
```

The authorize route starts Arcade authorization for `arcade_user_id = "demo-user"`. Completion records a Connected Account, grants it to the current Agent, and creates `agent_enabled_tools` rows for the GitHub registry defaults.

Tool confirmation:

```text
POST /api/tool-confirmations/:id/approve
POST /api/tool-confirmations/:id/deny
```

These endpoints update the confirmation row and wake the blocked MCP call.

Task event stream:

```text
GET /api/chat-sessions/:id/events
```

Extend the existing SSE stream with:

```text
tool_confirmation_pending
tool_confirmation_resolved
```

The initial `task_snapshot` should include pending confirmations for the latest running task.

## MCP Gateway

The gateway starts inside `apps/api`:

```text
apps/api/src/mcp-gateway.ts
apps/api/src/tool-policy-store.ts
apps/api/src/agent-task-lease-store.ts
apps/api/src/tool-confirmation-store.ts
apps/api/src/tool-confirmation-events.ts
apps/api/src/arcade-client.ts
apps/api/src/external-tool-registry.ts
```

Keep dependencies behind narrow interfaces so this module can later move to `apps/mcp-gateway`.

The v1 route shape is:

```text
POST /mcp/agent-task
```

The public runtime URL is derived from the API service public base URL:

```text
AGENT_BUILDER_MCP_GATEWAY_URL=${API_PUBLIC_BASE_URL}/mcp/agent-task
```

This endpoint is public/E2B-reachable but accepts only Agent Task Lease bearer auth:

```http
Authorization: Bearer <agent_task_lease_token>
```

It must not accept web cookies, user session tokens, runner event tokens, Arcade credentials, or other product service credentials.

### Lease Validation

Every MCP request must include an Agent Task Lease. The token is opaque. The gateway hashes it with SHA-256 and loads the lease row by `token_hash`.

Validation requires:

```text
token_hash exists
issuer = agent-builder-api
audience = agent-builder-mcp-gateway
lease.status = active
now() < expires_at
now() < absolute_expires_at
agent_task exists
agent_task.status is not terminal
agent_task.chat_session_id = lease.chat_session_id
chat_session.agent_id = lease.agent_id
```

Valid activity may renew `expires_at` up to `absolute_expires_at`. v1 values:

```text
idle_ttl = 15 minutes
absolute_lease_ttl = 2 hours
confirmation_timeout = 2-5 minutes
```

Agent Task completion, failure, timeout, or cancellation revokes the lease and resolves pending confirmations:

```text
completed / failed / timed_out -> pending confirmations become expired
cancelled -> pending confirmations become revoked
```

Blocked `ask_each_time` MCP calls must wake and return a structured MCP error when the lease or confirmation is revoked/expired.

### Identity Trust Boundary

Gateway authorization trusts only the lease row and product DB joins derived from it.

The request supplies the bearer token; the DB supplies the identity:

```text
Agent Task identity = lease.agent_task_id
Chat Session identity = lease.chat_session_id
Agent identity = lease.agent_id
Sandbox identity = lease.sandbox_id, if bound
```

Request body fields or headers for Agent, Chat Session, Agent Task, sandbox, or Codex session identity may be logged as optional diagnostics, but must never authorize access. Tool policy lookup, confirmations, and audit rows use identities derived from the lease.

### Sandbox Binding

The API issues a lease before the runner knows the E2B sandbox id:

```text
sandbox_id = null
status = active
```

After create/resume succeeds, the runner binds the sandbox exactly once through an internal API route such as:

```text
POST /internal/agent-task-leases/:id/bind-sandbox
```

Rules:

- Binding requires runner-internal authentication, not the Agent Task Lease.
- Binding writes the resolved E2B `sandbox_id`.
- Binding is idempotent only for the same `sandbox_id`.
- Binding to a different `sandbox_id` is rejected.
- Runner binds before registering MCP and before starting Codex, so normal `tools/list` and `tools/call` happen after binding.

### tools/list

Resolve the Agent from the lease and return only live-enabled tools:

```text
mode = auto           -> include
mode = ask_each_time  -> include with confirmation-required wording/metadata
mode = disabled       -> omit
```

Tool definitions are generated from `agent_enabled_tools` joined with the product curated registry.

### tools/call

For every call:

1. Validate and renew the Agent Task Lease.
2. Resolve the live tool policy from product DB.
3. Reject if the tool is missing, disabled, connected account is unavailable, or Agent Task is no longer running.
4. Validate args against the curated registry schema.
5. Record an audit row.
6. If mode is `auto`, call Arcade through `ExternalToolExecutor`.
7. If mode is `ask_each_time`, create a Tool Confirmation, publish SSE, block the original call, and wait for approve/deny/timeout.
8. On approval, execute exactly the original args after verifying the confirmation's args hash.
9. Return the Arcade result or a structured denial/timeout result to Codex.

The confirmation args hash should be produced from canonical JSON and an HMAC secret. Store encrypted full args only if needed to execute after approval. Store redacted `preview_json` for UI.

## Arcade Executor

Use Arcade SDK/API behind an internal interface:

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

`ArcadeApiToolExecutor` is the v1 implementation. An `ArcadeMcpToolExecutor` may be added later if Arcade exposes a needed capability only through MCP.

## Runner and E2B Integration

When creating an Agent Task:

1. API fetches the live Agent spec and live Tool Configuration.
2. API creates `agent_tasks` with `agent_spec_snapshot` and `tool_policy_snapshot`.
3. API creates an Agent Task Lease with an opaque token, stores only `token_hash`, and keeps the plaintext token only long enough to pass to runner.
4. API calls runner with `agentTaskLeaseId`, `agentTaskLeaseToken`, and `mcpGatewayUrl`.
5. Runner creates or resumes E2B.
6. Runner binds the resolved E2B `sandbox_id` to the lease.
7. Runner registers the Product MCP Gateway with Codex CLI inside the sandbox.
8. Runner starts Codex in E2B with command-scoped environment/config only.

The runner injects these environment variables into the Codex command runtime:

```text
CODEX_API_KEY
AGENT_BUILDER_MCP_GATEWAY_URL
AGENT_BUILDER_AGENT_TASK_LEASE
```

Codex MCP registration uses streamable HTTP:

```bash
codex mcp remove agent-builder || true
codex mcp add agent-builder \
  --url "$AGENT_BUILDER_MCP_GATEWAY_URL" \
  --bearer-token-env-var AGENT_BUILDER_AGENT_TASK_LEASE
```

Equivalent direct Codex config is acceptable only if it references the bearer token environment variable and does not inline the token.

Do not write the lease token into `AgentSpec`, E2B metadata, prompt files, `/home/user/workspace`, or repository files. The token is for one Agent Task execution only. Runner redaction must include both `CODEX_API_KEY` and `AGENT_BUILDER_AGENT_TASK_LEASE`.

E2B custom MCP servers are not used in v1. They start stdio MCP servers inside E2B and expose them through the E2B MCP Gateway, which does not remove the requirement for Product Gateway reachability and adds an unnecessary bridge for this product-owned policy gateway.

### Sandbox Secret Boundary

Allowed in E2B:

```text
CODEX_API_KEY
AGENT_BUILDER_AGENT_TASK_LEASE
AGENT_BUILDER_MCP_GATEWAY_URL
```

Never write or inject into E2B:

```text
ARCADE_API_KEY
Arcade OAuth access or refresh tokens
Arcade provider credentials
DATABASE_URL or DB credentials
LLM_API_KEY_ENCRYPTION_KEY
E2B_API_KEY
RUNNER_EVENT_TOKEN
GitHub app/client secrets
Product session cookies or user auth tokens
Raw connected account secrets
Long-lived product service tokens
```

## Security Rules

- Product DB is the source of tool policy truth.
- `tools/call` always rechecks live policy.
- Disabled tools are hidden from `tools/list` and rejected by `tools/call`.
- `ask_each_time` approval binds to one exact original args hash.
- Old approvals cannot be reused for changed args.
- Agent Task Lease belongs to one Agent Task, not a Chat Session.
- Connected Accounts remain separate from Agent Tool Configuration.
- Demo uses `demo-user`, but code should isolate identity lookup behind a helper for future auth.
- Audit logs must redact sensitive args and outputs.

## Implementation Notes

- Keep Product MCP Gateway code decoupled from Express route details where possible.
- Use TypeScript interfaces for stores and executor adapters.
- Keep `AgentSpec.apps` for existing demo compatibility, but do not use it as external tool policy source.
- The first implementation can fake Arcade responses in tests through `ExternalToolExecutor`.
- Use existing `TaskEventBroadcaster` for confirmation SSE events.
- First implementation slice:
  1. Add `agent_task_leases` and `agent_tasks.tool_policy_snapshot` migrations.
  2. Add lease issue, bind, validate, renew, and revoke service methods.
  3. Extend runner request/response contracts with MCP gateway URL and lease fields.
  4. Inject lease and gateway URL into E2B command env and register Codex MCP before `codex exec`.
  5. Add `POST /mcp/agent-task` skeleton supporting MCP initialize and `tools/list`.
  6. Return live curated tools visible to the leased Agent; allow `tools/call` to return `not_implemented` until the Arcade executor slice.
  7. Test hash-only token storage, expiry/revocation/audience rejection, one-time sandbox bind, redaction, and lease-derived identity.

## Open Questions

- Exact Arcade SDK package and method signatures to use in this repo.
- Exact GitHub Arcade tool names and input schemas.
- Whether confirmation args need full encryption-at-rest in v1 or can be held in memory plus redacted DB preview.
- Whether `tool_call_audit_logs` should also store result summaries in v1.
