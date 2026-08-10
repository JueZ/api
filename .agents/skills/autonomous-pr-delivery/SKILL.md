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

6. Required PR evidence is exact-head `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete`, plus successful protected merge. The aggregate controller still checks every latest check/status result.
7. After merge, monitor `Codex Main Delivery`, its exact-main CI, and applicable Deploy Test/Promote Production/runtime evidence. A trusted runtime-neutral decision makes deployment, smoke, telemetry, and release-ledger evidence not applicable; do not wait for absent workflows or call them passing.
8. On failure, inspect only failed logs, make the smallest safe repair, and use no more than two attempts for the same area.

Useful failed-run command:

```bash
gh run view <run-id> --repo JueZ/api --log-failed
```

Do not download or print full successful logs merely to prove success. PR/run metadata is the primary terminal evidence.

## Guardrails

Never push to `main`, bypass protection, force merge, weaken validation/auth/security/delivery, expose credentials, delete resources without explicit authorization, or claim completion when the PR/delivery is blocked. A skipped or unavailable command is not passing evidence.

Do not open a follow-up bookkeeping PR solely to transcribe terminal run IDs already linked from the merged PR unless an active incident or authoritative program requires a reviewed state transition.

## Final report

Report branch, exact head, PR, four aggregate results, merge commit, Main Delivery/exact-main CI, applicable deployment/runtime proof, repair attempts, local checks, blockers, project-memory changes, and remaining risk. Collapse non-applicable deployment fields into one concise statement.
