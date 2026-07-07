# Dual Base URLs for Runner→API and E2B→API Callbacks

Accepted: 2026-07-07

The API exposes two distinct base URLs because its two callers live on different networks. `runnerEventEndpoint()` (runner event append + Agent Task Lease sandbox bind) is driven by a new `API_INTERNAL_BASE_URL` pointed at the Railway private domain, because the Runner service runs inside Railway. `agentTaskMcpGatewayEndpoint()` stays on the public `API_PUBLIC_BASE_URL`, because that URL is handed to the E2B sandbox, which runs on E2B's cloud outside Railway and can only reach the API over the public internet.

Keeping the runner's callbacks off the public reverse proxy structurally removes a `502 / api-upstream-unavailable` failure class observed during sandbox bind, where the proxy in front of the API returned a bad gateway while the API process itself was reachable internally.

## Consequences

- Do not collapse `API_INTERNAL_BASE_URL` back into `API_PUBLIC_BASE_URL`: the E2B→MCP-gateway path requires a publicly reachable URL, and the runner→API path benefits from the private network. They cannot share one value.
- A retry-with-backoff on `api-upstream-unavailable` bind failures remains worthwhile as defense-in-depth but is not the primary mitigation.
