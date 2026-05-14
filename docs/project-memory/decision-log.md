# Decision log

## 2026-05-14 — Use a locked, script-free Functions production package install

- Decision: Azure Functions deployment packages must copy `apps/api/package-lock.json` with the Functions package manifest and install production dependencies with `npm ci --omit=dev --ignore-scripts`.
- Rationale: The production deploy path must not resolve new transitive dependency versions or run dependency lifecycle scripts after Azure OIDC login.
- Consequence: Any production dependency change for the Function App must update and review the API-local lockfile before deployment can package the app.
- Status: Active.


## 2026-05-14 — Harden production deployment refs and Azure RBAC bootstrap

- Decision: production deploy, promote, and rollback refs must be immutable commit SHAs that resolve to commits already on `main`; branches and tags are rejected before Azure OIDC login and before npm install/build commands can run with Azure deployment context.
- Decision: production GitHub Environment setup should require an independent reviewer with prevent-self-review. If no independent reviewer is available, keep `DEPLOY_PRODUCTION_ENABLED=false` rather than permitting unreviewed production rollback or promotion.
- Decision: keep `Role Based Access Control Administrator` out of standing deployment identity access. Use it only as a documented, time-bound resource-group bootstrap exception for the Function App package-reader role assignment, then revoke it immediately.
- Rationale: these controls break the branch/tag workflow-dispatch abuse chain reported by Aardvark and reduce the blast radius of the Azure deployment identity.
- Status: In progress.

## 2026-05-14: Treat PR creation as mandatory task completion for repository changes

Decision: Codex must commit repository-changing work and open or update a pull request before reporting the task as complete. If PR creation is blocked by authentication, network, permissions, or branch state, Codex must fail closed and report that blocker instead of silently stopping after implementation.

Rationale: The user observed repeated successful Codex tasks that did not create pull requests. Making PR creation an explicit completion requirement aligns agent behavior with the autonomous delivery pipeline. A follow-up clarified that Codex should repair common local checkout issues before giving up, including restoring the `origin` remote to `https://github.com/JueZ/api.git`, wiring Git to GitHub CLI credentials with `gh auth setup-git --hostname github.com`, pushing the branch, and creating/updating the PR with `--repo JueZ/api`.


## 2026-05-14: Use Entra app roles for service/e2e OAuth instead of static tokens

Decision: support other applications and deployed test-zone service/e2e tests with Microsoft Entra OAuth 2.0 client credentials, app roles, tenant validation, and explicit service-client allowlists. Do not introduce custom static bearer tokens, password-grant test login, or deployed auth bypasses.

Rationale: this keeps the API on a single standards-based OIDC/JWT validation path, supports CI automation through GitHub Actions OIDC federation without long-lived secrets, and preserves least-privilege separation between delegated users and app-only callers.

## 2026-05-14 Reddit integration uses app-only OAuth and no persistence

- Decision: implement Reddit thread fetching with app-only OAuth `client_credentials`, using only configured setting names for client ID, client secret, and User-Agent. The endpoint remains protected by the same Microsoft Entra JWT authorization as `/api/hello`.
- Decision: parse user-provided Reddit post inputs to an article ID and call only fixed `oauth.reddit.com` endpoints; never fetch arbitrary user-provided URLs.
- Decision: do not persist Reddit content in v1. Return normalized JSON directly, with truncation warnings when safety limits are reached.

## 2026-05-14 — Configure Function App platform CORS for the Angular origin

- Decision: Configure Azure Functions platform CORS from the deployed web redirect origin and verify `/api/hello` preflight during environment smoke tests.
- Rationale: Browser calls with an Authorization header require a successful CORS preflight, and Azure Functions can answer preflight before application code runs. Application-level CORS headers on `GET`/`OPTIONS` are not sufficient for the production static website path.
- Status: In progress.

## 2026-05-14 — Support explicit multi-issuer auth for the allowlisted Microsoft account

- Decision: Treat `OIDC_ISSUER` as a comma-separated exact allowlist of accepted token issuers while keeping audience, scope/role, tenant, and object-ID checks mandatory.
- Rationale: The first production browser user is a personal Microsoft account, which can receive tokens from the Microsoft account tenant issuer rather than the organization tenant issuer. Accepting multiple exact issuers is narrower than disabling issuer validation or switching to a broad wildcard issuer.
- Status: In progress.

## 2026-05-14 — Use issuer-specific JWKS for multi-issuer validation

- Decision: When multiple exact OIDC issuers are configured and `OIDC_JWKS_URI` is unset, discover and cache JWKS per issuer rather than reusing the first issuer's JWKS for every issuer.
- Rationale: Multi-issuer validation must keep exact issuer checks while using the key material published by the issuer that signed the token.
- Status: In progress.


Entries are reverse chronological.

## 2026-05-14 — Use MSAL redirect flow for production browser auth

- Decision: Use MSAL redirect APIs for SPA sign-in and interactive API-token fallback instead of popup APIs.
- Rationale: Production sign-in was returning to the static site with an auth-code hash and then stalling; redirect handling is a better fit for the deployed static site callback URL.
- Consequence: Users navigate away during sign-in and return to the app after MSAL processes the auth-code hash; the app does not navigate back to the initiating URL after processing the redirect.

