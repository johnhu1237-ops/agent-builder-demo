# Arcade GitHub OAuth MVP

## Goal

Enable a real GitHub **Connected App Authorization** flow through Arcade before implementing real external tool execution. Users should click Connect GitHub, complete Arcade-owned GitHub authorization, return automatically to Agent Builder, and see GitHub as connected only after the API verifies Arcade reports the demo user as authorized.

This is a follow-up slice to `2026-06-29-arcade-mcp-gateway.md`. The Product MCP Gateway remains the tool policy boundary; this spec only replaces the current demo connected-app completion path with a real Arcade authorization check.

## Non-Goals

- Direct product-owned GitHub OAuth.
- Direct Codex-to-Arcade MCP access.
- Real GitHub tool execution through Arcade.
- Multi-user auth, signed state, or a persistent authorization-attempt table.
- GitHub profile lookup for account display name.
- Slack, Notion, or other providers in this slice.
- Production-grade OAuth CSRF/state handling beyond the single-user demo constraints.

## Current Problem

The current GitHub connected-app path is still demo-style:

- `POST /api/agents/:id/connected-apps/github/authorize` returns `authorizationUrl: null`.
- `POST /api/agents/:id/connected-apps/github/complete` unconditionally creates a connected account.
- The web app calls `/complete` directly when the user clicks Connect GitHub.
- Local E2E data can leave `E2E Mock GitHub` visible as connected even though no real OAuth happened.

This makes the UI look connected before Arcade has authorized the user.

## Confirmed Decisions

- Arcade owns GitHub OAuth and provider credentials.
- The product API owns Connected Account state, Agent grants, Tool Configuration, and audit behavior.
- MVP uses the fixed demo identity `arcade_user_id = "demo-user"`.
- MVP uses the Arcade tool `Github.ListIssues` as the authorization probe.
- Connected Account display fields are `accountLabel = "GitHub via Arcade"` and `externalAccountId = "demo-user"`.
- The callback returns to the frontend first, not directly to the API.
- The frontend callback URL may carry `agentId` in the query string for MVP.
- `/complete` must verify Arcade authorization before creating a Connected Account.
- No authorization-attempt table is required for this MVP.
- The implementation should use an SDK-first Arcade adapter if practical, behind a narrow internal interface; a narrow HTTP client is an acceptable fallback.

## Domain Model

**Connected App Authorization** is the user-facing flow that produces a **Connected Account**. The flow may involve OAuth redirects, but the product must not treat a redirect alone as proof of authorization.

**Connected Account** is created only after Arcade confirms that `demo-user` is authorized for the GitHub probe tool.

**Tool Configuration** rows are created from the product-owned curated GitHub tool registry after the Connected Account exists. All default modes remain `ask_each_time`.

## Provider Registry Shape

The MVP may keep GitHub-specific routes, but the implementation should keep provider details in a small registry so future providers reuse the same authorization flow.

```ts
type ConnectedAppProviderDefinition = {
  provider: "github";
  appId: "mock-github";
  label: "GitHub";
  arcadeUserId: "demo-user";
  authorizationProbeTool: "Github.ListIssues";
  connectedAccountLabel: "GitHub via Arcade";
  connectedAccountExternalId: "demo-user";
  defaultTools: Array<{
    mcpToolName: string;
    arcadeToolName: string;
    defaultMode: "ask_each_time";
  }>;
};
```

The existing `mock-github` app id may remain during this slice to avoid broad schema churn. A later cleanup can rename it to a provider-stable id.

## Arcade Authorization Client

Route code should depend on a narrow internal interface:

```ts
type ConnectedAppAuthorizationClient = {
  authorize(input: {
    provider: "github";
    userId: string;
    toolName: string;
    returnUrl: string;
  }): Promise<{ authorizationUrl: string }>;

  isAuthorized(input: {
    provider: "github";
    userId: string;
    toolName: string;
  }): Promise<boolean>;
};
```

The production implementation reads `ARCADE_API_KEY` from the API environment. `ARCADE_BASE_URL` and `ARCADE_GITHUB_PROVIDER_ID` are optional configuration values and should only be used if the Arcade SDK/API requires them.

Arcade credentials must never be exposed to the web app, runner, E2B, AgentSpec, task prompts, or task logs.

## API Flow

### Start Authorization

