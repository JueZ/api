# Autonomous delivery

The canonical policy is `.github/autonomous-policy.yml`. This document explains the local design; it does not prove live repository settings.

## Pull-request gate

`Codex Auto-Merge` uses `pull_request_target` only to run controller code checked out from `main`. It never checks out or executes PR code with write permissions.

For each candidate it:

1. records the exact PR head SHA;
2. checks branch/label eligibility and blocks forks/hold labels;
3. classifies high-risk paths deterministically;
4. waits for every free canonical check from the expected `github-actions` app;
5. serializes controller runs per pull request, revalidates every free exact-head check, verifies every workflow has an explicit permission map and computes each job's effective permissions, rejects non-allowlisted or dynamic secret access and alternate GitHub credential injection, and creates one completed permanent paid-call marker from inside the same review command that owns the request;
6. binds that marker to repository, PR, exact head, trusted controller workflow, and workflow run; re-reads it after creation, before exact token counting, and again at the generation boundary; and permits OpenAI requests only while exactly that canonical marker and every free check still pass;
7. never patches, releases, or reuses a paid-call marker or approval; any existing marker permanently blocks another request for that PR/head;
8. makes one exact input-token count request and, only when the complete request remains within the cost ceiling, at most one independent structured model-generation request with `store=false`, a 3,500-token static output cap, and explicit final-JSON capacity reservation;
9. publishes `Autonomous review complete` for that exact SHA;
10. rechecks open/current/non-behind PR state and the complete latest exact-head check-run and legacy-status rollup; aggregate `unstable` is accepted only when its sole pending cause is the current trusted `merge exact PR head` job;
11. squash-merges only the reviewed head SHA.

Critical/high review findings, a duplicate/consumed paid-review claim, stale heads, missing/wrong-app checks, forks, merge conflicts, and policy errors fail closed. Label changes are controller events, so adding/removing eligibility or hold labels is evaluated immediately without permitting a second exact-head paid request. Routine and high-risk changes do not require human approval under the selected policy.

Repository workflow defaults are kept read-only with Actions unable to approve pull requests. The controller does not rely on that mutable setting for check-writer isolation: every workflow must declare an explicit top-level permission map, job overrides are evaluated with GitHub inheritance semantics, and only the approved controller jobs may receive `checks: write`. All workflow secret expressions use an exact allowlist; bracket/dynamic access and `secrets: inherit` are denied. GitHub App/PAT minting, shell token minting, non-built-in GitHub-auth tokens, and raw check-run access outside the controller are rejected. The required check and paid-call marker GitHub App identities are verified on the exact head.

The live API path is accepted only from the exact `Codex Auto-Merge` GitHub Actions run. The standalone claim command has been removed, and the marker ID, canonical external identity, details URL, App identity, status, and conclusion must all match before either OpenAI request. The bounded model capsule contains the complete contextual diff for every changed non-documentation path, including executable policy helpers that are not themselves classified as high risk, and every classifier-matched high-risk documentation path, plus metadata for every changed file. Ordinary mixed `docs/` diffs may be omitted, while documentation-only high-risk PRs retain every changed documentation diff. Capsule completeness is checked against GitHub's authoritative changed-file list and deterministic risk classification. A hard 200,000-byte capsule limit rejects oversized reviews without silent truncation; the OpenAI input-token endpoint then counts the exact structured request, and the model-generation maximum—not an approximate byte or line count—must remain under the configured cost ceiling. If a free gate or marker changes after creation, before counting, or before generation, the controller fails closed and the marker remains consumed. Retrying requires a genuinely repaired new commit and a fresh full set of free gates.

## Required checks

Mandatory internal jobs remain:

- install, lint, type-check, unit tests, API tests;
- Angular and Azure Functions builds;
- OpenAPI and Bicep validation;
- actionlint/ShellCheck;
- architecture, repository-skill, generated-doc, and agent-eval checks;
- Trivy, Gitleaks, dependency audit, npm lock policy;
- CodeQL JavaScript/TypeScript and Actions;
- immutable release artifacts;
- cost and guardrail policy.

