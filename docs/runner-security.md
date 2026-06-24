# Runner Security Assumptions

v0.1.1 keeps API keys runtime-only. The browser sends the key for one message, the API passes it to the runner for that task, and neither service stores the raw key in Postgres.

The API redacts task output, assistant Markdown, and task messages before persistence. The runner also redacts raw Codex stdout/stderr before returning it.

Current limitations:

- Codex mode uses a broad local workspace sandbox for the demo runner.
- The UI does not expose permissions controls.
- `session_id` and `work_dir` are product-internal resume pointers and are not primary user-facing UI concepts.
- Persistent resume requires the runner workspace directory to survive runner restarts.
- v0.1.1 does not implement encrypted secret storage.
