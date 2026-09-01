---
name: autonomous-pr-delivery
description: Use this skill for every repository-changing task in JueZ/api to complete protected branch, commit, PR, checks, merge, and applicable delivery reporting.
---

# Autonomous PR delivery

Use this skill for routine repository delivery. Add `github-cli-devops` only for diagnostics, configuration, branch protection, or a failing/non-routine GitHub operation.

## Procedure

1. Confirm protected `main`, branch, head, and working tree. Work only on a non-`main` `codex/...` branch.
2. Implement one coherent change. Run one complete local set selected from the protected-base diff and affected risk surface. Do not repeat dependency installation, unchanged application builds, or an already passing check unless the diff, base, environment, or failure changed. Local proportionality never skips or weakens protected remote aggregates or applicable delivery/runtime proof.
   For a substantial semantic change, use `semantic-falsification` before committing: perform its independent critic
   phase, repair credible defects, and include its concise outcome/invariants/falsification/evidence result in the PR.
   This is autonomous review, not an additional required check or human approval.
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
7. After merge, monitor the protected-main `Delivery v2` DAG. Repository-level delivery variables and the trusted classifier determine applicability; routine deployment and production promotion require no per-task approval. A trusted runtime-neutral classification makes build and environment deployment not applicable. Deployment-impacting changes are incomplete until the one immutable artifact passes test and production exact-SHA/digest, public/authenticated smoke, telemetry, release-identity, and applicable rollback-safety gates. If a generation is superseded, verify the requested change is contained in the confirmed newer protected-main SHA and follow that SHA's Delivery v2 generation; the skipped promotion is not success.
8. On failure, inspect only the failed job and minimum relevant logs, fingerprint the cause, and make the smallest safe repair. Use at most three meaningful attempts in one repair generation. Two ineffective attempts with one strategy fingerprint require re-diagnosis and a materially different hypothesis; they do not end the task. Allow one unchanged rerun only for a demonstrated flaky or external failure. When the generation or current execution budget ends, persist the active continuation with attempted strategies, evidence, next discriminating action, and resume trigger. Use the protected-main `Repair and Learning Queue` workflow-dispatch progress input bound to the exact source run; record only public-safe advisory state, set `dry_run=false` to persist it, and use an exact expected candidate SHA when handing a protected-main repair to its next generation.

Useful failed-run command:

```bash
gh run view <run-id> --repo JueZ/api --log-failed
```

Do not download or print full successful logs merely to prove success. PR/run metadata is the primary terminal evidence.

## Guardrails

Never push to `main`, bypass protection, force merge, weaken validation/auth/security/delivery, expose credentials, delete resources without explicit authorization, or claim completion when the PR/delivery is blocked. These are hard invariants. Other architectural conventions guide the default but may be challenged by stronger scoped evidence and a validated minimal deviation. A skipped or unavailable command is not passing evidence.

Do not open a follow-up bookkeeping PR solely to transcribe terminal run IDs already linked from the merged PR.

## Final report

Report branch, exact head, PR, `PR Gate`, `Security Gate`, native auto-merge, merge commit, Delivery v2 classification, applicable deployment/runtime proof, repair attempts grouped by strategy fingerprint, active continuation or blocker, local checks, project-memory changes, and remaining risk. Mark unexercised or non-applicable behavior explicitly rather than calling it passing.
