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
- Production base URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Function App: `func-api-catalogue-prod-bfjstshehpbfk`.
- Storage account: `stapicatalogueprodbfjsts`.
- Runtime: Azure Functions Node 22.
- Current v0 endpoints:
  - `GET /health` is public.
  - `GET /api/hello` is a public placeholder.
- Authentication: not implemented yet.
- Next milestone: real OAuth/OIDC/JWT authentication for protected API routes.
- Deployment flow: staged test-to-production promotion is being introduced. `Deploy Test` targets `rg-api-test` with `environmentName=test`; `Promote Production` targets `rg-api-prod` with `environmentName=prod` only after test smoke tests pass.
- Important warning: deployment currently uses storage-backed `WEBSITE_RUN_FROM_PACKAGE` package URLs and should be hardened later if operational needs require it.

- Rollback support: repo skill `.agents/skills/production-rollback/SKILL.md` records the standard `rollback-production.yml` flow for future Codex sessions.
- Staged deployment setup commands: `docs/setup/staged-deployment.md` records the Azure CLI and GitHub CLI commands for environments, OIDC, RBAC, deployment, promotion, and rollback.
