# Decision log

Entries are reverse chronological.

## 2026-05-14 — Store production rollback as a Codex skill

- Decision: Add a repo-scoped `production-rollback` Codex skill for redeploying previous known-good commits through `rollback-production.yml`.
- Context: Rollback must reuse the same production workflow path, GitHub `production` environment approval, and smoke tests instead of ad hoc commands.
- Consequences: Future Codex sessions should trigger this skill for production rollback requests and must not bypass environment approval or smoke tests.
- Status: Active.

## 2026-05-14 — Introduce lightweight test-to-production promotion

- Decision: Deploy merged commits to a separate test environment first, then promote the same commit to production only after test smoke tests pass.
- Context: Production deployment works, but the project needs a small staged release path without adding expensive services or authentication in this task.
- Consequences: `Deploy Test` uses `rg-api-test` and `environmentName=test`; `Promote Production` uses `rg-api-prod`, `environmentName=prod`, and the GitHub `production` environment approval gate if configured. Rollback redeploys a previous commit through the same path.
- Status: Active.

## 2026-05-14 — Keep expensive services out of v0

- Decision: Avoid Azure SQL, Cosmos DB, API Management, Front Door, and other paid always-on services in v0.
- Context: The v0 milestone is a low-cost skeleton for a personal API catalogue platform.
- Consequences: Add paid services only with an explicit cost note and policy review.
- Status: Active.

## 2026-05-14 — Use Node 22 for Azure Functions

- Decision: Run Azure Functions on Node 22.
- Context: Node 24 caused production HTTP 503/runtime startup issues. Node 22 is the validated runtime for the current Azure Functions app.
- Consequences: Keep local, CI, infrastructure, and production runtime expectations aligned on Node 22 until Azure Functions support changes are intentionally validated.
- Status: Active; PR #34 fixed the production runtime.

## 2026-05-14 — Keep `/api/hello` public only for v0

- Decision: `GET /api/hello` remains public as a v0 placeholder only.
- Context: The endpoint verifies the end-to-end path before real auth exists.
- Consequences: Protect this endpoint or replace it with protected routes in the next auth milestone. Do not treat it as proof that production auth exists.
- Status: Temporary.

## 2026-05-14 — Keep `/health` public

- Decision: `GET /health` remains public.
- Context: Production deployment and smoke tests need a low-risk liveness endpoint.
- Consequences: The endpoint must not expose secrets, user data, tokens, or expensive operations.
- Status: Active.

## 2026-05-14 — Gate production deployment with `DEPLOY_PRODUCTION_ENABLED`

- Decision: Previously kept direct production deployment gated by the repository variable `DEPLOY_PRODUCTION_ENABLED`.
- Context: Autonomous delivery could deploy after merge, but production deploys needed to fail closed unless intentionally enabled outside the repo.
- Consequences: Superseded by test-first promotion and optional GitHub `production` environment approval; avoid reintroducing direct production-on-push without test promotion.
- Status: Superseded by the lightweight test-to-production promotion decision.

## 2026-05-14 — Use GitHub CLI and Azure CLI skills

- Decision: Use repo-scoped `github-cli-devops` and `azure-cli-devops` skills for direct operational work.
- Context: The project relies on GitHub Actions, PR checks, Azure OIDC, Azure Functions, Storage, and Bicep diagnostics.
- Consequences: CLI work must respect guardrails: no secrets in output, no weakening checks, no broad permissions, and no destructive resource changes unless explicitly requested.
- Status: Active.

## 2026-05-14 — Use branch protection, auto-merge, CI, and Policy Check

- Decision: Use protected pull requests with required CI and Policy Check gates, plus GitHub-native auto-merge for eligible Codex PRs.
- Context: The project is intended to run in autonomous delivery mode without routine human approval.
- Consequences: Do not bypass branch protection, disable checks, or weaken policy to make a change pass.
- Status: Active.

## 2026-05-14 — Use separate Codex and GitHub Actions Azure identities

- Decision: Maintain separate Azure identities for direct Codex operational work and GitHub Actions deployment.
- Context: Codex may inspect and diagnose resources directly, while GitHub Actions deploys through OIDC.
- Consequences: Keep responsibilities, permissions, and audit trails separate. Prefer least privilege for both identities.
- Status: Active.

## 2026-05-14 — Use GitHub Actions OIDC for deployment

- Decision: Use GitHub Actions OIDC for Azure deployment.
- Context: OIDC avoids long-lived Azure client secrets in repository automation.
- Consequences: Deployment depends on correct federated credentials, repository variables, environment settings, and Azure RBAC.
- Status: Active.

## 2026-05-14 — Use Azure Bicep

- Decision: Use Bicep for Azure infrastructure.
- Context: Bicep keeps infrastructure declarative, reviewable, and compatible with Azure deployment workflows.
- Consequences: Infrastructure changes should be validated with Bicep checks and cost-policy guardrails.
- Status: Active.

## 2026-05-14 — Use an OpenAPI contract

- Decision: Maintain the API contract in `contracts/openapi.yaml`.
- Context: The contract documents public behavior and supports validation as the API grows.
- Consequences: Auth, response, and route changes should update OpenAPI with tests.
- Status: Active.

## 2026-05-14 — Use Azure Functions backend

- Decision: Use TypeScript Azure Functions in `apps/api` for the backend.
- Context: Serverless Functions fit the low-cost personal API catalogue goal.
- Consequences: Keep handlers thin, testable, and compatible with Azure Functions runtime support.
- Status: Active.

## 2026-05-14 — Use Angular frontend

- Decision: Use Angular in `apps/web` for the frontend.
- Context: Angular provides a structured frontend foundation for the catalogue UI and future login flow.
- Consequences: Frontend auth work should integrate with Angular and be covered by build/type checks.
- Status: Active.
