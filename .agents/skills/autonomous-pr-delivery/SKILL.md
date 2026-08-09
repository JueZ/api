---
name: autonomous-pr-delivery
description: Use this skill for every repository-changing Codex task in JueZ/api to complete the branch -> commit -> push -> PR -> checks -> delivery-status report loop safely.
---

# Autonomous PR Delivery Skill

Use this skill whenever a Codex task changes repository files.

## Purpose

Complete repository-changing work through the required autonomous delivery loop without skipping:

- branch and commit verification
- local validation evidence
- remote/auth preflight
- branch push
- PR create/update
- CI and Policy Check monitoring
- auto-merge status
- post-merge delivery status when available
- runtime-truth delivery summary

## Inputs

- Repository: `JueZ/api`
- Current working tree with intended changes, or a branch with committed changes
- GitHub CLI auth on the host
- A non-`main` branch for repository-changing work

## Procedure

1. Verify branch and working tree state:

   ```bash
   git branch --show-current
   git status --short
   git log -1 --oneline
   ```

   If on `main`, create or switch to a non-`main` branch before committing.

2. Run the smallest relevant local validation set for the change when the environment allows.

   Batch the complete locally validated change before pushing. Every new exact head on a high-risk PR can require one paid independent review, so do not push exploratory, partially validated, or no-op repair commits. A failed remote head may receive at most the documented meaningful repair attempts.

   Common examples:

   ```bash
   npm run type-check
   npm test
   npm run test:api
   npm run build
   npm run ops:policy-guardrails
   ```

   If a command cannot run because credentials, network, tools, or environment variables are unavailable, record it as blocked or skipped with the reason. Do not treat skipped checks as passing.

3. Commit the change if it is not already committed:

   ```bash
   git status --short
   git add <changed-files>
   git commit -m "<concise task summary>"
   git log -1 --oneline
   ```

4. Run mandatory PR preflight and safe recovery:

   ```bash
   git remote -v
   gh auth status
   gh repo view JueZ/api
   gh auth setup-git --hostname github.com
   ```

   If `origin` is missing, add it:

   ```bash
   git remote add origin https://github.com/JueZ/api.git
   ```

   If `origin` points to the wrong repository, fix it:

   ```bash
   git remote set-url origin https://github.com/JueZ/api.git
   ```

   Before pushing a high-risk change, run the repository risk classifier and read the non-secret `AUTONOMOUS_REVIEW_CAPACITY_READY` repository variable. If the change is high risk and the variable is not exactly `true`, keep the complete work local and stop with the capacity blocker instead of creating a head that cannot receive independent review. Low-risk changes remain eligible for deterministic approval without model capacity.

   A sanitized trusted-review result of `credit_balance_exhausted` may set this variable to `false` because that mutation only makes delivery fail earlier and cannot bypass a gate. Set it to `true` only when usable capacity for the existing review project is known to be available. The variable records capacity state; it is not an approval or authorization signal. Never inspect, replace, or reveal the shared API key.

5. Push the current non-`main` branch with upstream tracking:

   ```bash
   git push -u origin "$(git branch --show-current)"
   ```

6. Create or update the pull request explicitly against the repository:

   ```bash
   gh pr view --repo JueZ/api || gh pr create --repo JueZ/api --fill
   ```

7. Collect autonomous-delivery status evidence:

   ```bash
   gh pr view --repo JueZ/api --json url,state,isDraft,mergeStateStatus,autoMergeRequest,headRefName,headRefOid,baseRefName,labels
   gh pr checks --repo JueZ/api --watch
   gh run list --repo JueZ/api --limit 20
   ```

8. For Codex PRs, monitor the relevant delivery checks and workflows:

   - `enable auto-merge`
   - `run main delivery after Codex auto-merge`
   - `CI`
   - `Policy Check`
   - `Deploy Test`
   - `Promote Production`

9. If checks fail, diagnose the exact failed job before retrying or changing the branch.

   Before using `gh run rerun` for a failed high-risk `Codex Auto-Merge` run, inspect the exact-head check rollup for the canonical `Autonomous review paid-call claim` marker. When that completed neutral GitHub Actions marker exists, the permanent one-paid-call boundary has already been consumed and Codex must not rerun the autonomous review workflow for the same head. A same-head rerun is deterministically denied and cannot repair an unavailable or rejected review.

   Preserve the claim and its cost/idempotency boundary. Never delete, rewrite, release, or bypass it. Only a substantive scoped correction may produce a new exact head and a new protected review; a no-op commit, metadata-only retry commit, or repeated commit that does not address the failure is forbidden. If the failure is external and no substantive correction is available, stop with the exact blocker and create or update the required learning disposition instead of looping.

   For other recoverable failures, apply the smallest safe fix and repeat at most 2 repair attempts for the same failing area. Treat a workflow rerun as an attempt in that area even when it creates no commit.

10. Stop when delivery reaches a terminal result or a concrete blocker is found.

## Required output

Final task report must include:

- Branch name
- Commit SHA
- PR URL
- CI and Policy Check status
- Auto-merge status
- `Deploy Test` status when applicable
- `Promote Production` status when applicable
- Smoke/runtime-truth status when applicable
- Repair attempts used
- Blockers, skipped checks, and remaining risks

## Safety guardrails

Never:

- bypass branch protection
- Do not bypass, remove, disable, or weaken tests, policy checks, security scans, dependency audits, secret scans, required status checks, telemetry gates, smoke tests, or deployment gates to make delivery pass
- weaken auth, JWT validation, role checks, allowlists, or deployment guardrails
- commit, print, paste, or expose secrets/tokens
- delete Azure or GitHub resources unless explicitly requested
- claim completion if PR creation/update failed

If PR creation/update fails, fail closed and report the exact failed command.
