# Next steps

1. Run Microsoft Entra app registration setup with a delegated user or identity that has app registration read/write permissions.
2. Create or reuse `juez-api-catalogue-api-prod` and expose `api.access`.
3. Create or reuse `juez-api-catalogue-web-prod` and configure redirect URIs for production static website and local dev.
4. Determine Martin's allowed Microsoft Entra user object ID using delegated Azure CLI or a known UPN; do not use email/display name as the backend allowlist identifier.
5. Set the GitHub auth repository variables for PR #40.
6. Re-run PR #40 checks, then squash merge through branch protection.
7. Re-enable `DEPLOY_PRODUCTION_ENABLED=true` only when auth variables are configured and deploy PR #40 from `main`.
8. Verify `/health` remains public, unauthenticated `/api/hello` returns 401, and browser login can call `/api/hello` as the allowlisted user.
9. After staged deployment merges, run or inspect `Deploy Test` on `main`, confirm the test base URL and smoke tests, then inspect automatic `Promote Production`.
10. Decide whether the GitHub `production` environment should require reviewers; for a solo project, avoid preventing self-review unless another reviewer exists.
11. Harden run-from-package deployment away from expiring SAS if feasible.
12. Add the first real API connector after auth works.
