# Staged deployment setup

The deployment workflow is intentionally infrastructure-only until all bootstrap prerequisites are verified.

## GitHub

Configure the exact required checks in `.github/autonomous-policy.yml`, squash merge, up-to-date branches, no direct/force push, no `main` deletion, and no admin bypass. Enable the trusted autonomous controller and repository `OPENAI_API_KEY` for independent high-risk review. Ordinary changes do not require human approval; `merge.autonomousExcludedPaths` are trust roots and cannot be autonomously reviewed or merged.

Create `test` and `production` environments for variable separation and deployment history. Both must allow protected branches only and disable custom branch policies. Set the repository OIDC subject template to `use_default=false` with the exact ordered claims `repo`, `context`, and `job_workflow_ref`. Verify these controls with `npm run ops:verify-github-deployment-controls`. Keep `DEPLOY_PRODUCTION_ENABLED=false` until test, identity, RBAC, migration, smoke, telemetry, and rollback posture are proven.

If `.github/security-deployment-hold.json` is active or any static credential-incident block remains, all test, production, rollback, private-storage migration, service-canary, and Azure OIDC diagnostic operations are intentionally unavailable. Static first steps exist in the shared deployment, migration, Bring canary, and Azure OIDC diagnostic workflows. Do not add an override or mutate Azure/providers locally. Repository Actions and native auto-merge, plus the seven enumerated OIDC/mutation entry workflows, must remain disabled. They may be re-enabled only after GitHub credential rotation and an independent check/workflow trust boundary are established.

Revoke every old credential and rotate every replacement in GitHub, Azure, and every affected provider. A protected evidence change may keep the hold active and set `evidence-recorded` with only unique private-inventory/revocation/replacement audit references, real timestamps after discovery, and matching nonzero revoked/rotated counts. It cannot clear the incident. GitHub is an affected system and the only current collaborator is the implicated owner identity, so comments, labels, usernames, workflow outputs, and repository-local fields are not independent approval. `active=false` is rejected. After revocation, provision and verify an out-of-band trust root (separately controlled security principal or hardware-backed signing key) before proposing any recovery schema. Trust-root/hold/workflow changes are excluded from autonomous merge and require a controlled branch-protection bootstrap. Never record secret values, fragments, hashes, or settings dumps as evidence.

## Azure OIDC and RBAC

The custom OIDC template intentionally invalidates legacy Azure federated credentials that trusted only a repository environment subject. After credential rotation, create replacement federated credentials whose exact subjects bind repository, context, and `job_workflow_ref` for:

- `.github/workflows/deploy-environment.yml@refs/heads/main` in `test` and `production`;
- `.github/workflows/migrate-private-storage.yml@refs/heads/main` for each explicitly authorized environment;
- `.github/workflows/bring-readonly-canary.yml@refs/heads/main` and every other service-token workflow using its own least-privilege application;
- `.github/workflows/verify-azure-oidc.yml@refs/heads/main` only through a separate Reader-only diagnostic identity.

Obtain the exact subject spelling from a safe first-attempt token claim inspection and compare it with the configured Azure federated credential; do not guess or restore the default GitHub subject. If the Azure platform supports a reviewed flexible federated identity expression, it must still bind repository owner/name, environment/ref context, and exact workflow path/ref.

Grant the deployment identity only:

- resource-group deployment permission;
- documented role-assignment ability needed by Bicep;
- release/static/WLH-reference container writes scoped as narrowly as Azure supports.

Do not use a long-lived Azure client secret or subscription Owner. The Function uses its own managed identity for host/runtime storage and Key Vault.

## Required configuration

Set exact OIDC/CORS/MCP values, granular permissions, environment-specific resource names, deployment identity object ID, operator alert email, and Bring flags/allowlists. Test Bring add/destructive flags must be false. Secrets include provider credentials, OpenAI API key, and Bring mutation HMAC/encryption keys; deployment stores/references them through Key Vault without printing values.

The combined budget intent is €25: test €10 and production €15.

## Data migration

Before the first split-storage cutover, copy existing WLH reference/session data into the new private account/container using an authorized, logged, read-then-write migration. Verify hashes/counts and retain the old data until runtime validation succeeds. Do not make the normal deployment workflow guess or silently migrate private data.

## Rollout

1. Validate locally and in PR.
2. Let the non-rollback deployment workflow run ARM validation and Azure what-if against test using the exact same parameter array later passed to create. What-if uses `ResourceIdOnly` and suppresses command output so secure parameter values are not emitted.
3. Deploy the exact main-CI artifact to test.
4. Verify health SHA, auth, exact CORS/MCP origin, private/public storage boundaries, Key Vault references, Bring read-only policy, smokes, telemetry correlation, and release ledger.
5. Optionally enable the GET-only Bring canary with its dedicated `bring.read` identity.
6. Set `DEPLOY_PRODUCTION_ENABLED=true` only after test evidence and rollback readiness.
7. Promote the identical test-proven Function, SBOM, and frontend-source digests; render and hash the production frontend configuration before deployment.
8. Verify production runtime truth and keep the release ledger.

Normal promotion uses `Codex Main Delivery` and passes the exact accepted main CI run ID/correlation and Deploy Test run ID/correlation through every stage; no scan may substitute another run. The controller accepts only first-attempt trigger/controller runs and consumes a duplicate event for the same trigger as an idempotent no-op. Every deployment binds the caller's immutable run/workflow SHA, checks out that exact controller, and fails if it is no longer current `main`. Each dispatch must be workflow attempt 1; reruns fail before mutation and must be replaced with a new dispatch/correlation. Production promotion and rollback require both Function and frontend deployment flags. Rollback uses only `rollback-production.yml` with a known-good full `main` SHA plus the exact successful production run ID and delivery correlation for its accepted ledger and preserved release bundle. Current `main` supplies the rollback controller and validation logic, but rollback does not run Bicep or reconcile infrastructure/security settings. It discovers existing resources read-only, validates the complete Bicep-managed app-setting name set and all approved non-secret values plus the complete rendered frontend before mutation, requires the historical digest-addressed Function blob to exist, switches the Function package pointer/provenance without writing safety settings, and uploads the preserved rendered frontend bytes unchanged. The single Azure settings response is streamed directly into the validator; secret values are never persisted, emitted, or compared. Never deploy production from a local shell.
