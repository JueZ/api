# Project memory

Project memory is repo-based persistent context for future Codex sessions and maintainers. It is transparent, versioned, reviewable, and stored in `docs/project-memory/`.

Project memory is not a secret store and is not a replacement for `AGENTS.md`. `AGENTS.md` remains the global rulebook for agent behavior, while project memory records concise facts, decisions, incidents, deployments, known issues, glossary terms, and next steps.

For non-trivial work, read `current-state.md` first. Read `known-issues.md` or `next-steps.md` only when relevant to the task. Read chronological decision, deployment, and incident logs only for a historical investigation; routine work must not preload them.

Codex should update project memory when meaningful project state changes. Examples include an architecture decision, deployment failure or success, root cause discovery, important workaround, authentication or security behavior change, or changed next milestone.

Keep active trackers concise and factual. Mark uncertainty clearly. Prefer links to pull requests, issues, or workflow runs over pasted logs. Put resolved or superseded status in the chronological logs/archive rather than leaving it in `current-state.md`, `known-issues.md`, or `next-steps.md`.

Update memory in the substantive PR when durable state changes. Do not open a follow-up PR solely to copy terminal run IDs already available from the merged PR or workflow unless an active incident or authoritative program explicitly requires a reviewed state transition.

Never include secrets, tokens, SAS URLs, connection strings, full environment dumps, full app settings, private keys, or private credentials in project memory.

Use `docs/adr/` for formal architecture decisions. Project memory remains lightweight operational memory and current project context.
