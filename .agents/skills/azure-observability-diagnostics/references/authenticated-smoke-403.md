# Authenticated smoke 403 triage

When `/health` and the unauthenticated `401` gate pass but authenticated smoke returns `403`, keep authorization fail-closed and check these boundaries in order:

1. Confirm the smoke client, tenant, requested `.default` resource, accepted issuer, API audience, tenant allowlist, and service client/object allowlists correlate. Compare in memory and emit only booleans or counts; do not print variable values or a token.
2. Inspect the `Mint authenticated smoke token with GitHub OIDC` step. It validates the decoded Entra token locally without logging claims and must require `catalogue.read,reddit.read`. The Bring canary must require only `bring.read`.
3. If the mint step reports missing application roles, use `scripts/configure-entra-service-oauth.sh` from a trusted checkout with a privileged Entra operator. Do not restore retired `api.access`/`api.test`, change the API to accept a broader role, or bypass authenticated smoke.
4. If `az ad sp show` or Microsoft Graph returns permission denied, record the precise directory-permission blocker. Azure subscription Contributor/RBAC authority does not imply Microsoft Graph application-management authority.
5. After role assignment, dispatch a new first-attempt test run. Require authenticated hello and Reddit smoke, telemetry correlation, provenance, and runtime truth before production.

Treat the service app-role assignment as an external Entra control. Bicep resource success cannot prove it.
