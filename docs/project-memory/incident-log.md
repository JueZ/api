# Incident log
## 2026-05-14 — Production protected API call blocked by CORS preflight

- Symptom: Production Angular sign-in completed for the user, but the protected `/api/hello` call failed with a browser CORS error because the preflight response lacked `Access-Control-Allow-Origin`.
- Impact: Authenticated browser verification of `/api/hello` is blocked even though API smoke tests for unauthenticated `401` continue to pass.
- Fix: Configure Function App platform CORS for the deployed Angular origin and add preflight validation to deployment smoke tests.
- Status: Resolved by PRs #66, #67, #70, #73, and #75 plus successful production promotion run `25855907807`.

## 2026-05-14 — Deploy Test failed after first CORS fix because test redirect URI is unset

- Run `25854845137` failed during deployment configuration validation because the first CORS fix made `TEST_WEB_AUTH_REDIRECT_URI` required whenever the test frontend deploys, but the repository currently leaves that variable unset.
- Follow-up: keep test CORS validation conditional on a configured test redirect URI; production still uses `WEB_AUTH_REDIRECT_URI` for the production Angular origin.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production CORS smoke needed propagation retry

- Promote Production run `25855047988` applied the Function App platform CORS configuration, but the immediate smoke preflight check ran before CORS headers were visible at the production endpoint and failed closed.
- Direct verification shortly after the failed run showed the production preflight returned `Access-Control-Allow-Origin: https://stapicatalogueprodbfjsts.z6.web.core.windows.net`, so the configuration was correct but needed bounded retry in smoke tests.
- Follow-up: add bounded retry around CORS preflight validation after deployment.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production CORS smoke header parser split URL value

- Promote Production run `25855376487` failed because the smoke parser split `Access-Control-Allow-Origin: https://...` on colon characters and compared only `https` to the expected origin.
- Direct endpoint behavior remained correct; the failure was in smoke-test parsing, not in the deployed CORS configuration.
- Follow-up: parse the CORS header by removing only the header-name prefix and preserving the full URL value.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Production health route needed explicit restart/readiness retry

- Promote Production run `25855574430` failed because `/health` returned `404` immediately after package deployment even though function metadata existed. A direct Azure Resource Manager restart with a non-empty body restored `/health` to `200`.
- Follow-up: use an explicit ARM restart call that includes a request body and add bounded readiness retry for `/health` and unauthenticated `/api/hello` before CORS preflight smoke validation.
- Status: Resolved by successful production promotion run `25855907807`.

## 2026-05-14 — Personal Microsoft account token rejected by single issuer config

- Symptom: after CORS was fixed, the production Angular call to protected `/api/hello` reached the API but returned `401` with `Invalid bearer token`.
- Root cause: the configured backend issuer accepted only the organization tenant issuer, while the signed-in `mkos_postat@outlook.com` browser session uses the Microsoft account tenant issuer.
- Fix: allow comma-separated accepted issuer URLs in `OIDC_ISSUER`; deployment configuration must add the explicit Microsoft account issuer, tenant ID, and stable home-account object ID while retaining the existing allowlist.
- Status: Fix in progress.


Entries are reverse chronological.

## 2026-05-14 — Production promotion falsely failed after smoke success

- Symptom: `Promote Production` run `25852035606` concluded `failure` even though production deployment and smoke tests passed.
- Root cause: The reusable deployment workflow attempted to update repository variables after smoke tests using `GITHUB_TOKEN`, and GitHub returned `HTTP 403: Resource not accessible by integration` for the variables API.
- Fix: Make the post-smoke repository-variable update idempotent/best-effort so metadata rewrite failures do not create a false production deployment failure.
- Prevention / lesson: Keep deployment and smoke failures fail-closed, but avoid coupling successful production health to non-critical repository metadata rewrites unless a token with documented permissions is intentionally used.
- Links: Workflow run `25852035606`; readiness follow-up PR.

## 2026-05-14 — HTTP 503 after deployment

- Symptom: Production Function App returned HTTP 503 after deployment.
- Root cause: Function App was configured with Node 24, while Azure Functions Node v4 programming model support for this app was validated with Node 22/20/18.
- Fix: Change the Function App runtime to Node 22.
- Prevention / lesson: Keep Azure Functions runtime versions aligned across docs, infrastructure, CI, and production. Validate new Node versions before adopting them.
- Links: PR #34 fixed Node runtime to 22.

## 2026-05-14 — Storage upload/RBAC failure

- Symptom: GitHub Actions deployment could not upload blob/package artifacts.
- Root cause: GitHub OIDC principal had resource `Contributor` but lacked `Storage Blob Data Contributor` for Azure Storage data-plane operations.
- Fix: Grant the deployment identity the required storage data-plane role at the appropriate scope.
- Prevention / lesson: Azure resource-plane roles do not automatically grant blob data-plane upload permissions.
- Links: Related production-failure issue set included issue #28.

## 2026-05-14 — SAS expiry failure

- Symptom: Deployment failed when creating a user delegation SAS with a 30-day expiry.
- Root cause: User delegation SAS expiry cannot exceed 7 days.
- Fix: Use a SAS expiry within the allowed 7-day window.
- Prevention / lesson: Keep SAS lifetimes short. Later workflow updates replaced SAS-backed `WEBSITE_RUN_FROM_PACKAGE` with managed-identity package access.
- Links: Related production-failure issue set included issue #28.

## 2026-05-14 — Static website upload failure

- Symptom: Angular static site upload failed because the `$web` container was unavailable.
- Root cause: Static website hosting had not been enabled, so the `$web` container did not exist.
- Fix: Enable static website hosting before uploading frontend files.
- Prevention / lesson: Confirm hosting feature prerequisites before artifact upload steps.
- Links: Related production-failure issue set included issue #28.
