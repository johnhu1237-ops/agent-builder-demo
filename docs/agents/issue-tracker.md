# Issue tracker: GitHub Issues

Issues for this repo live in GitHub Issues:

https://github.com/johnhu1237-ops/agent-builder-demo/issues

Use `gh issue` commands from the repo root when creating, reading, or updating
issues.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `johnhu1237-ops/agent-builder-demo`.

- Use the issue body template required by the active skill.
- Apply the matching triage label from `docs/agents/triage-labels.md`.
- Publish dependency blockers first so later issues can reference real GitHub
  issue URLs in their `Blocked by` section.

## When a skill says "fetch the relevant ticket"

Use `gh issue view <number-or-url> --comments` to read the issue body and
conversation.
