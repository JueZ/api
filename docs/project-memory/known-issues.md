# Known issues and unresolved risks

Last updated: 2026-05-17


## 2026-05-17 protected browser API calls can hit MSAL hidden-iframe timeout

- Symptom: `/health` continues to work, but browser calls to protected OpenAPI operations can fail during token acquisition with MSAL `timed_out`.
- Likely root cause: MSAL silent token renewal returns to the Angular app inside a hidden iframe; bootstrapping the SPA and running MSAL redirect handling inside that iframe can consume or alter the auth response before the top-level MSAL instance processes it.
- Initial fix: PR #147 skipped Angular bootstrap only after an iframe already contained an MSAL auth-code/error response. Production reports showed the API was healthy and `/api/hello` was not receiving authenticated browser requests, so the remaining timeout was still client-side before the API call.
- Follow-up fix proposed: keep every embedded iframe inert, including the initial silent-renew redirect URI load before Entra returns the auth response, so Angular and MSAL redirect handling never run in the child frame.
- Status: Resolved after follow-up PR #149 and production deployment. Manual browser verification on 2026-05-17 confirmed that signing out and signing back in cleared stale MSAL session state and protected API calls worked again.

## 2026-05-14 Reddit huge-thread truncation v1 limitation

- The synchronous Reddit thread endpoint has bounded limits: default `maxComments=10000`, hard max `10000`, default `maxMoreChildrenRequests=1000`, hard max `5000`, and an internal timeout budget. Very large threads above those larger safety limits may return partial data with warnings.
- Future enhancement: add an async Blob-backed job flow if complete huge-thread exports are required.

## 2026-05-14 production authenticated browser call verified

- Previous issue: protected `GET /api/hello` returned `401 Invalid bearer token` during manual production browser verification.
- Resolution: PR #86 and production promotion run `25858636629` fixed the trailing-slash Microsoft Entra v1 issuer mismatch; the subsequent manual browser call returned the authenticated hello payload.
- Status: Resolved. Keep this note for traceability; no active auth blocker remains for the v0 protected `/api/hello` path.



## 2026-05-14 production API still returns 401 due to v1 issuer slash mismatch

- Symptom: protected `GET /api/hello` still returns `401 Invalid bearer token` from the production Angular session.
- Root cause: Microsoft Entra v1 access tokens use a trailing-slash `sts.windows.net/<tenant>/` issuer; deployed code derives the v1 alias without the trailing slash.
- Status: Code fix proposed to include the trailing-slash alias; merge, deploy, and retry the browser call.
- Update: PR #86 has deployed; retry the browser call with a fresh token to confirm the interactive end-to-end result.

## 2026-05-14 production API returns 401 for Microsoft Entra v1 access token

- Symptom: protected `GET /api/hello` returns `401 Invalid bearer token` from the production Angular session even though the signed-in user is allowlisted.
- Root cause: production accepted the tenant-specific Microsoft Entra v2 issuer but the browser access token uses the Microsoft Entra v1 `sts.windows.net` issuer form for the same tenant.
- Status: Code fix proposed to derive the matching v1 issuer alias; merge, deploy, and retry the browser call.
- Update: PR #83 was deployed successfully by production promotion run `25857793354`; retry the authenticated browser call to confirm the manual end-to-end flow.


## 2026-05-14 production API CORS preflight failure

- Symptom: after successful production browser sign-in, the Angular app showed `Failed to fetch` when calling protected `GET /api/hello`; browser diagnostics reported that the preflight response from the production Function App lacked `Access-Control-Allow-Origin` for `https://stapicatalogueprodbfjsts.z6.web.core.windows.net`.
- Root cause: Azure Functions platform CORS handles browser preflight before the application-level `OPTIONS` handler can add CORS headers, so the Function App needs platform CORS configured for the deployed static website origin.
- Status: Fix in progress; deployment smoke tests are being extended to check `/api/hello` CORS preflight.

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
