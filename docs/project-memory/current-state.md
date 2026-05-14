# Current state

Last updated: 2026-05-14

- Project name: JueZ API Catalogue.
- Repository: `JueZ/api`.
- Goal: personal API catalogue platform.
- Frontend: Angular app in `apps/web`.
- Backend: Azure Functions TypeScript app in `apps/api`.
- API contract: `contracts/openapi.yaml`.
- Infrastructure: `infra/main.bicep`.
- Azure resource group: `rg-api-prod`.
- Azure region: `westeurope`.
- Production API base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular static website URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Storage account: `stapicatalogueprodbfjsts`.
- Runtime: Azure Functions Node 22.
- Current v0 endpoints:
  - `GET /health` is public.
  - `GET /api/hello` is a public placeholder.
- Authentication: implemented in PR #40 but not yet merged or deployed. Production still runs the pre-auth placeholder.
- Next milestone: create/reuse Microsoft Entra app registrations, set GitHub auth variables, merge PR #40, and deploy auth.
- Production deployment: currently passing after the Node runtime fix, but `DEPLOY_PRODUCTION_ENABLED=false` was set on 2026-05-14 as a fail-safe while auth configuration is incomplete.
- Important warning: deployment currently uses SAS-backed `WEBSITE_RUN_FROM_PACKAGE` and should be hardened later.
