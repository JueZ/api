# Decision log

## 2026-07-31 — Make autonomous change quality, release evidence, and incident diagnosis executable contracts

- Decision: `AGENTS.md` invokes a repository `change-quality-gate` for every behavioral, deployment, security, and agent-control change. Definition of Done requires a behavior contract, regression tests, proportionate validation, documentation/project-memory updates, risk/rollback evidence, repository hygiene, and both worktree and complete-branch policy evaluation. Skipped checks are not passes.
- Decision: keep `.github/autonomous-policy.yml` authoritative for required checks and generate branch-protection payloads from it while preserving required conversation resolution. Validate skills against the official skill/metadata rules and mechanically evaluate durable workflow contracts for quality, GitHub review, Azure diagnosis, staged delivery, rollback, and memory maintenance.
- Decision: build, import, SBOM, attest, and verify the exact independently locked Function package before Azure login. ARM validation and a secret-suppressed `ResourceIdOnly` what-if must use the identical parameter vector later used for create. Release-ledger runtime validation must follow the published JSON Schema.
- Decision: require lockfile pairing when a package manifest changes install-shaping metadata, and reject unpaired lockfile changes. Script or descriptive metadata changes do not require meaningless lockfile churn; both complete lockfiles are still validated for registry-only resolution and forbidden lifecycle hooks on every run.
- Decision: authenticated smoke token minting must prove the least-privilege Entra application roles before exporting the short-lived token. Missing roles are repaired in Entra by a privileged operator; API authorization, authenticated smoke, and retired-role policy must not be weakened.
- Decision: bind every generated/live required check to its pinned GitHub App ID as well as its name. The controller must also prove the exact Actions workflow ID/path, event, first attempt, repository, PR/base/head, run/job identity, and exact SHA; bind its review check to the created check-run ID. Same-app/same-name checks are insufficient. During the unresolved credential incident, exact static blocks, complete cloud-workflow inventory, protected-branch deployment environments, workflow-bound GitHub OIDC, and disabled entry workflows stop test, production, rollback, diagnostics/canaries, and data migration before cloud access.
- Decision: classify both sides of GitHub renames. Autonomous merge must reject controller dependencies, privileged delivery helpers and their transitive release schema, as well as root npm install inputs. Repository `npm-shrinkwrap.json` and `.npmrc` overrides are forbidden because they can supersede the reviewed lock/install policy. Incident containment is incomplete while any repository Actions run remains nonterminal.
- Decision: the incident record remains active-only. GitHub is an affected credential system and no independent collaborator/security approver exists, so a repository-owner comment is circular and cannot clear the hold. Evidence may be recorded without clearing it. Policy, hold, workflows, controller, live-control verifier, and related trust roots are excluded from autonomous merge; recovery requires external revocation and an independently verified out-of-band principal or hardware-backed signature bootstrap. Required status checks cannot bind workflow identity, the personal repository rejected the required-workflow ruleset, and all Actions workflows share one App ID; therefore repository Actions and native auto-merge remain disabled during the hold. Old Azure FICs remain intentionally invalid until replaced with exact repository/context/workflow-bound credentials. A fresh test-first delivery remains mandatory.
- Rationale: the repository is operated by agents, so intent must be encoded as executable, discoverable constraints rather than depending on session memory. Exact package/config/evidence correlation reduces false-green releases and makes failures actionable without exposing secrets.
- Status: implemented and locally validated on the enterprise-hardening branch. Remote PR gates, merge, and staged rollout are intentionally security-blocked until external rotation and an independently controlled trust root exist.

## 2026-07-31 — Isolate provider startup and keep Bring confirmations out of generic UI state

- Decision: initialize Reddit, WLH, and Bring lazily per provider after authentication. A missing or disabled provider returns a sanitized provider-local `503` result and must not prevent MCP initialization or unrelated tools.
- Decision: store Bring confirmation tokens only in a private expiring browser vault. Never place a token in the generic form model, rendered response, curl output, clipboard, or DOM; inject only for the matching apply operation and clear on expiry, a new prepare, apply success/failure, login, and logout.
- Rationale: optional provider configuration is a dependency boundary, not a whole-gateway startup dependency. Confirmation tokens are credentials and generic request/rendering state creates accidental disclosure paths.
- Status: implemented with API and web behavioral regression coverage; staged deployment remains required.

## 2026-07-31 — Defer explicit Log Analytics ownership to a dedicated migration

