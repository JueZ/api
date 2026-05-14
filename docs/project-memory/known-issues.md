# Known issues and unresolved risks

Last updated: 2026-05-14

- API authentication is not yet implemented.
- `GET /api/hello` is a public placeholder until the auth milestone.
- Deployment uses storage-backed `WEBSITE_RUN_FROM_PACKAGE`; durable deployment hardening may still be useful later if operational needs grow.
- Entra/OIDC/JWT design and app registrations are still needed.
- Angular login flow is still needed.
- Backend token validation and user allowlist are still needed.
- Budget/cost alert documentation should be confirmed or added if not already present.
- Decide later whether API Management is needed; it is not part of v0.
