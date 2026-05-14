# Incident log

Entries are reverse chronological.

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
- Prevention / lesson: Keep SAS lifetimes short and consider hardening away from SAS-backed `WEBSITE_RUN_FROM_PACKAGE`.
- Links: Related production-failure issue set included issue #28.

## 2026-05-14 — Static website upload failure

- Symptom: Angular static site upload failed because the `$web` container was unavailable.
- Root cause: Static website hosting had not been enabled, so the `$web` container did not exist.
- Fix: Enable static website hosting before uploading frontend files.
- Prevention / lesson: Confirm hosting feature prerequisites before artifact upload steps.
- Links: Related production-failure issue set included issue #28.
