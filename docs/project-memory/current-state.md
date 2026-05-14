# Current state

Last updated: 2026-05-14

- Project name: JueZ API Catalogue.
- Repository: `JueZ/api`.
- Goal: personal API catalogue platform.
- Frontend: Angular app in `apps/web`.
- Backend: Azure Functions TypeScript app in `apps/api`.
- API contract: `contracts/openapi.yaml`.
- Infrastructure: `infra/main.bicep`.
- Azure resource groups: `rg-api-test` for test and `rg-api-prod` for production.
- Azure region: `westeurope`.
- Production API base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular static website URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Production Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Production static website storage account: `stapicatalogueprodbfjsts`.
- Azure Functions runtime: Node 22.
- Current code on `main` includes OAuth/OIDC JWT validation, a server-side user allowlist, protected `GET /api/hello` behavior when `AUTH_ENABLED=true`, Angular MSAL sign-in/token acquisition, OpenAPI bearer security, and Bicep auth app settings.
- Current production deployment does **not** yet match the auth-enabled code on `main`: direct verification on 2026-05-14 showed `GET /health` returns `200` and unauthenticated `GET /api/hello` still returns the pre-auth public placeholder response with `authenticated:false`.
- Current v0 endpoint truth:
  - Code: `GET /health` is public; `GET /api/hello` is protected by application-level JWT validation when `AUTH_ENABLED=true`.
  - Production as verified on 2026-05-14: `GET /health` is public; `GET /api/hello` is still public/pre-auth until a successful auth-enabled deployment reaches production.
- GitHub auth-related repository variables are present, including `AUTH_ENABLED=true`, OIDC variables, and web auth variables. Variable values are non-secret configuration, but project memory intentionally records only presence/status, not full auth configuration.
- `DEPLOY_PRODUCTION_ENABLED=false` remains set as a fail-safe variable. The reusable deployment workflow now fails closed for `prod` unless this variable is explicitly `true`. The current staged promotion workflows are `deploy-test.yml`, `promote-production.yml`, `rollback-production.yml`, and reusable `deploy-environment.yml`; production was not deployed during the consolidation sprint.
- Deployment packaging uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access (`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`), not SAS-backed package URLs.
- Staged deployment bootstrap status verified on 2026-05-14:
  - GitHub environments `test` and `production` exist.
  - Azure resource groups `rg-api-test` and `rg-api-prod` exist.
  - Test and production Function Apps, App Insights instances, plans, and storage accounts exist.
  - `Deploy Test` most recently succeeded on `main` at run `25849812564`.
  - `Promote Production` most recently skipped after test; production auth deployment remains unverified.
  - Codex could not verify Microsoft Entra app registrations or federated credentials because the current Azure principal lacked sufficient Microsoft Graph privileges.
  - Codex could not verify deployment-principal RBAC assignments from the available app/client ID because Graph lookup was insufficient and no object ID was available in project memory.
- `deploy-production.yml` is retained as a manual legacy wrapper; normal flow should use `Deploy Test` followed by `Promote Production`.
- Next milestone: finish verifying staged deployment prerequisites that require directory/RBAC visibility, then run an auth-enabled test deployment and promote to production only through guarded workflows after test smoke tests pass.

## 2026-05-14 readiness sprint update

- Auth-enabled test deployment was verified at run `25851944897`: test `GET /health` returned `200`, and unauthenticated test `GET /api/hello` returned `401`.
- Auth-enabled production deployment was promoted at run `25852035606`: production `GET /health` returned `200`, and unauthenticated production `GET /api/hello` returned `401`.
- `Promote Production` run `25852035606` still concluded `failure` because the post-smoke repository-variable metadata update could not write variables with `GITHUB_TOKEN`; the deployment and smoke tests themselves passed.
- `DEPLOY_PRODUCTION_ENABLED=true` was intentionally set during this readiness sprint so guarded production promotion can run after test deployment succeeds.
- Production Function App system-assigned managed identity was verified after the production promotion.
- Rollback remains workflow-based through `.github/workflows/rollback-production.yml`, using the same reusable deployment path for a requested known-good commit.

## 2026-05-14 final readiness verification update

- PR #60 was merged by auto-merge after CI and Policy Check passed.
- `Deploy Test` was manually re-run from `main` after PR #60 at run `25852557000` and succeeded.
- `Promote Production` was manually re-run from `main` after PR #60 at run `25852638254` and succeeded end-to-end.
- Production smoke remained healthy after the final promotion: `GET /health` returned `200`, and unauthenticated `GET /api/hello` returned `401`.
- The post-smoke repository-variable metadata updates now produce warnings if `GITHUB_TOKEN` cannot write repository variables, but they no longer fail a healthy deployment.
