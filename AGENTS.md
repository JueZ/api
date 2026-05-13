## Autonomous delivery mode

The user wants this project to run with no routine human approval.

Codex may create or update pull requests. If all required checks pass and repository auto-merge is enabled, PRs may be merged automatically. Production deployment may run automatically after merge to `main`.

However, autonomous delivery must be guarded by strict automated policy checks.

## Required autonomous pipeline

The normal loop should be:

1. Codex implements a change on a branch.
2. Codex opens or updates a pull request.
3. CI runs.
4. If CI fails, Codex may inspect logs and make the smallest safe fix.
5. Codex may repeat the fix loop at most 2 times.
6. If CI passes and policy checks pass, the PR may auto-merge.
7. Merge to `main` triggers production deployment.
8. Production smoke tests run.
9. If smoke tests fail, automation must fail closed and create a repair issue or PR.

## No-human auto-merge rules

Human review is not required for routine changes if all required checks pass.

Required checks must include at least:

- install
- lint
- type-check
- unit tests
- API tests
- Angular build
- Azure Functions build
- OpenAPI validation
- Bicep validation
- security scan
- secret scan
- dependency audit
- cost-policy check

Direct pushes to `main` must be disabled.

Force pushes to `main` must be disabled.

PRs should use squash merge or linear history.

## Production deployment

Production deployment may run automatically after merge to `main`.

Production deployment must use GitHub Actions with Azure OIDC.

Do not use long-lived Azure client secrets for deployment unless there is no practical alternative.

Production deployment must run smoke tests after deployment.

If smoke tests fail:

- mark deployment as failed
- create a GitHub issue with logs
- optionally trigger a bounded Codex repair workflow
- do not hide the failure
- do not repeatedly redeploy in an infinite loop

## Autonomous repair loop

Codex may repair CI failures automatically.

Limits:

- maximum 2 repair attempts per PR
- no infinite loops
- no repeated commits that do not change the failure
- no disabling tests to make CI pass
- no weakening auth/security to make CI pass
- no removing policy checks
- no committing secrets

If the same failure repeats after 2 attempts, Codex must stop and summarize the failure.

## Files requiring extra protection

Changes to these paths must be treated as high risk:

- `.github/workflows/**`
- `.github/actions/**`
- `infra/**`
- `apps/api/src/shared/security/**`
- `apps/api/src/shared/config/**`
- `docs/security/**`
- `docs/cost/**`
- `AGENTS.md`
- any file containing authentication, authorization, JWT, role, scope, deployment, or Azure permission logic

High-risk changes may still be proposed, but they must pass additional policy checks.

## Automatic block conditions

The pipeline must fail closed if a change:

- disables authentication on a protected API
- removes JWT validation
- removes the Martin/user allowlist in v0
- adds unauthenticated expensive endpoints
- logs tokens or secrets
- commits secrets
- removes budget alerts
- increases Azure permissions without documentation
- adds Azure SQL, Cosmos DB, API Management, Front Door, or other paid services without cost note
- disables tests, linting, security scanning, or policy checks
- changes GitHub Actions permissions to broad write access without justification

## GitHub workflow trigger caution

Be aware that events caused by GitHub Actions `GITHUB_TOKEN` usually do not trigger new workflow runs, except explicit `workflow_dispatch` and `repository_dispatch`.

When chaining workflows, prefer explicit `workflow_dispatch` or `repository_dispatch`, or use GitHub-native auto-merge after required checks pass.

Do not design accidental recursive workflow loops.

## Final summary requirement

For every autonomous task, Codex must report:

- PR URL
- CI result
- auto-merge status
- production deployment result
- smoke test result
- repair attempts used
- remaining risks or blocked checks
