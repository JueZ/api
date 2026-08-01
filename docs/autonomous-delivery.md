# Autonomous delivery

The canonical policy is `.github/autonomous-policy.yml`. This document explains the local design; it does not prove live repository settings.

## Pull-request gate

`Codex Auto-Merge` uses `pull_request_target` only to run controller code checked out from `main`. It never checks out or executes PR code with write permissions.

For each candidate it:

1. records the exact PR head SHA;
2. checks branch/label eligibility and blocks forks/hold labels;
3. classifies high-risk paths deterministically;
4. waits for every free canonical check from the expected `github-actions` app;
5. serializes controller runs per pull request, revalidates every free exact-head check, verifies every workflow has an explicit permission map and computes each job's effective permissions, rejects alternate GitHub credential injection, and creates one completed permanent repository/PR/head-SHA paid-call marker immediately before any paid request;
6. revalidates the free checks again at the API boundary and permits the single bounded request only while they still pass;
7. never patches, releases, or reuses a paid-call marker or approval; any existing marker permanently blocks another request for that PR/head;
8. runs at most one independent structured AI request for a newly claimed high-risk head with `store=false`;
9. publishes `Autonomous review complete` for that exact SHA;
10. rechecks open/current/non-behind PR state;
11. squash-merges only the reviewed head SHA.

Critical/high review findings, a duplicate/consumed paid-review claim, stale heads, missing/wrong-app checks, forks, merge conflicts, and policy errors fail closed. Label changes are controller events, so adding/removing eligibility or hold labels is evaluated immediately without permitting a second exact-head paid request. Routine and high-risk changes do not require human approval under the selected policy.

Repository workflow defaults are kept read-only with Actions unable to approve pull requests. The controller does not rely on that mutable setting for check-writer isolation: every workflow must declare an explicit top-level permission map, job overrides are evaluated with GitHub inheritance semantics, only the approved controller jobs may receive `checks: write`, and GitHub App/PAT minting or alternate credentials in GitHub-auth token channels are rejected. The required check's GitHub App identity is still verified on the exact head.

If a free gate changes in the narrow interval after marker creation but before the API boundary, the controller fails closed and the marker remains consumed. Retrying a paid review requires a genuinely repaired new commit and a fresh full set of free gates.

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

The live branch ruleset must require the exact names in `.github/autonomous-policy.yml`, disallow direct/force pushes and `main` deletion, require up-to-date PRs, and prevent admin bypass. CODEOWNERS records accountability but is not a routine approval gate.

## Build and delivery

Main CI builds the Function, frontend source bundle, and CycloneDX SBOM once. The release manifest contains the full source SHA and SHA-256 digests; main artifacts receive build provenance attestations. Each environment then renders its approved runtime frontend configuration before deployment, updates the manifest and checksums with the rendered archive digest, and preserves the exact accepted production archive for rollback.

`Codex Main Delivery` is the only normal post-merge controller. It explicitly dispatches and waits for:

1. main CI;
2. Deploy Test;
3. Promote Production.

Test and production receive the exact first-attempt main-CI run ID and its title correlation from the controller, validate that run through the Actions API, and download only that run's artifact; they never select a latest interchangeable CI run. Production also requires those same CI coordinates in the exact successful test provenance. The environment-specific rendered frontend is independently hashed before either application package is deployed and is recorded in the ledger. Deployments use Azure OIDC, never a local production command or long-lived Azure client secret.

Production stays disabled unless `DEPLOY_PRODUCTION_ENABLED=true`. The user can prevent deployment with the supported skip markers. The post-merge controller accepts only first-attempt trigger and controller runs and treats a duplicate event for the same exact trigger as an idempotent no-op. Promotion and rollback share `production-deployment` concurrency; only the dedicated rollback flow may intentionally deploy an older known-good full `main` SHA. Every production promotion and rollback must deploy both application packages. Rollback is strictly package-only: current `main` supplies the immutable controller and validation logic, the complete Bicep-owned app-setting key set and every non-secret value are validated read-only before mutation, and the workflow does not execute Bicep, reconcile safety settings, create release blobs, or rewrite the preserved frontend bundle. Workflow reruns are rejected before mutation; recovery requires a new dispatch and correlation.

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
