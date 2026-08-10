# JueZ API Catalogue

A low-cost personal API catalogue with an Angular frontend, Azure Functions TypeScript backend, OpenAPI contracts, and one bundled MCP server.

## Repository map

- `apps/web/` — Angular frontend.
- `apps/api/` — Azure Functions backend.
- `contracts/openapi.yaml` — public API contract.
- `contracts/openapi.gpt.yaml` — GPT Actions contract.
- `infra/` — test and production Azure Bicep.
- `.github/workflows/` — protected validation, delivery, repair, and operational workflows.

The backend exposes public `GET /health`. Protected operations use OAuth/OIDC JWT validation, granular operation permissions, audit, idempotency, and confirmation for destructive operations. Repairable REST failures use `application/problem+json`; the bundled `/mcp` route returns the same sanitized contract in structured content.

## Local development

Use Node.js 22.

```bash
npm install
npm run build
npm test
```

Useful focused commands:

```bash
npm run lint
npm run type-check
npm run test:api
npm run test:gates
npm run test:delivery
npm run test:repair
npm run ops:check-openapi-drift
npm run ops:check-operation-drift
npm run ops:policy-guardrails
```

## Autonomous delivery

A feature request starts the full path:

```text
Codex branch and focused validation
  -> protected PR
  -> PR Gate + Security Gate
  -> native exact-head squash auto-merge
  -> Delivery v2 on protected main
  -> one immutable build
  -> test deployment and verification
  -> same-digest production promotion and verification
  -> one bounded rollback and repair issue when needed
```

`main` requires exactly `PR Gate` and `Security Gate`. Release artifacts are never built on pull requests. Documentation-only changes skip application validation and environment deployment; unknown or privileged changes fail closed to broad validation.

Delivery uses GitHub Actions OIDC, build provenance, SHA-256 release identity, public and authenticated smoke tests, telemetry correlation, and compact release ledgers. Test and production receive the same Function package, environment-neutral frontend bundle, and SBOM digests; only environment-specific frontend configuration is rendered separately.

Production promotion is automatic when `DELIVERY_V2_ENABLED=true` and `DEPLOY_PRODUCTION_ENABLED=true`. Immediately before promotion, the workflow reads current `main` once and skips a superseded generation. Production and rollback share `production-deployment` concurrency. Automatic rollback is attempted once only when the just-deployed release is observed in production and one unambiguous previous verified Delivery v2 artifact remains available.

See [autonomous delivery](docs/autonomous-delivery.md), [security guardrails](docs/security/autonomous-guardrails.md), and [staged deployment setup](docs/setup/staged-deployment.md).

## Runtime endpoints

| Environment | API base URL                                                      | Angular frontend                                            |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Test        | <https://func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net> | <https://stapicataloguetestiwt54b.z6.web.core.windows.net/> |
| Production  | <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net> | <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/> |

For both environments, `GET /health` is public and unauthenticated `GET /api/hello` returns `401` while authentication is enabled.

## Operational boundaries

- Never deploy production from a local shell or use long-lived Azure credentials.
- Never put tokens, connection strings, SAS URLs, provider payloads, or raw logs in commits or issues.
- Bring destructive operations remain user-only, confirmation-bound, idempotent, audited, and allowlisted.
- Project memory stores current durable facts and blockers. GitHub PRs, Actions runs, deployments, artifacts, and Git history retain execution history.

Read [project memory](docs/project-memory/README.md) before non-trivial operational work.
