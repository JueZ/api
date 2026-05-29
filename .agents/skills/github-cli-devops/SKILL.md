---
name: github-cli-devops
description: Use this skill when working with GitHub CLI, pull requests, workflow runs, CI logs, repository variables, labels, branch protection, auto-merge, Codex Main Delivery, GitHub Actions debugging, or repo automation in JueZ/api.
---

# GitHub CLI DevOps Skill

Use `gh` for GitHub operations when it gives better observability than editing files alone.

This skill is for:

- pull requests
- CI and Policy Check investigation
- GitHub Actions workflow runs
- failed job logs
- labels
- repository variables
- repository secrets metadata
- branch protection inspection
- auto-merge investigation
- Codex Main Delivery monitoring
- Deploy Test and Promote Production monitoring
- repository automation
- Codex repair/debug loops

## Before using gh

Verify authentication first:

```bash
gh auth status
gh repo view JueZ/api
```

If authentication fails, do not guess. Report that GitHub CLI auth is missing or expired.

## Common PR commands

Use these for pull requests:

```bash
gh pr list --repo JueZ/api
gh pr view <number> --repo JueZ/api
gh pr view <number> --repo JueZ/api --json url,state,isDraft,mergeStateStatus,autoMergeRequest,headRefName,headRefOid,baseRefName,labels,mergeCommit
gh pr checks <number> --repo JueZ/api --watch
gh pr diff <number> --repo JueZ/api
gh pr merge <number> --repo JueZ/api --auto --squash --delete-branch
```

Only use auto-merge when CI and Policy Check are expected to pass.

Do not bypass branch protection.

Do not force-merge, bypass required checks, remove checks, disable checks, or weaken required review/protection settings to make delivery easier.

## Common workflow commands

Use these for workflow runs:

```bash
gh run list --repo JueZ/api --limit 20
gh run view <run-id> --repo JueZ/api
gh run view <run-id> --repo JueZ/api --log-failed
gh run watch <run-id> --repo JueZ/api --exit-status
```

Useful workflow-specific checks:

```bash
gh run list --repo JueZ/api --workflow ci.yml --branch main --limit 5
gh run list --repo JueZ/api --workflow policy-check.yml --limit 5
gh run list --repo JueZ/api --workflow codex-automerge.yml --limit 5
gh run list --repo JueZ/api --workflow codex-main-delivery.yml --limit 5
gh run list --repo JueZ/api --workflow deploy-test.yml --branch main --limit 5
gh run list --repo JueZ/api --workflow promote-production.yml --branch main --limit 5
```

Prefer reading failed workflow logs before guessing fixes.

When fixing CI, make the smallest safe patch.

## Delivery evidence to collect

For Codex PR delivery, collect:

- PR URL and state
- PR branch and head SHA
- CI status
- Policy Check status
- `enable auto-merge` status
- `run main delivery after Codex auto-merge` status when applicable
- `Deploy Test` status when applicable
- `Promote Production` status when applicable
- failed job name, failed step, failed command, and run URL for blockers

If a PR is merged manually or through a non-Codex path, still inspect and report any resulting `main` CI, `Deploy Test`, `Promote Production`, smoke, and runtime-truth status when available.

## Repository variables

Use repository variables for non-secret configuration:

```bash
gh variable list --repo JueZ/api
gh variable set <NAME> --body <VALUE> --repo JueZ/api
```

Examples of non-secret variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP` for Azure OIDC verification or diagnostics; staged deploys use fixed `rg-api-test` and `rg-api-prod` workflow inputs
- `PRODUCTION_BASE_URL` as an optional production base URL override; deployment can also discover the Function App hostname
- `DEPLOY_PRODUCTION_ENABLED`

Do not set `DEPLOY_PRODUCTION_ENABLED=true` unless the operator/user explicitly requests enabling production deployment and the guardrails, approval posture, and risk are documented.

Do not enable `DEPLOY_PRODUCTION_ENABLED` merely because a production promotion, rollback, or deployment workflow is blocked.

## Secrets

Never print, echo, log, commit, or expose:

- `GH_TOKEN`
- `GITHUB_TOKEN`
- `CODEX_GH_TOKEN`
- Azure client secrets
- access tokens
- refresh tokens
- private keys
- connection strings
- SAS URLs

Use repository secrets only for secrets.

Do not inspect or reveal secret values.

## Guardrails

Never bypass, remove, disable, or weaken these to make a check pass:

- tests
- lint
- type checks
- security scan
- secret scan
- dependency audit
- cost-policy check
- guardrail policy check
- required status checks
- branch protection
- auto-merge safety gates
- deployment smoke gates
- telemetry gates

Do not weaken authentication, authorization, JWT checks, allowlists, or deployment guardrails.

Do not delete GitHub resources unless the user explicitly requested deletion.

## High-risk paths

Treat changes to these paths as high risk:

```text
.github/workflows/**
.github/actions/**
AGENTS.md
infra/**
apps/api/src/shared/security/**
apps/api/src/shared/config/**
docs/security/**
docs/cost/**
```

High-risk changes are allowed only with clear explanation, conservative implementation, and full verification.

## Final summary

For GitHub CLI work, include:

- PR URL
- Branch name and commit SHA when relevant
- CI result
- Policy Check result
- Auto-merge status
- Codex Main Delivery status when relevant
- Deploy Test status when relevant
- Promote Production status when relevant
- Smoke/runtime-truth status when relevant
- GitHub CLI commands run
- Workflow runs inspected
- Logs inspected
- Unresolved risks
- Remaining manual steps
