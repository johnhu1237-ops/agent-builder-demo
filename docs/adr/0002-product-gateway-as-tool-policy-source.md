# Product Gateway Is the Tool Policy Source

Accepted: 2026-06-29

External app tools are exposed to Codex through a product-owned MCP permission gateway, and the product database is the source of truth for Agent tool policy. Arcade is used as the connector, OAuth, and tool execution backend, but product-level allow/deny decisions, confirmation requirements, audit records, and task/session checks stay in the product gateway so Agent tool configuration follows the same live-config semantics as the rest of the Agent.

## Considered Options

- **Product gateway as policy source**: matches live Agent configuration, supports product-specific confirmations and audit, and avoids UI state drifting from execution policy.
- **Arcade gateway as policy source**: delegates more to the connector backend, but makes product policy harder to enforce consistently and introduces sync drift when Agent tool settings change.
