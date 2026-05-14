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
- Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Storage account: `stapicatalogueprodbfjsts`.
- Runtime: Azure Functions Node 22.
- Current v0 endpoints:
  - `GET /health` is public.
  - `GET /api/hello` is protected when `AUTH_ENABLED=true`; unauthenticated smoke tests should receive `401`.
- Authentication: OAuth/OIDC JWT validation and Angular MSAL plumbing are in the codebase. Test and production deployments must use the same issuer, audience, required scope, tenant filter, and allowed user object IDs so test validates the production auth shape before promotion.
- Next milestone: create/reuse Microsoft Entra app registrations, add both production and test frontend redirect origins to the SPA registration, set GitHub auth variables, and deploy through test before production promotion.
- Deployment flow: staged test-to-production promotion is active. `Deploy Test` targets `rg-api-test` with `environmentName=test`; `Promote Production` targets `rg-api-prod` with `environmentName=prod` only after test smoke tests pass.
- Production deployment: currently passing after the Node runtime fix, but `DEPLOY_PRODUCTION_ENABLED=false` was set on 2026-05-14 as a fail-safe while auth configuration is incomplete.
- Important warning: deployment currently uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` package URLs and should be hardened later if operational needs require it.

- Rollback support: repo skill `.agents/skills/production-rollback/SKILL.md` records the standard `rollback-production.yml` flow for future Codex sessions.
- Staged deployment setup commands: `docs/setup/staged-deployment.md` records the Azure CLI and GitHub CLI commands for environments, OIDC, RBAC, deployment, promotion, and rollback.
