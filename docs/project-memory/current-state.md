<!-- project-memory-asOf: 2026-08-10 -->
# Current state

## Repository delivery

- Protected `main` requires exactly `PR Gate` and `Security Gate` from GitHub Actions, with strict/up-to-date PRs, admin enforcement, linear history, conversation resolution, force-push denial, and deletion denial.
- Repository-native exact-head squash auto-merge is enabled. No custom merge controller, check-run writer, arbitrary status rollup, or required model review exists.
- `PR Gate` and `Security Gate` use one fail-closed path classifier. Pull requests run proportional validation and never build release artifacts.
- `Delivery v2` is the sole normal controller. A push to protected `main` classifies runtime impact, builds one immutable release when applicable, verifies test, promotes the same application digests to production, and verifies production.
- `DELIVERY_V2_ENABLED=true` and `DEPLOY_PRODUCTION_ENABLED=true`. Production and one-shot package rollback share `production-deployment` concurrency.
- The repair queue creates or updates one sanitized issue per exact run/fingerprint. It cannot invoke Codex or rewrite repository files.

## Runtime and security

- Test and production use Azure OIDC, managed identity/Key Vault boundaries, exact release SHA/digests, public and authenticated smoke, telemetry correlation, provenance, and compact release ledgers.
- Authentication, authorization, operation permissions, audit, idempotency, destructive confirmation, allowlists, and provider-data minimization remain fail closed.
- Optional OpenAI use is restricted to bounded sanitized runtime repairable-error analysis. Pull-request governance, repair callbacks, and required checks use no provider key.

## Learning and memory

- Significant and recurring failures use executable prevention plus concise schema-v2 learning artifacts. Learning validation runs only when learning files or their validator change.
- Completed phase ledgers, historical acceptance evidence, model-backed task harnesses, workflow hashes, and chronological project-memory logs have been removed. GitHub and Git history are the execution record.
- Query live GitHub/Azure/runtime state for the current deployed SHA and workflow outcome; do not copy routine run narration into this file.
