# Next steps

## Current active next steps from 2026-05-14 consolidation

## 2026-05-14 readiness sprint next steps

1. Merge the readiness follow-up PR that makes production repository-variable updates best-effort/idempotent after smoke tests.
2. Re-run `Deploy Test` on `main` and confirm it passes.
3. Re-run `Promote Production` on `main` and confirm the whole workflow concludes success, not just deployment/smoke success.
4. Use a delegated Microsoft Entra identity with app-registration read permissions to verify API app, SPA app, redirect URIs, delegated permission, consent state, and GitHub OIDC federated credentials.
5. Manually verify browser authentication at the production Angular URL with the allowlisted Microsoft Entra user.
6. After the production workflow concludes green and manual browser auth is verified, begin normal feature development with a small non-Reddit, non-expensive API catalogue slice.

1. Verify Microsoft Entra app registration state with a delegated identity that can read app registrations, including API scope/role exposure, SPA app registration, production/test redirect URIs, and intended GitHub OIDC federated credentials.
2. Verify the GitHub Actions deployment service principal object ID, then confirm least-privilege RBAC on `rg-api-test` and `rg-api-prod`.
3. Run `Deploy Test` from `main` after prerequisite verification and confirm smoke tests use the auth-enabled expectation (`/health` returns `200`; unauthenticated `/api/hello` returns `401`).
4. Promote production through `promote-production.yml` only after test passes, `DEPLOY_PRODUCTION_ENABLED=true` is intentionally set, and any required GitHub environment approvals are satisfied.
5. After production promotion, verify production `/health`, unauthenticated `/api/hello`, and browser sign-in to `/api/hello` for the configured allowlisted user.
6. Update project memory immediately after the first successful auth-enabled production deployment.
7. Keep `deploy-production.yml` as a legacy/manual wrapper unless a later cleanup decides to remove it safely.
8. Add the first real API connector only after auth-enabled production is verified. Reddit remains intentionally out of scope.

The older numbered list below is retained for guardrail traceability. Items about implementing auth code are superseded by PR #40 on `main`; remaining deployment/prerequisite work is captured above.

1. Implement real OAuth/OIDC/JWT authentication.
2. Add backend JWT validation with issuer, audience, scope, and user allowlist checks.
3. Add Angular login UI and token acquisition.
4. Update the OpenAPI security scheme.
5. Add tests for 401, 403, and allowed-user behavior.
6. Deploy auth configuration safely.
7. Harden run-from-package deployment away from expiring SAS if feasible.
8. Add the first real API connector after auth works.
9. Grant the GitHub Actions Azure deployment identity `Role Based Access Control Administrator` at `rg-api-prod` scope, or make a safe infra change that avoids deployment-time role assignment writes.
10. After staged deployment merges, run or inspect `Deploy Test` on `main`, confirm the test base URL and smoke tests, then inspect automatic `Promote Production`.
11. Decide whether the GitHub `production` environment should require reviewers; for a solo project, avoid prevent self-review unless another reviewer exists.

## Auth setup detail for PR #40

1. Run Microsoft Entra app registration setup with a delegated user or identity that has app registration read/write permissions.
2. Create or reuse `juez-api-catalogue-api-prod` and expose `api.access`.
3. Create or reuse `juez-api-catalogue-web-prod` and configure redirect URIs for production static website and local dev.
4. Determine Martin's allowed Microsoft Entra user object ID using delegated Azure CLI or a known UPN; do not use email/display name as the backend allowlist identifier.
5. Set the GitHub auth repository variables for PR #40.
6. Re-run PR #40 checks, then squash merge through branch protection.
7. Re-enable `DEPLOY_PRODUCTION_ENABLED=true` only when auth variables are configured and deploy PR #40 from `main`.
8. Verify `/health` remains public, unauthenticated `/api/hello` returns 401, and browser login can call `/api/hello` as the allowlisted user.
11. Run staged deployment setup commands in `docs/setup/staged-deployment.md` with an Azure principal that can create `rg-api-test` and assign scoped RBAC roles.
12. Verify the repo `production-rollback` skill works during the first real rollback drill.
