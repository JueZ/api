# Deployment log

## 2026-05-14 — Microsoft Entra v1 issuer alias fix deployed to production

- Event: PR #83 was merged after passing CI and Policy Check, then `Deploy Test` run `25857723653` and `Promote Production` run `25857793354` completed successfully.
- Result: Production deployment and smoke tests succeeded.
- Verification: Workflow smoke tests passed for public `/health`, unauthenticated protected `/api/hello`, and configured browser preflight checks. Interactive authenticated browser verification still requires a manual retry.
- Follow-up: Retry **Call hello with access token** in the production browser session.


Entries are reverse chronological. Do not include secrets or SAS URLs.
## 2026-05-14 — Production CORS/auth browser-call fix deployed

- Production promotion run `25855907807` succeeded after PR #75.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; `OPTIONS /api/hello` from origin `https://stapicatalogueprodbfjsts.z6.web.core.windows.net` returned `204` with `Access-Control-Allow-Origin` set to that origin.
- Production-failure issues #68, #72, and #74 were closed after the successful promotion and endpoint verification.
## 2026-05-14 — Issuer-specific JWKS auth fix deployed

- Production promotion run `25857092220` succeeded after PR #80.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; CORS preflight from the production Angular origin returned `204` with the expected `Access-Control-Allow-Origin`.
- Follow-up: manual browser retry of **Call hello with access token** is still needed because Codex cannot complete interactive Entra/MSA login.


## 2026-05-14 — Multi-issuer Microsoft account auth fix deployed

- Production promotion run `25856534002` succeeded after PR #77.
- Non-secret auth variables were updated to include both the organization tenant issuer/tenant/object allowlist and the explicit Microsoft account issuer/tenant/home-account object ID for `mkos_postat@outlook.com`.
- Verification: production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`; CORS preflight from the production Angular origin returned `204` with the expected `Access-Control-Allow-Origin`.
- Follow-up: manual browser retry of **Call hello with access token** is still needed because Codex cannot complete interactive Entra/MSA login.


## 2026-05-14 — MSAL redirect-flow fix deployed to production

- Event: PR #64 changed the Angular frontend to use MSAL redirect APIs for sign-in and interactive token fallback after production browser auth returned with an auth-code hash but did not complete UI sign-in.
- Result: `Deploy Test` run `25854175773` passed and `Promote Production` run `25854251983` passed. Production smoke tests remained healthy.
- Follow-up: Manually retest browser sign-in at the production Angular URL and confirm the page leaves the `#code` callback state and shows the signed-in account.

## 2026-05-14 — Final readiness production promotion succeeded

