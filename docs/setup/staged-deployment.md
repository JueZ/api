# Staged deployment setup

## GitHub

Configure `main` with strict/up-to-date pull requests, admin enforcement, linear history, conversation resolution, force-push/deletion denial, and exactly `PR Gate` plus `Security Gate` from the GitHub Actions App. Enable repository-native auto-merge, squash merge only, and automatic head-branch deletion.

Create `test` and `production` GitHub environments. Routine autonomous production delivery has no required reviewer; add one only as an intentional operator policy change. Keep test and production secrets scoped to their environments.

Set non-secret repository variables:

- `DELIVERY_V2_ENABLED=true` after the push workflow is verified;
- `DEPLOY_PRODUCTION_ENABLED=true` only after test, OIDC, smoke, telemetry, and rollback readiness are verified;
- the existing exact Azure tenant, subscription, app, resource-group, auth, CORS, MCP, and runtime configuration variables used by `deploy-environment.yml`.

Do not configure a repository OpenAI key for governance or repair callbacks. `OPENAI_API_KEY`, when present, is an environment-scoped runtime secret only for bounded repairable-error analysis.

## Azure

Use Entra federated credentials for the GitHub repository/environment subjects and grant only the documented resource-group deployment and narrow data-plane roles. Do not use a client secret or subscription Owner. Function Apps use managed identity and Key Vault references.

Preserve separate Function-host, release, public-static, and private-integration storage boundaries with shared keys disabled. The combined budget intent remains €25 per month: €10 test and €15 production.

## Cutover verification

Before enabling push delivery, run `Delivery v2` from current protected `main` in `test-only` mode and require:

- immutable build and provenance;
- test OIDC deployment;
- exact source and digest identity;
- public and authenticated smoke;
- telemetry correlation;
- release ledger;
- production concurrency and known-good recovery tests.

Then set `DELIVERY_V2_ENABLED=true`, disable all predecessor controllers, and confirm only one workflow can promote a protected-main SHA. Production remains automatic when `DEPLOY_PRODUCTION_ENABLED=true`.

Private storage migrations remain explicit operational workflows. Inventory, back up, copy, compare counts/digests, verify access, and retain a rollback boundary. Normal application-package recovery must never guess or reverse data migrations.

Never deploy production from a local shell. Manual `workflow_dispatch` on Delivery v2 is limited to the exact current `main` and exists for dry-run, test-only, or full diagnostic execution—not for bypassing protected delivery.
