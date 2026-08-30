# Glossary

- `PR Gate`: path-aware deterministic pull-request validation aggregate required by protected `main`.
- `Security Gate`: Gitleaks plus path-selected audit, CodeQL, and Trivy aggregate required by protected `main`.
- `Delivery v2`: push-triggered protected-main DAG that builds once, verifies test, promotes the same release to production, and performs bounded recovery.
- Release digest: SHA-256 identity of the protected-main release manifest and its Function, frontend-source, and SBOM artifacts.
- Rendered frontend digest: environment-specific frontend archive identity; it may differ between test and production while the application-source digest remains identical.
- GitHub Actions OIDC identity: Azure federated identity used by workflows without a long-lived Azure client secret.
- Failure fingerprint: sanitized stable failure-lineage identifier used to deduplicate delivery/production repair issues and learning candidates.
- Repair strategy fingerprint: stable combination of failure class or gate, root-cause hypothesis, affected surface, and repair mechanism; cosmetic changes do not create a new strategy.
- Repair generation: one bounded execution run that may try materially different strategies without treating budget exhaustion as task completion.
- Active repair continuation: deduplicated durable state for an unfinished requirement, including evidence, attempted strategies, next discriminating action, blocker, and resume condition.
- Hard invariant: mechanically protected safety or delivery boundary whose violation blocks work.
- Soft guidance: challengeable architectural or implementation preference that guides the default but permits a scoped, evidenced, validated deviation.
- Known-good release: one unambiguous retained successful Delivery v2 production artifact and matching ledger for the immediately previous verified SHA.
- `rg-api-test` / `rg-api-prod`: Azure resource groups for test and production.
