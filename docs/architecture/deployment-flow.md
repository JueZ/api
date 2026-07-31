# Deployment flow

1. PR CI, Policy Check, CodeQL, architecture/eval gates, and deterministic policy run on the exact head SHA.
2. The trusted default-branch controller classifies risk. High-risk diffs are independently reviewed with the configured AI model; critical/high findings fail the exact-head check.
3. The controller verifies every required check came from the expected GitHub App, the branch is current, and the head still matches, then performs a squash merge.
4. Main CI builds the Function, frontend, and CycloneDX SBOM once. SHA-256 manifests and build provenance bind them to the full commit SHA.
5. `Codex Main Delivery` explicitly dispatches test deployment after main CI.
6. Test downloads and verifies the exact artifact, deploys with Azure OIDC, then requires runtime SHA, unauthenticated, authenticated, and telemetry-correlation checks.
7. Production promotion downloads the same digests proven in test. Promotion is disabled unless `DEPLOY_PRODUCTION_ENABLED=true`.
8. Production uses the same concurrency group as rollback and rejects a source older than the current deployed main ancestor, except through the dedicated rollback workflow.

No local shell deployment or mutable branch/tag artifact is accepted. The live repository ruleset and Entra/Azure role assignments remain bootstrap prerequisites and cannot be proven by local validation.
