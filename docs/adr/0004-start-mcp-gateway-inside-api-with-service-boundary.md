# Start MCP Gateway Inside API With a Service Boundary

Accepted: 2026-06-29

The product MCP permission gateway starts as a module inside the existing API service so it can reuse the Agent Task store, Tool Confirmation state, Chat Session SSE publisher, and product database access without immediate cross-service coordination. The implementation should still keep the gateway decoupled behind narrow interfaces for policy lookup, lease validation, confirmation publishing, and Arcade execution so it can later move into a dedicated service without rewriting product policy.

## Considered Options

- **API module with service-like boundaries**: fastest v1 integration and simplest SSE/confirmation coordination, while preserving a future extraction path.
- **Dedicated MCP gateway service now**: cleaner deployment boundary, but adds service discovery, shared auth, event fanout, and DB/store coordination before the gateway behavior is proven.
