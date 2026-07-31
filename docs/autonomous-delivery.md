# Autonomous delivery

The canonical policy is `.github/autonomous-policy.yml`. This document explains the local design; it does not prove live repository settings.

## Pull-request gate

`Codex Auto-Merge` uses `pull_request_target` only to run controller code checked out from `main`. It never checks out or executes PR code with write permissions.

For each candidate it:

1. records the exact PR head SHA;
2. checks branch/label eligibility and blocks forks/hold labels;
3. classifies high-risk paths deterministically;
4. runs an independent structured AI review for high-risk changes with `store=false`;
5. publishes `Autonomous review complete` for that exact SHA;
6. resolves every Actions check to its exact run/job and proves the canonical workflow ID/path, `pull_request` event,
   first attempt, repository, PR/base/head, and exact head SHA; the controller review check is bound to its recorded
   check-run ID;
7. rechecks open/current/non-behind PR state;
8. squash-merges only the reviewed head SHA.

Critical/high review findings, stale heads, missing/wrong-app/wrong-source checks, forks, merge conflicts, and policy errors fail closed. A same-name check from another GitHub Actions workflow is not trusted even though it uses the same GitHub App. Routine changes do not require human approval under the selected policy. Autonomous-delivery trust roots in `merge.autonomousExcludedPaths` are an explicit exception: the controller rejects them before model approval and requires an independently controlled security review/bootstrap.

## Required checks

- install, lint, type-check, unit tests, API tests;
- Angular and Azure Functions builds;
- OpenAPI and Bicep validation;
- actionlint/ShellCheck;
- architecture, repository-skill, generated-doc, and agent-eval checks;
- Trivy, Gitleaks, dependency audit, npm lock policy;
- CodeQL JavaScript/TypeScript and Actions;
- immutable release artifacts;
- cost and guardrail policy;
- `CI complete`, `Policy complete`, and `Autonomous review complete`.

The live `main` branch protection must require the exact `(check name, GitHub App ID)` pairs in `.github/autonomous-policy.yml`, disallow direct/force pushes and `main` deletion, require up-to-date PRs, and prevent admin bypass. The generated branch-protection payload uses app-bound `checks`, not history-dependent legacy contexts. After an authorized update, `gh api repos/JueZ/api/branches/main/protection | node scripts/render-branch-protection.mjs --verify` fails closed on missing, extra, duplicate/wrong-app checks or safety-setting drift. CODEOWNERS records accountability but is not a routine approval gate.

## Build and delivery

Main CI builds the Function, frontend source bundle, and CycloneDX SBOM once. The release manifest contains the full source SHA and SHA-256 digests; main artifacts receive build provenance attestations. Before Azure login or mutation, deployment verifies the Function, SBOM, and (for normal promotion) frontend attestations against the exact `main` source SHA and `ci.yml` signer workflow, then verifies the checked-in release manifest. Each environment then renders its approved runtime frontend configuration before deployment, updates the manifest and checksums with the rendered archive digest, and preserves the exact accepted production archive for rollback.

`Codex Main Delivery` is the only normal post-merge controller. It explicitly dispatches and waits for:

1. main CI;
2. Deploy Test;
3. Promote Production.

Test and production receive the exact first-attempt main-CI run ID and its title correlation from the controller, validate that run through the Actions API, and download only that run's artifact; they never select a latest interchangeable CI run. Production also requires those same CI coordinates in the exact successful test provenance. The environment-specific rendered frontend is independently hashed before either application package is deployed and is recorded in the ledger. Deployments use Azure OIDC, never a local production command or long-lived Azure client secret.

Production stays disabled unless `DEPLOY_PRODUCTION_ENABLED=true`. The user can prevent deployment with the supported skip markers. The post-merge controller accepts only first-attempt trigger and controller runs and treats a duplicate event for the same exact trigger as an idempotent no-op. Promotion and rollback share `production-deployment` concurrency; only the dedicated rollback flow may intentionally deploy an older known-good full `main` SHA. Every production promotion and rollback must deploy both application packages. Rollback is strictly package-only: current `main` supplies the immutable controller and validation logic, the complete Bicep-owned app-setting key set and every non-secret value are validated read-only before mutation, and the workflow does not execute Bicep, reconcile safety settings, create release blobs, or rewrite the preserved frontend bundle. Workflow reruns are rejected before mutation; recovery requires a new dispatch and correlation.

An unresolved credential incident activates a repository-controlled deployment hold. Exact static first steps stop the shared test/production/rollback workflow, private-storage migration, Bring service-token canary, and Azure OIDC diagnostic before checkout, token minting, OIDC, secrets, or Azure access. Repository Actions and native auto-merge are disabled because required status checks cannot distinguish workflow/event and every Actions workflow shares App ID `15368`; without an organization required-workflow rule or independent App, an untrusted same-repository workflow could otherwise read repository secrets and spoof check names. The seven OIDC/mutation entry workflows remain manually disabled, both deployment environments accept protected branches only, and the repository OIDC template uses exactly `repo`, `context`, and `job_workflow_ref`. `npm run ops:verify-github-deployment-controls` reads only those structural settings and fails closed on drift or unavailable metadata. The custom subject intentionally breaks the prior Azure federation until exact workflow-bound credentials are installed. No deployment input, variable, retry, historical ref, feature-branch dispatch, or local agent command may route around it.

The incident file is active-only because GitHub itself is an affected credential system and no independent repository security approver currently exists. A JueZ comment or workflow result cannot distinguish an exposed token from a rotated, hardware-backed session, so `active=false`, `verified`, and repository-local approval data are invalid. A protected evidence change may record unique non-secret inventory/revocation/replacement references, real timestamps, and equal nonzero counts, but the hold remains active. Recovery requires external credential revocation followed by an out-of-band trust-root bootstrap (a separately controlled security principal or pre-pinned hardware-backed signature). Hold, workflow, controller, policy, and related security-control paths are excluded from autonomous merge. Only after that independent bootstrap may a reviewed recovery change define cryptographic clearance, replace Azure federated credentials/RBAC, remove static blocks, and re-enable test. Production stays disabled until a fresh first-attempt test run passes all acceptance evidence.

The private migration has additional latent-TOCTOU protection: the current workflow/check-out/main identity and live hold are re-read immediately before Azure login and immediately before/after the upload. Attempt greater than one, main drift, active/invalid hold, or GitHub API failure rejects the run. Its concurrency cancels an older migration, while suspended Azure federation/RBAC remains the authoritative incident kill switch.

## Runtime evidence

Deployment is successful only when applicable evidence passes:

- `/health` reports the exact source/deployed SHA;
- public and authenticated smokes pass;
- protected auth smoke covers hello and Reddit;
- CORS/MCP origins match canonical values;
- telemetry observes the safe smoke correlation ID;
- release-ledger artifact/digests validate;
- production repair issues reflect runtime evidence, not merely a merge.

Local checks, commits, PR merge, and Azure deployment are different states. Project memory must state which one is proven.