```text
POST /api/agents/:agentId/connected-apps/github/authorize
```

Request:

```json
{
  "returnUrl": "http://localhost:5173/oauth/arcade/github/callback?agentId=..."
}
```

Behavior:

1. Verify the Agent exists.
2. Validate `returnUrl` is an HTTP(S) URL.
3. Call `ConnectedAppAuthorizationClient.authorize` with:
   - `provider = "github"`
   - `userId = "demo-user"`
   - `toolName = "Github.ListIssues"`
   - `returnUrl` from the request
4. Return `202` with `{ provider, arcadeUserId, authorizationUrl, status: "authorization_required" }`.

The endpoint must return an error if Arcade cannot provide an authorization URL.

### Complete Authorization

```text
POST /api/agents/:agentId/connected-apps/github/complete
```

Behavior:

1. Verify the Agent exists.
2. Call `ConnectedAppAuthorizationClient.isAuthorized` with:
   - `provider = "github"`
   - `userId = "demo-user"`
   - `toolName = "Github.ListIssues"`
3. If Arcade reports not authorized, return `409` and do not create a Connected Account.
4. If authorized, create or upsert the Connected Account:
   - `workspaceId = "workspace_demo"`
   - `appId = "mock-github"`
   - `accountLabel = "GitHub via Arcade"`
   - `externalAccountId = "demo-user"`
   - `status = "connected"`
5. Grant the account to the Agent and create default GitHub Tool Configurations.
6. Return the Connected App state.

## Web Flow

### Connect Button

When a user clicks Connect GitHub:

1. Build:

```text
returnUrl = `${window.location.origin}/oauth/arcade/github/callback?agentId=${activeAgent.id}`
```

2. POST to `/api/agents/:agentId/connected-apps/github/authorize`.
3. Redirect the browser to `authorizationUrl`.

The frontend must not call `/complete` directly from the Connect button.

### Callback Route

When the app loads at:

```text
/oauth/arcade/github/callback?agentId=...
```

it should:

1. Read `agentId`.
2. POST `/api/agents/:agentId/connected-apps/github/complete`.
3. On success, select that Agent, switch to the Tools tab, refresh Connected Apps and Tool Configurations, and replace the URL with `/`.
4. On failure, select that Agent if possible, switch to Tools, show a connection error, and replace the URL with `/`.

No new route library is required for MVP; the existing app can inspect `window.location.pathname` on startup.

## Local Data Cleanup

Existing local E2E mock rows can show false connected state. Before manual OAuth verification, mark old E2E mock connected accounts disconnected or use a fresh Agent.

The implementation must also prevent new false connected rows by removing the old unconditional completion behavior.

## Testing

API tests:

- `authorize` returns an Arcade authorization URL and passes the request return URL to the authorization client.
- `complete` returns `409` and creates no Connected Account when Arcade reports not authorized.
- `complete` creates `GitHub via Arcade` Connected Account and default Tool Configurations when Arcade reports authorized.
- `complete` does not accept arbitrary request body account labels or external account ids for the connected account.

Web tests:

- Connect GitHub calls `/authorize` with a frontend callback return URL and redirects to the returned authorization URL.
- Connect GitHub no longer calls `/complete` directly.
- Loading the callback path calls `/complete` automatically and refreshes connected app/tool configuration state on success.
- Failed callback completion leaves the app unconnected and shows an error.

Regression checks:

- Existing MCP gateway fake-executor tests remain intact.
- `pnpm test`
- `pnpm -r typecheck`

## Manual Verification

1. Ensure `ARCADE_API_KEY` is set in the API environment.
2. Ensure Arcade has a GitHub OAuth provider configured for the GitHub App.
3. Start the local API and web app.
4. Use an Agent with no existing mock GitHub Connected Account.
5. Open Tools > Apps.
6. Click Connect GitHub.
7. Confirm the browser navigates to Arcade/GitHub authorization.
8. Complete authorization.
9. Confirm the browser returns to Agent Builder callback URL.
10. Confirm GitHub shows connected as `GitHub via Arcade`.
11. Confirm Tool Configurations appear with `ask_each_time` defaults.

## Open Questions

- Exact Arcade SDK package name and method signatures.
- Exact response shape for authorization status checks.
- Whether `ARCADE_GITHUB_PROVIDER_ID` is needed for Arcade's current GitHub provider configuration.
