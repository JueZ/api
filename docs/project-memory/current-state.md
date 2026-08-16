<!-- project-memory-asOf: 2026-08-16 -->
# Current state

## Repository delivery

- Protected `main` requires exactly `PR Gate` and `Security Gate` from GitHub Actions, with strict/up-to-date PRs, admin enforcement, linear history, conversation resolution, force-push denial, and deletion denial.
- Repository-native exact-head squash auto-merge is enabled. No custom merge controller, check-run writer, arbitrary status rollup, or required model review exists.
- `PR Gate` and `Security Gate` use one fail-closed path classifier. Pull requests run proportional validation and never build release artifacts.
- The root/build and standalone `apps/api` Function manifests are independent dependency projects. Both receive pair-local lock policy, audit, Dependabot, CodeQL, and Trivy coverage; the release CycloneDX SBOM describes the exact installed production Function stage.
- `Delivery v2` is the sole normal controller. A push to protected `main` classifies runtime impact, builds one immutable release when applicable, verifies test, promotes the same application digests to production, and verifies production.
- `DELIVERY_V2_ENABLED=true` and `DEPLOY_PRODUCTION_ENABLED=true`. Production and one-shot package rollback share `production-deployment` concurrency.
- The repair queue creates or updates one sanitized issue per exact run/fingerprint. It cannot invoke Codex or rewrite repository files.

## Runtime and security

- Test and production use Azure OIDC, managed identity/Key Vault boundaries, exact release SHA/digests, public and authenticated smoke, telemetry correlation, provenance, and compact release ledgers.
- Authentication requires an explicit `local`, `test`, or `prod` runtime identity. Non-local tenant allowlists are enforced again at the request boundary; delegated `scp` and app-role service permissions are classified separately; and discovered JWKS metadata is issuer-bound, redirect-free, and same-origin while an explicit JWKS URI remains an operator-managed pin.
- Authenticated Reddit/WLH JSON bodies are streamed through a shared 64 KiB boundary after authorization; declared and streamed overages fail with 413 before provider work. Reddit provider payloads cannot become public error details, telemetry omits raw caller input and uses route-normalized allowlisted URLs, and deployed MCP binds single-value proxy headers plus request authority to a non-localhost, non-IP canonical HTTPS origin.
- Bring mutation integrity v2 binds replay identity and confirmation tokens to the action, list, payload, client, token type, and tenant-tagged object-ID-or-subject principal. Durable results require the exact consumed-token HMAC, encrypted payloads use record-bound AAD, and legacy v1 records/tokens are retained but never replayed or decrypted.
- Authentication, authorization, operation permissions, audit, idempotency, destructive confirmation, allowlists, and provider-data minimization remain fail closed.
- Optional OpenAI use is restricted to bounded sanitized runtime repairable-error analysis. Pull-request governance, repair callbacks, and required checks use no provider key.

## Learning and memory

- Significant and recurring failures use executable prevention plus concise schema-v2 learning artifacts. Learning validation runs only when learning files or their validator change.
- Completed phase ledgers, historical acceptance evidence, model-backed task harnesses, workflow hashes, and chronological project-memory logs have been removed. GitHub and Git history are the execution record.
- Query live GitHub/Azure/runtime state for the current deployed SHA and workflow outcome; do not copy routine run narration into this file.
