# Session List — Design

Date: 2026-06-25
Scope: Frontend-only (`apps/web/src/App.tsx` + CSS, plus tests). No API or DB changes.

## Problem

The workspace records multiple chat sessions, but the UI only shows a static
`N chat sessions` pill in the left sidebar. There is no way to browse prior
sessions, open one to read its history, or resume the conversation from where a
prior session left off. Today, once `activeSession` is set, the user is stuck in
that one session with no way back to the others or to a fresh one.

## What already exists (no backend work needed)

- `GET /api/chat-sessions` → `listChatSessions()` returns `ChatSession[]`
  ordered by `updatedAt desc`.
- `GET /api/chat-sessions/:id` → `getChatSession(id)` returns
  `ChatSessionDetail` (session + `messages` + `latestTask` + `taskMessages`).
- `POST /api/chat-sessions/:id/messages` → `sendChatMessage()` is already
  resume-aware: the server reads the session's stored `sessionId` / `workDir`
  and passes them to the runner so the agent continues the prior session.

The entire feature is wiring the existing API client functions into the UI.

## Design

### State (in `App.tsx`)

Existing `sessions: ChatSession[]` and `activeSession: ChatSessionDetail | null`
are reused. Add:

- `activeSessionId: string | null` — drives list highlight. Kept in sync with
  `activeSession` (and set independently when a session is selected before its
  detail finishes loading).
- `loadingSessionId: string | null` — the session whose detail is currently
  being fetched, for a lightweight per-item loading affordance and to ignore
  out-of-order responses.

### Sidebar list (replaces the `N chat sessions` pill)

- A `+ New chat` button at the top. Clicking it clears `activeSession`,
  `activeSessionId`, and the message input. The next `Send` then follows the
  existing lazy-create path (`createChatSession` when `activeSession` is null).
- A scrollable list below it. Each item shows:
  - **Main line:** session `title`.
  - **Sub line:** relative time derived from `updatedAt` (e.g. `2m ago`,
    `3h ago`, `2d ago`).
  - An `archived` marker only when `session.status === "archived"`.
- The item matching `activeSessionId` is visually highlighted.

**Status note (deliberate scope decision):** the list endpoint returns
session-level `status` (`active` / `archived`) only — not the latest *task*
status. Showing per-session task status (Ready / Running) would require a detail
fetch per row, which is wasteful. Running / Ready state continues to be shown in
the right-hand workbench header for the *active* session. The list therefore
shows title + relative time, plus an archived marker when applicable.

### Selecting a session

1. On click, set `activeSessionId = id` and `loadingSessionId = id`.
2. Call `getChatSession(id)`.
3. On success, if the response still matches the latest `loadingSessionId`
   (guard against rapid clicks), set it as `activeSession`, clear
   `loadingSessionId`. The right pane re-renders history (`messages`) and task
   timeline (`taskMessages`) via the existing render code.
4. On failure, surface via the existing error banner and clear
   `loadingSessionId`.

### Continuing a session

No new logic. With a session selected, typing a message and pressing `Send`
calls the existing `sendChatMessage({ chatSessionId: activeSession.id, ... })`.
The server resumes via the stored resume pointers. The returned detail updates
`activeSession`, and the list reorders (the touched session moves to the top,
matching the existing `[detail, ...withoutCurrent]` logic — extended to also
update the matching `ChatSession` summary fields like `updatedAt`).

### Relative time helper

A small pure function `formatRelativeTime(iso: string, now = Date.now())`:
- `< 60s` → `just now`
- `< 60m` → `Nm ago`
- `< 24h` → `Nh ago`
- otherwise → `Nd ago`

Kept local to the web app (a tiny module, e.g. `apps/web/src/relative-time.ts`)
so it is unit-testable in isolation.

## Testing

- Unit test `formatRelativeTime` boundaries (just now / minutes / hours / days).
- Extend `apps/web/src/__tests__/app.test.tsx`:
  - Renders multiple session rows with titles and relative times.
  - Clicking a row calls `getChatSession` and renders that session's history.
  - `+ New chat` clears the active session and message input.
  - Sending with a session selected calls `sendChatMessage` with that session's
    id (resume path), not `createChatSession`.

## Out of scope (YAGNI)

- Renaming, deleting, or archiving sessions from the UI.
- Search / filter over sessions.
- Per-row live task status badges (would require extra fetches).
- Real-time list updates / polling.