- Decision: do not mix Application Insights workspace relinking into the broad hardening delivery. Implement an explicit `PerGB2018` workspace, retention, one-GB declarative safety cap, and cap alert in a separate test-first infrastructure PR.
- Rationale: relinking is supported and current ingestion is very small, but historical telemetry is not copied. The old managed workspaces/resource groups must remain queryable for at least 90 days, and post-deployment validation must prove the new link before cleanup.
- Status: planned; no telemetry resource was changed by this branch.

## 2026-07-31 — Validate Entra identifiers as GUIDs, not versioned UUIDs

- Decision: Validate `OIDC_ALLOWED_OBJECT_IDS` and `OIDC_ALLOWED_TENANTS` with the Microsoft GUID shape only. Retain the stricter RFC-versioned UUID pattern for Bring list identifiers.
- Rationale: Microsoft Entra `oid` and `tid` claims are GUID strings and are not promised to carry RFC UUID version/variant marker bits. Test startup telemetry from run `30651802409` proved that applying the Bring UUID constraint to an existing Entra object ID rejected an otherwise exact, deployment-verified configuration.
- Status: Implemented locally with a non-versioned-GUID regression test. Fresh PR and test-only validation remain required; production remains untouched.

## 2026-07-31 — Normalize boolean Function settings to lowercase strings

- Decision: Every Bicep boolean written to Function App settings must use `toLower(string(value))`; direct `string(bool)` conversions are prohibited by architecture regression coverage.
- Rationale: ARM persisted `string(bool)` as title-cased `True`/`False`, while the Node runtime and deployment safety policy intentionally require exact lowercase `true`/`false`. Test run `30651053281` proved that only the seven boolean-derived settings diverged; all non-boolean settings and exact Key Vault reference identities matched.
- Status: Implemented after the repaired nested settings deployment passed Bicep but failed closed before package activation. Fresh PR and test-only validation remain required; production remains untouched.

## 2026-07-31 — Reconcile preserved Function settings through a secure nested deployment

- Decision: Keep the parent-template read and strict allowlist of release-owned Function settings, but move the complete `Microsoft.Web/sites/config` write into a local nested Bicep module with a `secureObject` parameter.
- Rationale: ARM rejects a template that both lists and directly writes the same `appsettings` child as circular. The nested deployment depends on the Function App and secret resources, receives only the complete intended settings object, and prevents secret-bearing values from being retained in deployment history.
- Status: Implemented after test run `30650254586` failed before package mutation; PR validation and a fresh test-only dispatch remain pending.

## 2026-07-31 — Pin immutable Function versions and activate the frontend entrypoint last

- Decision: A digest-addressed Function blob name is insufficient by itself. Resolve its Azure Blob version ID, download and hash that exact immutable version, put the encoded `versionid` in `WEBSITE_RUN_FROM_PACKAGE`, and verify the exact setting through the management plane before restart.
- Decision: Do not delete from the active static site before a complete replacement is available. Upload and verify all non-entrypoint files while the prior `index.html` remains active; upload `index.html` last; verify every expected byte; then delete only inventory-proven stale blobs and require a final exact name/content match.
- Rationale: Azure blob versions are immutable, while a current blob URL can be rebound by overwrite. Activation-last frontend deployment prevents an upload failure from first removing dependencies required by the previously active site.
- Status: Implemented on the fresh successor after PR #279 exhausted its two high-risk review attempts; fresh remote validation and test-only deployment remain pending.

## 2026-07-31 — Bind deployment evidence to one attempt and preserve exact rendered packages

- Decision: Deployment workflows accept only workflow attempt 1. A failed deployment must be diagnosed and newly dispatched with a new opaque correlation; GitHub reruns are rejected before Azure mutation.
- Decision: Correlation is part of release-ledger, test-provenance, and accepted-production-bundle artifact names. Consumers also validate the exact run identity, source SHA, title, embedded run ID, and embedded correlation.
- Decision: Test provenance separately records the immutable CI frontend-source digest and the environment-rendered frontend digest. Production promotes the exact Function, SBOM, and frontend-source digests, then hashes its own rendered archive before either Function or static deployment. The exact rendered production bundle is preserved for rollback.
- Decision: Production promotion and rollback must deploy both Function and frontend packages. Rollback is strictly package-only. Current `main` supplies controller/validation code; existing resources, safety settings, and the complete rendered frontend are validated read-only before mutation; Bicep and safety-setting reconciliation are skipped; release blobs cannot be created; and the preserved frontend is uploaded unchanged.
- Status: Implemented on the fresh successor branch after PR #276 exhausted its two high-risk review attempts; fresh remote validation and test-only deployment remain pending.

## 2026-07-31 — Use deterministic-first REC across REST and the bundled MCP server

