# Known issues and unresolved risks

Last updated: 2026-05-14

## Current corrected status from 2026-05-14 consolidation

## 2026-05-14 production browser login redirect hang

- Production browser sign-in returned to the static Angular URL with an authorization `code` in the hash but did not complete the UI sign-in. The likely cause is using MSAL popup APIs with the main Angular route as the redirect target instead of a redirect flow that processes the returned auth-code hash in the top-level window.
- Fix deployed: PR #64 switched the SPA sign-in and interactive token fallback to MSAL redirect APIs and processes the returned auth-code hash without navigating back to the original request URL. Manual browser retest remains pending.

## 2026-05-14 final readiness residual risks

- The previous production metadata-update workflow failure is resolved by PR #60 and successful production promotion run `25852638254`.
- Remaining setup visibility limitation: Codex still cannot inspect Microsoft Entra app registrations or federated credentials because the Azure identity lacks Microsoft Graph directory permissions.
- Remaining manual verification: interactive Angular/MSAL sign-in for the allowlisted user must be completed in a browser by a human/delegated user.

## 2026-05-14 readiness sprint active issues

- `Promote Production` run `25852035606` successfully deployed production and passed smoke tests, but the workflow concluded `failure` because `GITHUB_TOKEN` could not write repository variables in the post-smoke metadata update step. This is a workflow correctness issue, not an application deployment failure.
- Codex Azure identity still lacks sufficient Microsoft Graph directory permissions to list or inspect Microsoft Entra app registrations and federated credentials.
- Interactive Angular/MSAL login and the allowlisted authenticated browser call were not manually verified by Codex because this environment cannot complete interactive Entra sign-in.
- GitHub Actions reported Node.js 20 action runtime deprecation warnings for upstream actions; application/runtime code remains Node 22.

- Production has not yet been verified as auth-enabled. On 2026-05-14, unauthenticated `GET /api/hello` at the production API URL still returned the old public placeholder response instead of `401`.
- `Deploy Test` has succeeded on `main`, but production promotion most recently skipped; the staged test-to-production path is not yet fully end-to-end verified for an auth-enabled production rollout.
- Codex Azure identity currently lacks sufficient Microsoft Entra directory permissions to list or inspect app registrations/federated credentials; `az ad app list --filter "appId eq '<client-id>'"` failed with insufficient privileges on 2026-05-14.
- Deployment-principal RBAC on `rg-api-test` and `rg-api-prod` could not be verified from the available client/app ID because Graph lookup was insufficient and project memory does not contain the service principal object ID.
- The older bullets below that say auth implementation pieces are still needed are superseded for code on `main`; auth deployment verification remains open. They are retained for guardrail traceability rather than deleted in this consolidation PR.

- API authentication is implemented in PR #40 but not yet merged/deployed.
- Production `GET /api/hello` remains a public placeholder until PR #40 is merged and deployed with auth variables.
- Codex Azure identity currently lacks sufficient Microsoft Entra directory permissions to list/create/update app registrations; `az ad app list --display-name juez-api-catalogue-api-prod --query "[0]" -o json` failed with insufficient privileges on 2026-05-14.
- `OIDC_ALLOWED_OBJECT_IDS` is still unknown because the current Azure login is not a delegated user flow; do not guess it.
- Production auth promotion is blocked until the GitHub Actions Azure deployment identity can manage required Bicep role assignments at `rg-api-prod` scope, or the role assignment is safely pre-provisioned/removed from the template.
- Deployment uses storage-backed `WEBSITE_RUN_FROM_PACKAGE`; durable deployment hardening may still be useful later if operational needs grow.
- Entra/OIDC/JWT design and app registrations are still needed.
- Angular login flow is still needed.
- Backend token validation and user allowlist are still needed.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
