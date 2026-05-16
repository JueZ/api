# Autonomous guardrails

Autonomous delivery is allowed only when automated controls fail closed. This document describes the security and policy guardrails that protect no-human auto-merge.

## Non-negotiable controls

Automation must not:

- Disable authentication on protected APIs.
- Remove JWT validation.
- Remove the Martin/user allowlist while it is required for v0.
- Add unauthenticated expensive endpoints.
- Log tokens, credentials, or secrets.
- Commit secrets.
- Remove budget alerts or cost-policy checks.
- Increase Azure permissions without documentation.
- Add Azure SQL, Cosmos DB, API Management, Front Door, or other paid Azure services without a cost note.
- Disable tests, linting, security scanning, secret scanning, dependency auditing, or policy checks.
- Change GitHub Actions permissions to broad write access without justification.

## High-risk files

Changes to the following paths require extra care and must pass policy checks:

- `.github/workflows/**`
- `.github/actions/**`
- `infra/**`
- `apps/api/src/shared/security/**`
- `apps/api/src/shared/config/**`
- `docs/security/**`
- `docs/cost/**`
- `AGENTS.md`
- Authentication, authorization, JWT, role, scope, deployment, or Azure permission logic anywhere in the repository.

## Required automated checks

The protected branch should require CI, security, and policy checks before auto-merge. The aggregate `CI complete` and `Policy complete` jobs make it easier to configure branch protection, but the individual jobs should remain visible and required where supported.

## GitHub token recursion caution

GitHub Actions events created by the default `GITHUB_TOKEN` usually do not trigger new workflow runs, except explicit `workflow_dispatch` and `repository_dispatch`. `Codex Main Delivery` therefore uses explicit `workflow_dispatch` calls after Codex auto-merge and waits for `CI` -> `Deploy Test` -> `Promote Production` to succeed for the delivered `main` commit. Use explicit dispatches rather than accidental recursive workflow chains.

## Failure handling

Production deployment and smoke-test failures must remain visible. The deployment workflow creates an issue containing the failed workflow run and commit. Repair automation is bounded to two attempts and must stop rather than looping forever.
