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
6. waits for every canonical check from the expected `github-actions` app;
7. rechecks open/current/non-behind PR state;
8. squash-merges only the reviewed head SHA.

Critical/high review findings, stale heads, missing/wrong-app checks, forks, merge conflicts, and policy errors fail closed. Routine and high-risk changes do not require human approval under the selected policy.

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

Main CI builds Function, frontend, and CycloneDX SBOM once. The release manifest contains the full source SHA and SHA-256 digests; main artifacts receive build provenance attestations.

`Codex Main Delivery` is the only normal post-merge controller. It explicitly dispatches and waits for:

1. main CI;
2. Deploy Test;
3. Promote Production.

Test and production download the exact main-CI artifact. Production verifies its digests equal the successful test release ledger. Deployments use Azure OIDC, never a local production command or long-lived Azure client secret.

Production stays disabled unless `DEPLOY_PRODUCTION_ENABLED=true`. The user can prevent deployment with the supported skip markers. Promotion and rollback share `production-deployment` concurrency; only the dedicated rollback flow may intentionally deploy an older known-good full `main` SHA.

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