## 2026-05-14 — Setup phase is ready except delegated/manual auth verification

- Decision: Treat the automated GitHub/Azure/test/production deployment setup as operationally ready after PR #60 and successful promotion run `25852638254`.
- Rationale: Required PR checks passed, auto-merge worked, test deployment passed, production promotion passed, and public/protected endpoint smoke checks match the intended auth behavior.
- Consequence: Normal feature development can start after acknowledging that Entra app-registration inspection and interactive Angular login still require a delegated user/manual browser context.

## 2026-05-14 — Treat production variable rewrite as metadata, not deployment health

- Decision: A successful production deployment and smoke test must not be marked failed solely because the workflow token cannot rewrite repository variables after smoke tests.
- Rationale: `Promote Production` run `25852035606` deployed auth-enabled production and passed smoke tests, but failed during a post-smoke metadata update to repository variables that already represented the production endpoint names.
- Consequence: Make the metadata update idempotent/best-effort and continue to fail closed for actual deployment or smoke-test failures.

## 2026-05-14 — Production auth endpoint behavior is now deployed

- Decision: Treat code and deployed production endpoint behavior as auth-enabled after the readiness sprint direct smoke checks.
- Rationale: Production `GET /health` returned `200`, and unauthenticated production `GET /api/hello` returned `401` after promotion run `25852035606`.
- Consequence: Normal feature development is nearly unblocked, pending a green production workflow conclusion after the metadata-update fix and manual browser/MSAL verification.

## 2026-05-14 — Consolidated actual auth/deployment state after fast iterations

- Decision: Treat OAuth/OIDC JWT auth as merged to `main` in code, but not yet verified in production.
- Rationale: `main` contains backend JWT validation, the `/api/hello` authorization path, Angular MSAL wiring, OpenAPI security, and Bicep auth settings, while direct production smoke verification still returns the old unauthenticated placeholder response for `/api/hello`.
- Consequence: Docs and project memory must distinguish code truth from deployed production truth until the next successful auth-enabled production promotion.
- Status: Active.

## 2026-05-14 — Reaffirm production deployment gate in staged workflow

- Decision: Normal deployment remains `Deploy Test` -> `Promote Production` using `deploy-environment.yml`, and production deploy jobs fail closed unless `DEPLOY_PRODUCTION_ENABLED=true`.
- Rationale: Repository guardrails say production must not deploy unless the deployment flag is intentionally enabled, even though production promotion is test-first.
- Consequence: `Deploy Test` can still verify test, while production promotion and rollback require the explicit production enablement variable plus GitHub environment gates.
- Status: Active.

## 2026-05-14 — Align CI/deploy Node version with Azure Functions runtime

- Decision: GitHub Actions Node setup and the package engine declaration should target Node 22.
- Rationale: Azure Functions production runtime is `Node|22`; CI should exercise the same major runtime that runs in Azure.
- Consequence: Contributors and automation should use Node 22 or newer for local builds/tests.
- Status: Active.

## 2026-05-14 — Package deployment should avoid SAS URLs

- Decision: Store Function App packages in a private storage container and configure `WEBSITE_RUN_FROM_PACKAGE` to the blob URL with `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`.
- Rationale: Managed-identity package access avoids expiring SAS URLs in app settings.
- Consequence: Storage/RBAC prerequisites matter for deployment, but project memory must not store secrets, SAS URLs, or connection strings.
- Status: Active.

## 2026-05-14 — Reuse production auth configuration in test

- Decision: `Deploy Test` and `Promote Production` use the same non-secret OAuth/OIDC repository variables for backend JWT validation and browser MSAL configuration.
- Context: A separate test resource group and GitHub test environment exist, and the user wants test to validate the same authentication behavior as production before promotion.
- Consequences: Test deployments now fail closed if auth variables are missing or auth is disabled. The same SPA app registration may be reused only when both test and production redirect origins are registered; test frontend defaults to its own deployed origin and test API base URL unless explicit `TEST_WEB_*` overrides are set.
- Status: Active.

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

## 2026-05-14 — Repair missing git origin during Codex host setup

- Decision: Codex setup and maintenance scripts add a missing git `origin` remote pointing at `https://github.com/JueZ/api.git` by default, with `CODEX_GITHUB_REPOSITORY` available as an explicit override.
- Context: A Codex checkout can have working `gh` authentication but no git remotes, causing hosted PR URL resolution and branch push workflows to report unavailable PR URLs.
- Consequences: Existing origins are left unchanged, setup remains deployment-free, and maintenance can repair remote-less checkouts without requiring secrets.
- Status: Active.

## 2026-05-14 — Protect `/api/hello` when auth is enabled

- Decision: `GET /api/hello` is a v0 placeholder that remains open only when `AUTH_ENABLED=false`; staged and production auth deployments require unauthenticated requests to return `401`.
- Context: The endpoint originally verified the end-to-end path before real auth existed. It now provides a low-risk protected route for validating OAuth/OIDC wiring.
- Consequences: Keep `/health` public for liveness, but do not add real catalogue data behind unauthenticated routes.
- Status: Active.

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
