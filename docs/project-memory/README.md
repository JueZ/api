# Project memory

Project memory is repo-based persistent context for future Codex sessions and maintainers. It is transparent, versioned, reviewable, and stored in `docs/project-memory/`.

Project memory is not a secret store and is not a replacement for `AGENTS.md`. `AGENTS.md` remains the global rulebook for agent behavior, while project memory records concise facts, decisions, incidents, deployments, known issues, glossary terms, and next steps.

Codex should read project memory at the beginning of non-trivial tasks, especially work involving architecture, Azure, GitHub Actions, deployment, authentication, authorization, security, CI/CD, production incidents, infrastructure, or major bug fixes.

Codex should update project memory when meaningful project state changes. Examples include an architecture decision, deployment failure or success, root cause discovery, important workaround, authentication or security behavior change, or changed next milestone.

Keep entries concise and factual. Mark uncertainty clearly. Prefer links to pull requests, issues, or workflow runs over pasted logs.

Never include secrets, tokens, SAS URLs, connection strings, full environment dumps, full app settings, private keys, or private credentials in project memory.

If `docs/adr/` is added later, use ADRs for formal architecture decisions. Project memory remains lightweight operational memory and current project context.
