---
name: autonomous-pr-delivery
description: Use this skill to run the mandatory branch->commit->push->PR->checks->status report loop for repository-changing Codex tasks in JueZ/api.
---

# Autonomous PR Delivery Skill

Use this skill whenever a Codex task changes repository files and must complete autonomous delivery safely.

## Purpose

Package the repeated manual PR-delivery workflow into one consistent checklist so Codex sessions do not skip:
- remote/auth preflight
- branch push
- PR create/update
- CI/policy status checks
- final runtime-truth delivery summary

## Inputs

- Current branch with committed changes (must not be `main`)
- GitHub CLI auth on the host
- Repository: `JueZ/api`

## Procedure

1. Verify branch and commit state:

    git branch --show-current
    git status --short
    git log -1 --oneline

   Stop if the current branch is `main`; create a non-`main` working branch first.

2. Run mandatory PR preflight and repair (safe, local, idempotent):

    git remote -v
    gh auth status
    gh repo view JueZ/api
    gh auth setup-git --hostname github.com

   If `origin` is missing, add it:

    git remote add origin https://github.com/JueZ/api.git

3. Push current non-`main` branch with upstream tracking:

    git push -u origin "$(git branch --show-current)"

4. Create or update PR explicitly against repository:

    gh pr view --repo JueZ/api || gh pr create --repo JueZ/api --fill

5. Collect autonomous-delivery status evidence:

    PR_NUMBER="$(gh pr view --repo JueZ/api --json number --jq .number)"
    gh pr checks "$PR_NUMBER" --repo JueZ/api
    gh pr view "$PR_NUMBER" --repo JueZ/api --json url,state,isDraft,mergeStateStatus,autoMergeRequest

6. If checks fail, inspect failed job logs first, then apply the smallest safe fix and repeat at most 2 repair attempts:

    gh run list --repo JueZ/api --limit 10
    gh run view <run-id> --repo JueZ/api --log-failed

## Required Output

Final task report must include:
- PR URL
- CI/policy status (pass/fail/pending + blockers)
- auto-merge status
- production deployment + smoke-test status (or not triggered/blocked)
- repair attempts used
- remaining risks/blocked checks

## Safety Guardrails

Never:
- bypass branch protection
- disable tests/policy/security checks to force green
- weaken auth/JWT/allowlist protections
- commit or print secrets/tokens
- claim completion if PR creation/update failed

If PR creation/update fails, fail closed and report exact failed command.