- Event: After PR #60 merged, `Deploy Test` run `25852557000` and `Promote Production` run `25852638254` were manually dispatched from `main`.
- Result: Both workflows succeeded. Production deployment, Angular deployment, smoke tests, and warning-only repository-variable metadata updates completed without failing the workflow.
- Verification: Production `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `401`.
- Follow-up: Manual browser/MSAL sign-in verification and Entra app-registration visibility remain the only setup-readiness items requiring a human/delegated directory context.

## 2026-05-14 — Consolidation verification found production still pre-auth

- Event: Consolidation sprint inspected repo, GitHub Actions, GitHub variables, Azure resources, and public production endpoints without deploying production.
- Result: Code on `main` contains auth, but production still serves the old public `/api/hello` placeholder. `GET /health` returned `200`; unauthenticated `GET /api/hello` returned `200` with `authenticated:false`.
- Production API URL: <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular URL: <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- Follow-up: Verify Entra/OIDC/RBAC prerequisites, run `Deploy Test`, and promote production only through guarded workflows after `DEPLOY_PRODUCTION_ENABLED=true` is intentionally set.

## 2026-05-14 — Staged deployment bootstrap partially verified

- Event: Safe GitHub/Azure inspection checked repository environments, resource groups, resource inventory, Function App runtime, recent workflow runs, and repository variable names.
- Result: GitHub environments `test` and `production` exist. Azure resource groups `rg-api-test` and `rg-api-prod` exist. Production Function App runtime is `Node|22`. `Deploy Test` run `25849812564` succeeded on `main`; subsequent `Promote Production` workflow runs skipped.
- Unknowns: Microsoft Entra app registrations, federated credentials, and deployment-principal RBAC could not be fully verified because the current Azure principal lacked sufficient Microsoft Graph privileges and project memory does not contain the deployment service principal object ID.
- Follow-up: Complete verification with a delegated identity or object ID that can inspect app registrations/federated credentials and role assignments.

## 2026-05-14 — Managed-identity package access replaced SAS-backed run-from-package

- Event: Reusable deployment workflow stores the Function App package in blob storage and configures `WEBSITE_RUN_FROM_PACKAGE` with `WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID=SystemAssigned`.
- Result: Current workflow no longer writes expiring SAS package URLs.
- Follow-up: Keep verifying storage/RBAC prerequisites during staged deployment.

## 2026-05-14 — Auth production promotion blocked by deployment RBAC

- Event: PR #40 was squash-merged and main CI, Policy Check, and Deploy Test passed. Production promotion was triggered manually after auth GitHub variables were configured.
- Result: Failed closed during the Bicep infrastructure step before package/frontend deployment and smoke tests.
- Root cause: The GitHub Actions Azure deployment identity lacks permission to create/update `Microsoft.Authorization/roleAssignments` in `rg-api-prod`; `infra/main.bicep` manages a storage role assignment for the Function App identity.
- Follow-up: Grant the deployment identity `Role Based Access Control Administrator` at `rg-api-prod` scope, or pre-provision/remove the Bicep-managed role assignment in a safe PR. `DEPLOY_PRODUCTION_ENABLED=false` was restored after the failed promotion.
- Links: Production-failure issues #50 and #51 were created for commit `a025c76`.

## 2026-05-14 — Auth deployment preparation blocked by Entra permissions

- Action: Set GitHub repository variable `DEPLOY_PRODUCTION_ENABLED=false` as a fail-safe before configuring authentication.
- PR: Historical status only; PR #40 was later merged with OAuth/OIDC/JWT implementation and frontend MSAL wiring.
- Production state: unchanged pre-auth deployment; `/health` is public and `/api/hello` is still the public placeholder.
- Blocker: Codex Azure identity could not list app registrations by display name due to insufficient Microsoft Entra directory privileges.
- Missing values: API app client ID, SPA app client ID, API App ID URI, `api.access` scope ID, and `OIDC_ALLOWED_OBJECT_IDS`.
- Next step: A sufficiently privileged delegated user must create/reuse the Entra app registrations and provide the allowed user object ID before merge/deploy.
## 2026-05-14 — Staged deployment setup commands and rollback skill documented

- Event: Added a repo-scoped production rollback skill and setup commands for GitHub environments, Azure resource groups, OIDC federated credentials, RBAC, test deployment, production promotion, and rollback.
- Result: Documentation-only operational follow-up; no Azure resources were changed by this PR.
- Evidence / command summary: `docs/setup/staged-deployment.md` contains the CLI command sequence; `.agents/skills/production-rollback/SKILL.md` contains the standard rollback workflow command.
- Follow-up: Run the setup commands with an Azure principal that can create `rg-api-test` and assign scoped roles, then verify `Deploy Test` and `Promote Production`.

## 2026-05-14 — Staged deployment flow prepared in PR

- Event: Added workflows and documentation for test-first deployment and production promotion.
- Result: Pending merge and workflow execution.
- Evidence / command summary: `deploy-test.yml` will deploy `main` to `rg-api-test` and smoke `/health` plus `/api/hello`; `promote-production.yml` will promote the same commit to `rg-api-prod` after the test workflow succeeds.
- Follow-up: After merge, verify the first test deployment and production promotion workflow runs; configure GitHub `production` required reviewers if manual approval is desired.

## 2026-05-14 — v0 production deployment succeeded

- Event: Production deployment completed after the Function App runtime was changed to Node 22.
- Result: Success.
- Evidence / command summary: Production base URL responded successfully for `GET /health` and `GET /api/hello` at <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Follow-up: Historical note superseded by PR #40 for code-level auth and by later managed-identity package access; production still needs auth-enabled deployment verification.

## 2026-05-14 — Production failure issues closed after successful deployment

- Event: Production-failure issues created during failed deploy attempts were closed after the successful v0 deployment.
- Result: Resolved.
- Evidence / command summary: Related issue set included issue #28 and other production-failure issues from failed deployment attempts.
- Follow-up: Keep incident root causes recorded in `incident-log.md`.

## 2026-05-14 — Function App returned HTTP 503 until Node runtime changed

- Event: Deployed Function App returned HTTP 503/runtime startup failures.
- Result: Failed until runtime was corrected.
- Evidence / command summary: Production smoke checks failed against the Function App until Node was changed from 24 to 22.
- Follow-up: Keep Azure Functions runtime aligned with validated Node versions.

## 2026-05-14 — Angular `$web` upload failed until static website hosting was enabled

- Event: Static web upload to the `$web` container failed.
- Result: Failed until static website hosting created/enabled the container.
- Evidence / command summary: Blob upload targeting `$web` could not succeed before static website hosting was enabled.
- Follow-up: Ensure static website hosting exists before uploading frontend artifacts.

## 2026-05-14 — SAS expiry of 30 days was rejected

- Event: Deployment attempted to create a user delegation SAS with a 30-day expiry.
- Result: Failed because user delegation SAS expiry must be within 7 days.
- Evidence / command summary: Azure Storage rejected the SAS expiry window.
- Follow-up: Historical note superseded by later managed-identity package access; do not reintroduce persisted SAS package URLs.

## 2026-05-14 — Storage upload failed because RBAC was incomplete

- Event: GitHub Actions deployment could not upload package/blob content.
- Result: Failed until data-plane permissions were added.
- Evidence / command summary: The GitHub OIDC principal had resource `Contributor` but lacked `Storage Blob Data Contributor` for blob data-plane operations.
- Follow-up: Keep deployment identity permissions least-privileged but sufficient for required data-plane uploads.
