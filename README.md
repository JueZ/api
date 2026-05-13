# JueZ API Catalogue

v0 Hello World skeleton for a personal API catalogue platform.

## What is here

- Angular frontend in `apps/web`.
- Azure Functions TypeScript backend in `apps/api`.
- OpenAPI contract in `contracts/openapi.yaml`.
- Low-cost Bicep infrastructure skeleton in `infra/main.bicep`.
- Setup documentation in `docs/setup/v0-hello-world.md`.

## Quick start

```bash
npm install
npm run build
npm test
```

The v0 backend exposes `GET /health` and `GET /api/hello`. Authentication is intentionally a placeholder
until the next OAuth/OIDC/JWT milestone.
