# Deployment log

Entries are reverse chronological. Do not include secrets or SAS URLs.

## 2026-05-14 — Auth production promotion blocked by deployment RBAC

- Event: PR #40 was squash-merged and main CI, Policy Check, and Deploy Test passed. Production promotion was triggered manually after auth GitHub variables were configured.
- Result: Failed closed during the Bicep infrastructure step before package/frontend deployment and smoke tests.
- Root cause: The GitHub Actions Azure deployment identity lacks permission to create/update `Microsoft.Authorization/roleAssignments` in `rg-api-prod`; `infra/main.bicep` manages a storage role assignment for the Function App identity.
- Follow-up: Grant the deployment identity `Role Based Access Control Administrator` at `rg-api-prod` scope, or pre-provision/remove the Bicep-managed role assignment in a safe PR. `DEPLOY_PRODUCTION_ENABLED=false` was restored after the failed promotion.
- Links: Production-failure issues #50 and #51 were created for commit `a025c76`.

## 2026-05-14 — Auth deployment preparation blocked by Entra permissions

- Action: Set GitHub repository variable `DEPLOY_PRODUCTION_ENABLED=false` as a fail-safe before configuring authentication.
- PR: #40 remains open and passing CI/Policy with OAuth/OIDC/JWT implementation and frontend MSAL wiring.
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
- Follow-up: Implement real OAuth/OIDC/JWT auth before protected production APIs. Harden storage-backed `WEBSITE_RUN_FROM_PACKAGE` later if needed.

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
- Follow-up: Use shorter SAS expiry while SAS-backed package deployment remains in place, and harden away from expiring SAS if feasible.

## 2026-05-14 — Storage upload failed because RBAC was incomplete

- Event: GitHub Actions deployment could not upload package/blob content.
- Result: Failed until data-plane permissions were added.
- Evidence / command summary: The GitHub OIDC principal had resource `Contributor` but lacked `Storage Blob Data Contributor` for blob data-plane operations.
- Follow-up: Keep deployment identity permissions least-privileged but sufficient for required data-plane uploads.
