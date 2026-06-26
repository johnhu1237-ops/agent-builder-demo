# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repo.

## Before exploring, read these

- `CONTEXT.md` at the repo root for project language.
- `docs/adr/` for architectural decisions that touch the area being changed.

If any of these files do not exist, proceed silently. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions get resolved.

## Use the glossary's vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept needed is not in the glossary yet, either reconsider the language or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
