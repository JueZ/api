# Known issues and unresolved risks

Last updated: 2026-05-14

- API authentication is not yet implemented.
- `GET /api/hello` is a public placeholder until the auth milestone.
- Deployment uses SAS-backed `WEBSITE_RUN_FROM_PACKAGE` with a short-lived SAS; this works now but is not ideal long term.
- Durable deployment hardening is needed later, preferably away from expiring SAS URLs if feasible.
- Entra/OIDC/JWT design and app registrations are still needed.
- Angular login flow is still needed.
- Backend token validation and user allowlist are still needed.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
