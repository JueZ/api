---
name: autonomous-delivery-audit
description: Use this skill to produce a consistent delivery-truth report for a branch/PR: PR URL, CI/policy status, auto-merge status, deploy test/promote production outcomes, smoke-test evidence, repair-attempt count, and remaining blockers.
---

# Autonomous Delivery Audit Skill

Use this when checking whether a Codex task is truly complete under repo guardrails.

## Inputs
- branch name OR PR number
- optional expected commit SHA
- optional environment focus: `test`, `production`, or `both`

## Output (stopping condition)
A single structured report containing:
- PR URL
- CI result
- Policy Check result
- auto-merge status
- Deploy Test result (if applicable)
- Promote Production result (if applicable)
- smoke-test result (public + authenticated when token is available)
- repair attempts used (max 2)
- blockers/risks and exact failing command/check

Stop when each required gate is either:
1) verified by evidence, or
2) explicitly marked blocked with the failed command/workflow link.

## Procedure
1. Validate repo and auth:

       git remote -v
       gh auth status
       gh repo view JueZ/api

2. Resolve branch->PR and metadata:

       gh pr list --repo JueZ/api --head <branch>
       gh pr view <pr> --repo JueZ/api
       gh pr checks <pr> --repo JueZ/api

3. Confirm auto-merge state and merge strategy safety:

       gh pr view <pr> --repo JueZ/api --json autoMergeRequest,mergeStateStatus,isDraft,url

4. Inspect recent workflow runs for exact SHA:

       gh run list --repo JueZ/api --limit 30
       gh run view <run-id> --repo JueZ/api
       gh run view <run-id> --repo JueZ/api --log-failed

   Prefer successful runs tied to the exact commit before treating later duplicate cancelled runs as terminal.

5. Verify deployment/smoke truth when required:
- deployable/runtime/auth/workflow/infra changes require deploy-test and production truth checks.
- include `/health` SHA/source-ref match evidence when available.
- if `AUTH_ACCESS_TOKEN` is missing for protected endpoint smoke, mark `blocked` (not passed).

6. Count repair attempts:
- count Codex fix loops on same PR from commit/run history.
- stop at 2 attempts and summarize repeated failure.

7. Emit concise report with evidence links and blockers.

## Guardrails
- Never disable tests, scans, policy checks, or branch protection.
- Never weaken auth/JWT/allowlists to pass checks.
- Never print tokens/secrets.
- Do not claim completion without PR + evidence-backed gate status.

## Notes
- Use with `github-cli-devops` and `azure-observability-diagnostics` for deeper CI/deploy/runtime evidence.
- For project-impacting findings, update `docs/project-memory/` via `project-memory-maintainer`.
