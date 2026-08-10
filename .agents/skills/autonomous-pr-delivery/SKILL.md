---
name: autonomous-pr-delivery
description: Use this skill for every repository-changing task in JueZ/api to complete protected branch, commit, PR, checks, merge, and applicable delivery reporting.
---

# Autonomous PR delivery

Use this skill for routine repository delivery. Add `github-cli-devops` only for diagnostics, configuration, branch protection, or a failing/non-routine GitHub operation.

## Procedure

1. Confirm protected `main`, branch, head, and working tree. Work only on a non-`main` `codex/...` branch.
2. Implement one coherent change. Run one complete local set selected from the protected-base diff and affected risk surface. Do not repeat dependency installation, unchanged application builds, or an already passing check unless the diff, base, environment, or failure changed. Local proportionality never skips or weakens protected remote aggregates or applicable delivery/runtime proof.
3. Commit intentionally, verify the exact commit, confirm repository-scoped GitHub authentication, push, and create/update the PR.
4. For high-risk or multi-phase work, lead progress updates with the active phase, its status, and the next exact slice.
5. Monitor compactly with structured one-shot queries. Emit only state transitions and a final summary; do not use continuously repeating `--watch` output. For example:

   ```bash
   gh pr view <number> --repo JueZ/api \
     --json url,state,mergeStateStatus,headRefOid,autoMergeRequest,statusCheckRollup
   gh run list --repo JueZ/api --limit 20 \
     --json databaseId,workflowName,event,status,conclusion,headSha,createdAt
   ```

6. Required PR evidence is exact-head `PR Gate` and `Security Gate`, followed by GitHub-native protected squash merge. Optional or advisory checks are reported but do not become undeclared merge requirements.
7. After merge, monitor the protected-main `Delivery v2` DAG. A trusted runtime-neutral classification makes build and environment deployment not applicable. Deployment-impacting changes require the one immutable artifact to pass test and production exact-SHA/digest, public/authenticated smoke, telemetry, release-identity, and applicable rollback-safety gates.
8. On failure, inspect only the failed job and minimum relevant logs, fingerprint the cause, and make the smallest safe repair. Use at most three meaningful repair commits, stop when the same fingerprint repeats twice without progress, and allow one unchanged rerun only for a demonstrated flaky or external failure.

Useful failed-run command:

```bash
gh run view <run-id> --repo JueZ/api --log-failed
```

Do not download or print full successful logs merely to prove success. PR/run metadata is the primary terminal evidence.

## Guardrails

Never push to `main`, bypass protection, force merge, weaken validation/auth/security/delivery, expose credentials, delete resources without explicit authorization, or claim completion when the PR/delivery is blocked. A skipped or unavailable command is not passing evidence.

Do not open a follow-up bookkeeping PR solely to transcribe terminal run IDs already linked from the merged PR.

## Final report

Report branch, exact head, PR, `PR Gate`, `Security Gate`, native auto-merge, merge commit, Delivery v2 classification, applicable deployment/runtime proof, repair attempts, local checks, blockers, project-memory changes, and remaining risk. Mark unexercised or non-applicable behavior explicitly rather than calling it passing.