- Decision: Every service-generated failure uses REC. Predefined deterministic mappings run first; only `diagnostic_uncertain` sanitized capsules may use the OpenAI Responses API, and model output must pass schema and policy gates.
- Decision: Keep one repository `OPENAI_API_KEY` for test and production deployment configuration, with Key Vault references and no secret value in repository memory.
- Decision: MCP retains one server and exposes REC at `structuredContent.repairable_problem`; model-generated JSON Patch is rejected unless a future deterministic verifier is added.
- Status: Implemented locally; PR and test-only rollout authorized. Production rollout is not authorized for this delivery.
- Reference: `docs/adr/0005-deterministic-first-repairable-errors.md`.

## 2026-07-31 — Keep one bundled MCP gateway

- Decision: Health, authentication, Reddit, Willhaben, and Bring tools remain bundled behind one `/mcp` route and one `McpServer` instance. Registration helpers must not create additional servers or endpoints.
- Status: Enforced in the local working tree; not committed, merged, or deployed.
- Reference: `docs/adr/0004-single-bundled-mcp-gateway.md`.

## 2026-07-30 — AI-native authorization, delivery, and Bring safety model

- Decision: Use deterministic exact-head policy plus independent AI review for high-risk changes without a routine human approval requirement.
- Decision: Replace generic `api.access` authorization with operation permissions: `catalogue.read`, `reddit.read`, `wlh.read`, `bring.read`, `bring.write`, `bring.complete`, and `bring.remove`.
- Decision: Keep the current Bring technical account; make test structurally read-only; permit production writes only to explicit own-list UUIDs; require durable idempotency for add and two-phase confirmation for complete/remove.
- Decision: Split Azure storage trust boundaries, use Key Vault references and managed identities, and promote immutable test-proven artifacts to production.
- Status: Implemented only in the local working tree; not committed, merged, configured, or deployed.
- References: `docs/adr/0001-autonomous-high-risk-review.md`, `docs/adr/0002-bring-environment-policy.md`, `docs/adr/0003-storage-secrets-and-artifacts.md`.

## 2026-06-09 — Identity-based Azure Functions host storage

- Decision: Migrate `AzureWebJobsStorage` in `infra/main.bicep` from an account-key connection string to identity-based host storage using the Function App system-assigned managed identity.
- Rationale: Azure Functions runtime `~4` supports identity-based host storage, the app is HTTP-trigger-only, and deployment already uses external run-from-package packages with managed-identity package reads.
- Consequence: The Function App identity now needs storage-account-scoped `Storage Blob Data Owner` for host storage/package reads and `Storage Table Data Contributor` for Functions diagnostic events. Validation completed through PR #246 post-merge `main` CI, `Deploy Test` run `27229870948`, and `Promote Production` run `27229866903`; keep shared-key disablement as a separate future hardening step.
- Reference: `docs/security/azure-functions-identity-host-storage.md`.

## 2026-05-17 — Stop creating repair issues for routine PR check failures

- Decision: Remove the PR-level `Codex Autofix` issue-creation workflow and keep repair issue creation only for production deployment or production smoke-test failures.
- Rationale: The workflow did not run Codex or push fixes; it only created `codex-repair` issues for failed PR checks. Active Codex tasks are already required to inspect CI/policy failures, repair up to two attempts, and report unresolved failures, while the PR and workflow run already preserve PR-level failure context.
- Consequence: Routine PR failures should be handled in the PR/Codex delivery loop; production failures remain visible as issues because they happen after merge and may not have an active PR.

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


## 2026-05-14: Require explicit app-only token marker for service-client authorization

Decision: classify API callers as service clients only when the verified JWT contains the unambiguous Microsoft Entra app-only marker `idtyp=app`. Tokens that merely contain app roles plus `azp` or `appid` continue through delegated user authorization and must satisfy `OIDC_ALLOWED_OBJECT_IDS` or `OIDC_ALLOWED_SUBJECTS`.

Rationale: role claims and client identifiers are not sufficient proof that a token is client-credentials/app-only. This preserves the central user allowlist for delegated callers while keeping separately allowlisted service clients available for explicit app-only tokens.

Status: In progress.

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
# 2026-07-25 — Reuse managed-identity storage for Bring! sessions

- **Decision:** Cache unofficial Bring! authentication sessions in a versioned private blob in the existing deployment storage account, with process-local deduplication and last-write-wins persistence.
- **Reason:** This avoids repeated technical-account logins without adding paid/always-on infrastructure or storage keys. Cache failures fall back to login and never fail an otherwise successful shopping operation.
- **Risk:** Bring!'s API is undocumented and may drift. The integration exposes normalized DTOs only and classifies response drift separately so rollback or protocol repair can be performed safely.
