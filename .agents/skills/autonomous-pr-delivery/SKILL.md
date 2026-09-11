---
name: autonomous-pr-delivery
description: Use when implementing repository changes or resuming their protected PR delivery in JueZ/api.
---

# Autonomous PR delivery

Complete authorized changes through protected merge and applicable runtime verification. Planning, analysis, and review remain read-only. The root [operating contract](../../../AGENTS.md) defines authority and safety boundaries; ordinary delivery repair inherits the implementation request's authorization.

## Implement and publish

Confirm the protected base, branch, head, and working tree; preserve user changes. Resolve focused regressions, formatting, and lint during implementation. When correctness depends on a changed external CLI/API assumption, inspect actual behavior or representative sanitized responses; distinguish unavailable live evidence from mock coverage.

For substantial semantics, complete the `semantic-falsification` independent critic and repair credible findings before the final local validation set, without an additional required check or human approval. Include the concise semantic result in the PR.

Run `npm run validate:affected -- --base <protected-base-sha>` once for the finished diff. Repeat passing checks only for changed inputs or a concrete concern. Commit intentionally, verify the exact commit and repository-scoped authentication, push, and create/update the PR. Enable the root contract's exact-head native squash auto-merge.

## Verify delivery

Required evidence is exact-head `PR Gate` and `Security Gate`, then protected merge. Advisory checks create no extra merge requirement. Monitor with bounded structured queries, for example:

```bash
gh pr view <number> --repo JueZ/api \
  --json url,state,mergeStateStatus,headRefOid,autoMergeRequest,statusCheckRollup
gh run list --repo JueZ/api --workflow delivery-v2.yml --limit 10 \
  --json databaseId,status,conclusion,headSha,createdAt
```

Emit only state transitions and a final summary. PR/run metadata is terminal evidence; full successful logs and repeating watchers add no proof.

After merge, follow protected-main `Delivery v2`. The trusted cumulative classification and repository variables determine applicability: only proven runtime-neutral work skips build/deployment. Applicable releases must promote one immutable artifact through test and production exact-SHA/digest, public/authenticated smoke, telemetry, release-identity, and rollback-safety gates. If superseded, verify the change is in the newer protected-main SHA and follow its generation; a skipped promotion is not success.

On a failed check, delivery, or resumed repair, read [bounded repair](references/repair.md) before retrying or changing the repair strategy. Add `github-cli-devops` only for non-routine GitHub diagnosis or configuration.

## Final report

Report the outcome, PR link, exact head/merge identity, local and protected checks, applicable Delivery v2/runtime evidence, and remaining blockers. Distinguish unexercised, unavailable, and non-applicable evidence. Update material project memory in the substantive PR; do not open a follow-up bookkeeping PR solely to copy terminal run IDs.
