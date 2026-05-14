# Known issues and unresolved risks

Last updated: 2026-05-14

- API authentication code is present, but deployment still depends on correctly configured GitHub auth variables and Entra app registrations for both test and production.
- Codex Azure identity currently lacks sufficient Microsoft Entra directory permissions to list/create/update app registrations; `az ad app list --display-name juez-api-catalogue-api-prod --query "[0]" -o json` failed with insufficient privileges on 2026-05-14.
- `OIDC_ALLOWED_OBJECT_IDS` is still unknown because the current Azure login is not a delegated user flow; do not guess it.
- Production auth promotion is blocked until the GitHub Actions Azure deployment identity can manage required Bicep role assignments at `rg-api-prod` scope, or the role assignment is safely pre-provisioned/removed from the template.
- Deployment uses storage-backed `WEBSITE_RUN_FROM_PACKAGE`; durable deployment hardening may still be useful later if operational needs grow.
- Entra app registrations must include redirect origins for local development, production, and the test static website if the same SPA app registration is reused across environments.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
