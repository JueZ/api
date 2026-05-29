---
name: project-memory-maintainer
description: Use this skill when a task changes architecture, deployment behavior, Azure/GitHub setup, authentication, security, CI/CD, production incidents, important decisions, known issues, operational state, or next steps in JueZ/api.
---

# Project Memory Maintainer Skill

Use this skill to keep repo-based project memory accurate across Codex sessions.

Project memory lives in:

```text
docs/project-memory/
```

Common project-memory files include, when present:

```text
docs/project-memory/current-state.md
docs/project-memory/decision-log.md
docs/project-memory/deployment-log.md
docs/project-memory/incident-log.md
docs/project-memory/known-issues.md
docs/project-memory/next-steps.md
docs/project-memory/README.md
```

## Read before work

Read relevant project memory before non-trivial tasks involving:

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
- operational state

## Update after meaningful changes

Update project memory when:

- an important architecture decision is made
- production deployment behavior changes
- a new Azure resource is introduced
- a deployment succeeds or fails in a meaningful way
- a production or test incident occurs
- a root cause is discovered
- a workaround is introduced
- authentication/security behavior changes
- next steps change
- a previous assumption becomes wrong
- a known issue is resolved or becomes stale
- operational state changes in a way future Codex sessions need to know

Do not update project memory for trivial formatting-only changes unless they affect setup, operations, security, deployment, or future work.

## File selection guidance

Use the most specific file:

- `current-state.md` — current deployment/runtime/project state that future sessions need first.
- `decision-log.md` — durable decisions and rationale.
- `deployment-log.md` — meaningful deploy, promotion, rollback, or smoke-test outcomes.
- `incident-log.md` — incidents, root causes, fixes, and prevention.
- `known-issues.md` — unresolved or recurring problems.
- `next-steps.md` — actionable follow-up tasks.
- `README.md` — memory system guidance, not routine project updates.

If an entry is stale, update or supersede it instead of duplicating contradictory information.

Use reverse chronological order for logs where the file already follows that convention.

## Safety rules

Never include:

- secrets
- tokens
- SAS URLs
- connection strings
- full environment variable dumps
- full app settings
- private keys
- full raw logs containing sensitive data
- bearer tokens or Authorization headers
- private credentials

Prefer concise factual entries.

Prefer links to PRs, issues, or workflow runs over long pasted logs.

Mark uncertainty clearly.

Keep public-safe diagnostics only.

## Final response

At the end of relevant tasks, final response must say:

- whether project memory was updated
- which files were updated
- what changed
- any remaining uncertainty
