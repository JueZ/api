# Known issues and unresolved risks

Last updated: 2026-05-14

- API authentication is implemented in PR #40 but not yet merged/deployed.
- Production `GET /api/hello` remains a public placeholder until PR #40 is merged and deployed with auth variables.
- Codex Azure identity currently lacks sufficient Microsoft Entra directory permissions to list/create/update app registrations; `az ad app list --display-name juez-api-catalogue-api-prod --query "[0]" -o json` failed with insufficient privileges on 2026-05-14.
- `OIDC_ALLOWED_OBJECT_IDS` is still unknown because the current Azure login is not a delegated user flow; do not guess it.
- Deployment uses storage-backed `WEBSITE_RUN_FROM_PACKAGE`; durable deployment hardening may still be useful later if operational needs grow.
- Entra/OIDC/JWT design and app registrations are still needed.
- Angular login flow is still needed.
- Backend token validation and user allowlist are still needed.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
