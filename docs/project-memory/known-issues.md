# Known issues and unresolved risks

Last updated: 2026-05-14

- API authentication is implemented in PR #40 but not yet merged/deployed.
- Production `GET /api/hello` remains a public placeholder until PR #40 is merged and deployed with auth variables.
- Codex Azure identity currently lacks sufficient Microsoft Entra directory permissions to list/create/update app registrations; `az ad app list --display-name juez-api-catalogue-api-prod --query "[0]" -o json` failed with insufficient privileges on 2026-05-14.
- `OIDC_ALLOWED_OBJECT_IDS` is still unknown because the current Azure login is not a delegated user flow; do not guess it.
- Deployment uses SAS-backed `WEBSITE_RUN_FROM_PACKAGE` with a short-lived SAS; this works now but is not ideal long term.
- Durable deployment hardening is needed later, preferably away from expiring SAS URLs if feasible.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
