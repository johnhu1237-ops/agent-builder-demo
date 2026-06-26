# Use SSE for Chat Task Activity

Accepted: 2026-06-26

Agent task progress is server-to-browser, session-scoped, and does not require
browser-to-server realtime messages, so chat Activity will use Server-Sent Events as
the primary realtime protocol. Polling remains an automatic client fallback for
unsupported or unstable SSE connections, while WebSockets are avoided until the
product needs full-duplex realtime interaction.

## Considered Options

- **SSE**: fits one-way task progress, works with standard `EventSource`, supports
  `Last-Event-ID` replay, and matches the existing `/chat-sessions/:id/events`
  route.
- **Polling**: simpler but delays updates, creates repeated load, and would make the
  realtime contract ambiguous.
- **WebSockets**: more flexible than needed and introduces connection management
  complexity without a current product requirement.
