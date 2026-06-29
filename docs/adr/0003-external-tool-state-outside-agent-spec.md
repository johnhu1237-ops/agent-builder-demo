# External Tool State Lives Outside Agent Spec

Accepted: 2026-06-29

External app connections and tool permissions are stored in product database tables instead of inside `AgentSpec`. `AgentSpec` remains the exportable Agent definition, while Connected Accounts, Arcade identifiers, tool modes, policy JSON, and sync state are product infrastructure state used by the MCP permission gateway.

## Considered Options

- **Relationship tables**: keep OAuth/account state out of exported Agent definitions, support sharing a Connected Account across Agents, and make runtime tool policy queries straightforward.
- **`AgentSpec.apps` JSON**: fits the existing demo shape, but mixes portable Agent configuration with product-owned credentials, connector state, and execution policy.
