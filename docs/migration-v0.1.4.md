# Migrating to v0.1.4: Encrypted API Keys

## Overview

v0.1.4 introduces encrypted server-side storage for LLM API keys. API keys are no longer sent with every message from the frontend.

## Before You Deploy

1. Generate a master encryption key:
   ```bash
   openssl rand -hex 32
   ```

2. Set the `LLM_API_KEY_ENCRYPTION_KEY` environment variable in your deployment

3. **Back up this key securely** — losing it means losing access to all stored API keys

## Deployment

1. Deploy the new API server version
2. Database migration adds the `encrypted_api_key` column automatically

## After Deployment

### For New Agents

- API key is now required when creating an agent
- Users enter the key once during agent creation

### For Existing Agents

- Existing agents will not have encrypted keys
- Attempting to send a message will return: "Agent API key not configured"
- Users must update each agent via:
  - UI: Edit agent → Enter API key
  - API: `PUT /api/agents/:id` with `apiKey` field

## API Changes

### Creating Agents

**Before**:
```bash
POST /api/agents
{
  "spec": { ... }
}
```

**After**:
```bash
POST /api/agents
{
  "spec": { ... },
  "apiKey": "sk-..."  # REQUIRED
}
```

### Updating Agents

**Before**:
```bash
PUT /api/agents/:id
{
  "spec": { ... }
}
```

**After**:
```bash
PUT /api/agents/:id
{
  "spec": { ... },
  "apiKey": "sk-..."  # OPTIONAL: only if changing the key
}
```

### Sending Messages

**Before**:
```bash
POST /api/chat-sessions/:id/messages
{
  "message": "Hello",
  "runtimeSecrets": {
    "apiKey": "sk-..."  # Required on every message
  }
}
```

**After**:
```bash
POST /api/chat-sessions/:id/messages
{
  "message": "Hello"
  # No apiKey needed — retrieved from agent
}
```

## Troubleshooting

### "LLM_API_KEY_ENCRYPTION_KEY environment variable is required"

The server requires this environment variable to start. Generate one using `openssl rand -hex 32` and set it in your deployment.

### "Agent API key not configured"

This agent was created before v0.1.4 and doesn't have an API key stored. Update the agent via the UI or API to add a key.

### "Failed to decrypt API key for agent"

The master encryption key may have changed, or the encrypted data is corrupted. Check that `LLM_API_KEY_ENCRYPTION_KEY` is set correctly and hasn't changed since the keys were encrypted.
