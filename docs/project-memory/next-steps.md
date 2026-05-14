# Next steps

1. Create or reuse Microsoft Entra API and SPA app registrations.
2. Add local development, production frontend, and test frontend redirect origins to the SPA app registration if one shared SPA client is used.
3. Determine Martin's allowed Microsoft Entra user object ID using delegated Azure CLI or a known UPN; do not use email/display name as the backend allowlist identifier.
4. Set the shared GitHub auth repository variables and run `Deploy Test` so test validates the same auth behavior as production.
5. Promote production only after test smoke tests confirm `/health` is public and unauthenticated `/api/hello` returns 401.
6. Harden run-from-package deployment away from expiring SAS if feasible.
7. Add the first real API connector after auth works.
8. Grant the GitHub Actions Azure deployment identity `Role Based Access Control Administrator` at `rg-api-prod` scope, or make a safe infra change that avoids deployment-time role assignment writes.
9. Decide whether the GitHub `production` environment should require reviewers; for a solo project, avoid prevent self-review unless another reviewer exists.

## Auth setup detail

1. Run Microsoft Entra app registration setup with a delegated user or identity that has app registration read/write permissions.
2. Create or reuse `juez-api-catalogue-api-prod` and expose `api.access`.
3. Create or reuse `juez-api-catalogue-web-prod` and configure redirect URIs for production static website, test static website, and local dev.
4. Set the shared GitHub auth repository variables documented in `docs/setup/staged-deployment.md`.
5. Verify `/health` remains public, unauthenticated `/api/hello` returns 401 in test and production, and browser login can call `/api/hello` as the allowlisted user.
6. Run staged deployment setup commands in `docs/setup/staged-deployment.md` with an Azure principal that can create `rg-api-test` and assign scoped RBAC roles.
7. Verify the repo `production-rollback` skill works during the first real rollback drill.
