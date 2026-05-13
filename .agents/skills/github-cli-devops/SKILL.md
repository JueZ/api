---
name: github-cli-devops
description: Use this skill when working with GitHub CLI, pull requests, workflow runs, CI logs, repository variables, labels, branch protection, auto-merge, GitHub Actions debugging, or repo automation in JueZ/api.
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
- repository automation
- Codex repair/debug loops

## Before using gh

Verify authentication first:

    gh auth status
    gh repo view JueZ/api

If authentication fails, do not guess. Report that GitHub CLI auth is missing or expired.

## Common PR commands

Use these for pull requests:

    gh pr list --repo JueZ/api
    gh pr view <number> --repo JueZ/api
    gh pr checks <number> --repo JueZ/api --watch
    gh pr diff <number> --repo JueZ/api
    gh pr merge <number> --repo JueZ/api --auto --squash --delete-branch

Only use auto-merge when CI and Policy Check are expected to pass.

Do not bypass branch protection.

## Common workflow commands

Use these for workflow runs:

    gh run list --repo JueZ/api --limit 10
    gh run view <run-id> --repo JueZ/api
    gh run view <run-id> --repo JueZ/api --log-failed
    gh run watch <run-id> --repo JueZ/api --exit-status

Prefer reading failed workflow logs before guessing fixes.

When fixing CI, make the smallest safe patch.

## Repository variables

Use repository variables for non-secret configuration:

    gh variable list --repo JueZ/api
    gh variable set <NAME> --body <VALUE> --repo JueZ/api

Examples of non-secret variables:
- AZURE_CLIENT_ID
- AZURE_TENANT_ID
- AZURE_SUBSCRIPTION_ID
- AZURE_RESOURCE_GROUP
- PRODUCTION_BASE_URL
- DEPLOY_PRODUCTION_ENABLED

Do not set DEPLOY_PRODUCTION_ENABLED=true unless explicitly requested.

## Secrets

Never print, echo, log, commit, or expose:
- GH_TOKEN
- GITHUB_TOKEN
- CODEX_GH_TOKEN
- Azure client secrets
- access tokens
- refresh tokens
- private keys
- connection strings

Use repository secrets only for secrets.

Do not inspect or reveal secret values.

## Guardrails

Never disable these to make a check pass:
- tests
- security scan
- secret scan
- dependency audit
- cost-policy check
- guardrail policy check
- branch protection
- auto-merge safety gates

Do not weaken authentication, authorization, JWT checks, allowlists, or deployment guardrails.

## High-risk paths

Treat changes to these paths as high risk:

    .github/workflows/**
    .github/actions/**
    AGENTS.md
    infra/**
    apps/api/src/shared/security/**
    apps/api/src/shared/config/**
    docs/security/**
    docs/cost/**

High-risk changes are allowed only with clear explanation, conservative implementation, and full verification.

## Final summary

For GitHub CLI work, include:
- PR URL
- CI result
- Policy Check result
- auto-merge status
- GitHub CLI commands run
- workflow runs inspected
- logs inspected
- unresolved risks
- remaining manual steps
