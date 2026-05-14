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
- Production base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Storage account: `stapicatalogueprodbfjsts`.
- Runtime: Azure Functions Node 22.
- Current v0 endpoints:
  - `GET /health` is public.
  - `GET /api/hello` is a public placeholder.
- Authentication: not implemented yet.
- Next milestone: real OAuth/OIDC/JWT authentication for protected API routes.
- Production deployment: currently passing after the Node runtime fix.
- Important warning: deployment currently uses SAS-backed `WEBSITE_RUN_FROM_PACKAGE` and should be hardened later.
