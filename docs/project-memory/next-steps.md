# Next steps

1. Implement real OAuth/OIDC/JWT authentication.
2. Add backend JWT validation with issuer, audience, scope, and user allowlist checks.
3. Add Angular login UI and token acquisition.
4. Update the OpenAPI security scheme.
5. Add tests for 401, 403, and allowed-user behavior.
6. Deploy auth configuration safely.
7. Harden run-from-package deployment away from expiring SAS if feasible.
8. Add the first real API connector after auth works.
9. After staged deployment merges, run or inspect `Deploy Test` on `main`, confirm the test base URL and smoke tests, then inspect automatic `Promote Production`.
10. Decide whether the GitHub `production` environment should require reviewers; for a solo project, avoid prevent self-review unless another reviewer exists.

## Auth setup detail for PR #40

1. Run Microsoft Entra app registration setup with a delegated user or identity that has app registration read/write permissions.
2. Create or reuse `juez-api-catalogue-api-prod` and expose `api.access`.
3. Create or reuse `juez-api-catalogue-web-prod` and configure redirect URIs for production static website and local dev.
4. Determine Martin's allowed Microsoft Entra user object ID using delegated Azure CLI or a known UPN; do not use email/display name as the backend allowlist identifier.
5. Set the GitHub auth repository variables for PR #40.
6. Re-run PR #40 checks, then squash merge through branch protection.
7. Re-enable `DEPLOY_PRODUCTION_ENABLED=true` only when auth variables are configured and deploy PR #40 from `main`.
8. Verify `/health` remains public, unauthenticated `/api/hello` returns 401, and browser login can call `/api/hello` as the allowlisted user.
