---
name: autonomous-pr-delivery
description: Use this skill for every repository-changing Codex task in JueZ/api to complete the branch, commit, push, pull request, checks, and delivery-status report loop safely.
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

2. Complete `change-quality-gate`, then run the smallest relevant local validation set for the change when the environment allows.

   Common examples:

   ```bash
   npm run type-check
   npm test
   npm run test:api
   npm run build
   npm run ops:preflight-change
   npm run ops:policy-guardrails:worktree
   ```

   If a command cannot run because credentials, network, tools, or environment variables are unavailable, record it as blocked or skipped with the reason. Do not treat skipped checks as passing.

   If `.github/security-deployment-hold.json` is active or a static credential-incident block remains in `deploy-environment.yml`, `migrate-private-storage.yml`, `bring-readonly-canary.yml`, or `verify-azure-oidc.yml`, report delivery as security-blocked. Run `npm run ops:verify-github-deployment-controls`; drift is also blocking. Never remove, override, or route around the hold, including with local cloud commands. The incident record is active-only because GitHub is affected and no independent security approver is configured. Evidence may be recorded while the hold remains active, but recovery requires external credential revocation and an out-of-band trust-root bootstrap. Security-control paths in `merge.autonomousExcludedPaths` cannot use autonomous merge.

3. Confirm the PR evidence sections are ready: behavior/risk, tests, documentation/memory, deployment/rollback, and limitations. Commit the change if it is not already committed:

   ```bash
   git status --short
   git add <changed-files>
   git commit -m "<concise task summary>"
   git log -1 --oneline
   ```

   After committing, validate the complete branch diff rather than only the last commit:

   ```bash
   npm run ops:policy-guardrails:branch
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

   - `merge exact PR head`
   - `run main delivery after Codex auto-merge`
   - `CI`
   - `Policy Check`
   - `Deploy Test`
   - `Promote Production`

   A PR touching `merge.autonomousExcludedPaths` is expected to be rejected by the autonomous controller. Report the independent security-review/bootstrap requirement; do not relabel, split deceptively, or weaken policy to make it eligible.

9. If checks fail, apply the smallest safe fix and repeat at most 2 repair attempts for the same failing area.

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
