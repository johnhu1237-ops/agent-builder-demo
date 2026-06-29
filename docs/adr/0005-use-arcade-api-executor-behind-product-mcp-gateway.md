# Use Arcade API Executor Behind Product MCP Gateway

Accepted: 2026-06-29

The product gateway speaks MCP to Codex, but executes external app tools through Arcade's structured SDK/API path behind an internal executor interface. Arcade's MCP Gateway remains a possible adapter if a capability is only available through MCP, but v1 does not proxy MCP from Codex directly into Arcade because product policy, confirmations, and audit are enforced before execution.

## Considered Options

- **Arcade SDK/API executor**: keeps the product gateway as the MCP boundary, gives structured tool execution and authorization calls, and is easier to test behind an `ExternalToolExecutor` interface.
- **MCP-to-MCP proxying into Arcade**: aligns protocols end-to-end, but makes the product gateway more of a protocol relay and can blur product-owned policy enforcement.
