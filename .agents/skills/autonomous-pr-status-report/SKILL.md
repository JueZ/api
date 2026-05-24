---
name: autonomous-pr-status-report
description: Use this skill to produce the required autonomous-delivery final status report (PR URL, CI/policy/deploy/smoke/automerge/repair status) and to run the minimal GitHub CLI checks that populate it.
---

# Autonomous PR Status Report Skill

Use this when a repository-changing task needs a reliable, repeatable final delivery report.

This skill standardizes a recurring workflow seen across recent sessions:
- gather PR status evidence from GitHub CLI
- verify required gates at a glance
- report explicit blocked/unknown states instead of guessing

## Inputs

- current branch name
- repository: `JueZ/api`
- optional PR number (if already known)

## Procedure

1. Resolve branch and PR:

    git branch --show-current
    gh pr list --repo JueZ/api --head <branch> --json number,url,state,isDraft,mergeStateStatus,headRefName,baseRefName

2. If PR exists, capture checks and auto-merge indicators:

    gh pr view <number> --repo JueZ/api --json url,state,isDraft,mergeStateStatus,autoMergeRequest,commits,statusCheckRollup
    gh pr checks <number> --repo JueZ/api

3. Capture recent workflow outcomes relevant to autonomous delivery:

    gh run list --repo JueZ/api --limit 20

   Prefer identifying latest runs for:
   - `CI`
   - `Policy Check`
   - `Deploy Test`
   - `Promote Production`

4. Classify each required report field as one of:
   - `passed`
   - `failed`
   - `pending`
   - `blocked` (missing permission/input/dependency)
   - `not_triggered` (not expected for this task)
   - `unknown` (evidence unavailable)

5. Include repair loop status:
   - count repair commits/attempts for the branch during current task
   - if none, report `0`
   - if repeated failure reaches 2 attempts, stop and escalate

## Output template

- PR URL
- CI result
- Policy check result
- auto-merge status
- Deploy Test result
- production deployment result
- smoke test result
- repair attempts used
- remaining risks / blocked checks

## Guardrails

- Never claim success for any gate without command evidence.
- If PR lookup fails, report the exact failing command.
- Do not bypass branch protection or disable checks.
- Do not expose secrets/tokens in output.
