---
name: project-memory-maintainer
description: Use this skill when a task changes architecture, deployment behavior, Azure/GitHub setup, authentication, security, CI/CD, production incidents, important decisions, known issues, or next steps in JueZ/api.
---

# Project Memory Maintainer Skill

Use this skill to keep repo-based project memory accurate across Codex sessions.

Project memory lives in:

    docs/project-memory/

Read project memory before non-trivial tasks involving:
- architecture
- Azure
- GitHub Actions
- deployment
- authentication
- authorization
- security
- CI/CD
- production incidents
- infrastructure
- major bug fixes
- long-running multi-step work

Update project memory when:
- an important architecture decision is made
- production deployment changes
- a new Azure resource is introduced
- a deployment succeeds or fails in a meaningful way
- a root cause is discovered
- a workaround is introduced
- authentication/security behavior changes
- next steps change
- a previous assumption becomes wrong

Do not update project memory for trivial formatting-only changes unless they affect setup or operations.

Rules:
- Never include secrets.
- Never include tokens.
- Never include SAS URLs.
- Never include connection strings.
- Never include full environment variable dumps.
- Never include full app settings.
- Never include private keys.
- Prefer concise factual entries.
- Prefer links to PRs, issues, or workflow runs over long pasted logs.
- Use reverse chronological order for logs.
- Mark uncertainty clearly.
- If a memory entry is stale, update it instead of duplicating contradictory information.

At the end of relevant tasks, final response must say:
- whether project memory was updated
- which files were updated
- what changed
- any remaining uncertainty
