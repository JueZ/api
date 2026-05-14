# Current state

Last updated: 2026-05-14

- Project name: JueZ API Catalogue.
- Repository: `JueZ/api`.
- Goal: personal API catalogue platform.
- Frontend: Angular app in `apps/web`.
- Backend: Azure Functions TypeScript app in `apps/api`.
- API contract: `contracts/openapi.yaml`.
- Infrastructure: `infra/main.bicep`.
- Azure tenant: `7ac3dfd6-e810-4693-805a-9535eb3ab166`.
- Azure subscription: `cb89936b-f739-42db-bd9f-bbdd0f052ee7`.
- Azure resource groups: `rg-api-test` for test and `rg-api-prod` for production.
- Azure region: `westeurope`.
- Production API base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular static website URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Production Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Production static website storage account: `stapicatalogueprodbfjsts`.
- Test Function App verified during the readiness sprint: `func-api-catalogue-test-iwt54bovfzvrc`.
- Test static website storage account verified during the readiness sprint: `stapicataloguetestiwt54b`.
- Azure Functions runtime: Node 22.
- Code on `main` includes OAuth/OIDC JWT validation, a server-side object-ID/user allowlist, protected `GET /api/hello` behavior when `AUTH_ENABLED=true`, Angular MSAL sign-in/token acquisition, OpenAPI bearer security, and Bicep auth app settings.
- Current endpoint truth after the 2026-05-14 readiness sprint:
  - Test `GET /health` returns `200`.
  - Test unauthenticated `GET /api/hello` returns `401` when `AUTH_ENABLED=true`.
  - Production `GET /health` returns `200`.
  - Production unauthenticated `GET /api/hello` returns `401` when `AUTH_ENABLED=true`.
- GitHub auth-related repository variables are present, including `AUTH_ENABLED=true`, OIDC variables, and web auth variables. Variable values are non-secret configuration, but project memory intentionally records only presence/status, not full auth configuration.
- `DEPLOY_PRODUCTION_ENABLED=true` was intentionally set during the readiness sprint so guarded production promotion can run after test deployment succeeds.
- Deployment packaging uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access (`WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`), not SAS-backed package URLs.
- Staged deployment status verified on 2026-05-14:
  - GitHub environments `test` and `production` exist.
  - Azure resource groups `rg-api-test` and `rg-api-prod` exist in `westeurope`.
  - Test and production Function Apps, system-assigned managed identities, App Insights instances, plans, and storage accounts exist.
  - `Deploy Test` succeeded on `main` at run `25851944897`.
  - `Promote Production` at run `25852035606` deployed the auth-enabled code and passed smoke tests, but the workflow concluded `failure` because its post-smoke repository-variable update step could not write variables with `GITHUB_TOKEN`.
  - PR follow-up should make post-smoke repository-variable updates best-effort/idempotent so successful production deployments are not marked failed for metadata-only updates.
  - Codex could not verify Microsoft Entra app registrations or federated credentials because the current Azure principal lacks sufficient Microsoft Graph privileges.
  - Codex verified resource-group-scoped RBAC role assignments for service principals are present on `rg-api-test` and `rg-api-prod`, including `Contributor`, `Storage Blob Data Contributor`, and `Role Based Access Control Administrator`; Graph limits prevented mapping every assignment to the exact app display name/object ID.
- `deploy-production.yml` is retained as a manual legacy wrapper; normal flow should use `Deploy Test` followed by `Promote Production`.
- Rollback uses `.github/workflows/rollback-production.yml`, which calls the same reusable deployment path for the requested commit and production environment.
- Setup is close to ready for normal feature development. The remaining platform blocker is merging the metadata-update workflow fix and re-running production promotion to get a fully green production workflow conclusion. Manual browser sign-in remains pending because Codex cannot perform interactive Entra login in this environment.

## 2026-05-14 readiness sprint update

- Auth-enabled test deployment was verified at run `25851944897`: test `GET /health` returned `200`, and unauthenticated test `GET /api/hello` returned `401`.
- Auth-enabled production deployment was promoted at run `25852035606`: production `GET /health` returned `200`, and unauthenticated production `GET /api/hello` returned `401`.
- `Promote Production` run `25852035606` still concluded `failure` because the post-smoke repository-variable metadata update could not write variables with `GITHUB_TOKEN`; the deployment and smoke tests themselves passed.
- `DEPLOY_PRODUCTION_ENABLED=true` was intentionally set during this readiness sprint so guarded production promotion can run after test deployment succeeds.
- Production Function App system-assigned managed identity was verified after the production promotion.
- Rollback remains workflow-based through `.github/workflows/rollback-production.yml`, using the same reusable deployment path for a requested known-good commit.