Protected `main` intentionally requires only four stable aggregate contexts from GitHub Actions: `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete`. `CI complete` and `Policy complete` use explicit `needs` lists plus `if: always()` and reject every non-success dependency result. `CodeQL complete` waits for the complete analysis matrix and likewise rejects every non-success result. The PR-inapplicable main-only release attestation remains required when applicable but is not included in the PR `CI complete` dependency set.

Aggregate protection reduces configuration drift; it does not reduce validation. Immediately before merge, the controller still evaluates every latest exact-head check run and legacy commit status, including contexts outside the four configured aggregates. Any unrelated pending or failing result blocks merge. GitHub aggregate `unstable` is explainable only by the one in-progress `merge exact PR head` job bound to the current trusted controller run.

The live branch ruleset must require exactly the aggregate names in `.github/autonomous-policy.yml`, disallow direct/force pushes and `main` deletion, require up-to-date PRs, and prevent admin bypass. CODEOWNERS records accountability but is not a routine approval gate.

## Build and delivery

The steady-state operating model is always-on autonomous delivery. `Codex Auto-Merge`, `Codex Main Delivery`, `Deploy Test`, and `Promote Production` remain enabled so an eligible Codex PR can proceed through exact-head review, protected merge, exact-main CI, test acceptance, and production promotion without a human acting as the routine watcher. Codex monitors every terminal gate, applies only scoped repairs within the repository repair limit, and reports any concrete blocker. Disabling one of these workflows is an exceptional fail-closed incident or maintenance action; it must be time-bounded, documented in project memory, and restored after the blocker is resolved. Rollback remains a separate explicitly requested operational action.

Main CI builds the Function, frontend source bundle, and CycloneDX SBOM once. The release manifest contains the full source SHA and SHA-256 digests; main artifacts receive build provenance attestations. Each environment then renders its approved runtime frontend configuration before deployment, updates the manifest and checksums with the rendered archive digest, and preserves the exact accepted production archive for rollback.

`Codex Main Delivery` is the only normal post-merge controller. It explicitly dispatches and waits for:

1. main CI;
2. Deploy Test;
3. Promote Production.

Main CI remains an exact-main `workflow_dispatch`. Privileged deployment entry points use typed repository dispatch events so GitHub loads them only from the default branch. The controller sends only full source SHAs, opaque correlations, and exact accepted run IDs; each receiver independently validates current main, first-attempt Actions metadata, artifact provenance, and environment gates before mutation. Triggering these events requires repository write authority, but supplying a branch or tag cannot select privileged workflow code.

The `workflow_run` entry gate identifies CI and auto-merge by their immutable workflow file paths, not the display-oriented run name. A workflow-level `run-name` can replace the observed `.name` value, while `.path` remains the authoritative controller identity.

Test and production receive the exact first-attempt main-CI run ID and its title correlation from the controller, validate that run through the Actions API, and download only that run's artifact; they never select a latest interchangeable CI run. Production also requires those same CI coordinates in the exact successful test provenance. The environment-specific rendered frontend is independently hashed before either application package is deployed and is recorded in the ledger. Deployments use Azure OIDC, never a local production command or long-lived Azure client secret.

Production stays disabled unless `DEPLOY_PRODUCTION_ENABLED=true`. The user can prevent deployment with the supported skip markers. The post-merge controller accepts only first-attempt trigger and controller runs and treats a duplicate event for the same exact trigger as an idempotent no-op. Promotion and rollback share `production-deployment` concurrency; only the dedicated rollback repository-dispatch event may intentionally deploy an older known-good full `main` SHA. Every production promotion and rollback must deploy both application packages. Rollback is strictly package-only: current `main` supplies the immutable controller and validation logic, the complete Bicep-owned app-setting key set and every non-secret value are validated read-only before mutation, and the workflow does not execute Bicep, reconcile safety settings, create release blobs, or rewrite the preserved frontend bundle. Workflow reruns are rejected before mutation; recovery requires a new dispatch and correlation.

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
