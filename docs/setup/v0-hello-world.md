# v0 Hello World skeleton

This milestone creates the smallest useful foundation for the personal API catalogue platform:
Angular for the frontend, Azure Functions for the backend, OpenAPI for the API contract, and
Bicep for low-cost Azure infrastructure planning.

## App structure

- `apps/web` — standalone Angular application with a simple landing page.
- `apps/api` — TypeScript Azure Functions app with thin HTTP handlers.
- `contracts/openapi.yaml` — OpenAPI 3.1 contract for the v0 endpoints.
- `infra/main.bicep` — conservative Bicep skeleton for a consumption-based Function App.
- `docs` — setup and operations documentation.

## Implemented

- `GET /health` returns public service health:
  - `status: ok`
  - `service: api-catalogue`
  - current UTC `timestamp`
- `GET /api/hello` returns the v0 Hello World payload for Martin.
- The Angular page shows the project name, API catalogue placeholder, future hello endpoint test link,
  and an explicit note that production authentication is not fully implemented yet.
- Root npm scripts run local lint, type-check, test, API test, frontend build, and Functions build checks.
- Bicep targets `westeurope` and the existing production resource group workflow (`rg-api-prod`) without
  deploying anything from this change.

## Intentionally not implemented yet

- Reddit integration.
- OAuth/OIDC/JWT authentication enforcement.
- Production deployment or `DEPLOY_PRODUCTION_ENABLED` changes.
- Azure SQL, Cosmos DB, API Management, Front Door, Cognitive Services, Kubernetes, or other expensive
  always-on services.
- Secrets or local settings committed to the repository.

## Local setup

Install dependencies from the repository root:

```bash
npm install
```

Build everything:

```bash
npm run build
```

Run type-checks:

```bash
npm run type-check
```

Run tests:

```bash
npm test
npm run test:api
```

Build only the Azure Functions app:

```bash
npm run build:api
```

Build only the Angular app:

```bash
npm run build:web
```

## Local development notes

The Azure Functions source is in `apps/api/src`. The reusable response builders live under
`apps/api/src/shared` so handlers remain thin. To run the Functions host locally later, install Azure
Functions Core Tools and provide local-only settings outside source control.

The Angular app is intentionally framework-light and uses only Angular's standalone component model and
plain CSS.

## Infrastructure notes

`infra/main.bicep` is scoped to a resource group and defaults to `westeurope`. It defines a low-cost
serverless foundation:

- Standard LRS storage account required by Azure Functions.
- Linux consumption Azure Functions hosting plan (`Y1` dynamic SKU).
- Function App on Node.js 20.
- Application Insights for basic observability.

This change does not deploy infrastructure. Validate Bicep locally with:

```bash
az bicep build --file infra/main.bicep
```

## Next milestone

Implement real OAuth/OIDC/JWT authentication and authorization before adding protected production APIs.
The `/api/hello` endpoint is a protected-placeholder only; it must not be treated as proof that production
authentication exists.
