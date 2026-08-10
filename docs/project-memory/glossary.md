# Glossary

- `PR Gate`: path-aware deterministic pull-request validation aggregate required by protected `main`.
- `Security Gate`: Gitleaks plus path-selected audit, CodeQL, and Trivy aggregate required by protected `main`.
- `Delivery v2`: push-triggered protected-main DAG that builds once, verifies test, promotes the same release to production, and performs bounded recovery.
- Release digest: SHA-256 identity of the protected-main release manifest and its Function, frontend-source, and SBOM artifacts.
- Rendered frontend digest: environment-specific frontend archive identity; it may differ between test and production while the application-source digest remains identical.
- GitHub Actions OIDC identity: Azure federated identity used by workflows without a long-lived Azure client secret.
- Repair fingerprint: sanitized stable mechanism identifier used to deduplicate delivery/production repair issues and learning candidates.
- Known-good release: one unambiguous retained successful Delivery v2 production artifact and matching ledger for the immediately previous verified SHA.
- `rg-api-test` / `rg-api-prod`: Azure resource groups for test and production.
