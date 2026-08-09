# Autonomous delivery

The canonical policy is `.github/autonomous-policy.yml`. This document explains the local design; it does not prove live repository settings.

## Pull-request gate

`Codex Auto-Merge` uses `pull_request_target` only to run controller code checked out from protected `main`. It never checks out or executes PR code with write permissions.

For each candidate it:

1. records the exact PR head SHA and verifies branch/label eligibility, fork denial, blocking labels, and current mergeability;
2. waits for the free exact-head `CI complete`, `Policy complete`, and `CodeQL complete` aggregates from the expected GitHub Actions App;
3. verifies every trusted workflow's complete immutable hash, explicit permission map, effective job permissions, secret allowlist, built-in GitHub token use, and exclusive check-writer jobs;
4. re-reads the exact head after changed-file collection and records deterministic high-risk classification as sanitized governance evidence;
5. authenticates candidate, controller, workflow-run, and protected-main identities and performs applicable Phase 2 program-evidence verification without executing candidate code or exposing credentials;
6. publishes the stable legacy context `Autonomous review complete` only when deterministic governance and program-evidence verification both pass;
7. rechecks open/current/non-behind PR state and the complete latest exact-head check-run and legacy-status rollup; aggregate `unstable` is accepted only when its sole pending cause is the current trusted `merge exact PR head` job;
8. squash-merges only the verified exact head.

No independent model reviewer runs. The controller does not receive `OPENAI_API_KEY`, count provider tokens, create paid-call claims, build model capsules, or call the Responses API. High-risk classification remains a deterministic routing and reporting control; executable tests, scanners, fixed-path policy, workflow integrity, exact-head provenance, program-evidence verification, and complete-rollup enforcement remain mandatory. Missing, malformed, stale, or non-passing evidence makes governance fail closed.

Repository workflow defaults are kept read-only with Actions unable to approve pull requests. Every workflow declares an explicit top-level permission map, job overrides are evaluated with GitHub inheritance semantics, and only the eligibility resolver and aggregate publisher may receive `checks: write`; deterministic governance uses `checks: read`. All workflow secret expressions use an exact allowlist; bracket/dynamic access and `secrets: inherit` are denied. `OPENAI_API_KEY` is additionally restricted to the bounded repairable-error runtime deployment workflows. GitHub App/PAT minting, shell token minting, non-built-in GitHub-auth tokens, and raw check-run access outside the controller are rejected.

## Required checks

Mandatory internal jobs remain:

- install, lint, type-check, unit tests, API tests;
- Angular and Azure Functions builds;
- OpenAPI and Bicep validation;
- actionlint/ShellCheck;
- architecture, repository-skill, versioned-learning, generated-index, generated-doc, and agent-eval checks;
- Trivy, Gitleaks, dependency audit, npm lock policy;
- CodeQL JavaScript/TypeScript and Actions;
- immutable release artifacts;
- cost and guardrail policy.

Protected `main` intentionally requires only four stable aggregate contexts from GitHub Actions: `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete`. `CI complete` and `Policy complete` use explicit `needs` lists plus `if: always()` and reject every non-success dependency result. `CodeQL complete` waits for the complete analysis matrix and likewise rejects every non-success result. `Autonomous review complete` is a stable legacy name and succeeds only when exact-head deterministic governance—including applicable protected program-evidence verification—succeeds. The PR-inapplicable main-only release attestation remains required when applicable but is not included in the PR `CI complete` dependency set.

Aggregate protection reduces configuration drift; it does not reduce validation. Immediately before merge, the controller still evaluates every latest exact-head check run and legacy commit status, including contexts outside the four configured aggregates. Any unrelated pending or failing result blocks merge. GitHub aggregate `unstable` is explainable only by the one in-progress `merge exact PR head` job bound to the current trusted controller run.

The live branch ruleset must require exactly the aggregate names in `.github/autonomous-policy.yml`, disallow direct/force pushes and `main` deletion, require up-to-date PRs, and prevent admin bypass. CODEOWNERS records accountability but is not a routine approval gate.

## Versioned agent learning

Significant failures are disposed through versioned YAML records under `docs/agent-learning/artifacts/`. The strict validator rejects unknown schema fields, duplicate IDs, non-exact commits, repository path escape, stale or missing durable artifacts, expired exceptions, and secret-shaped or private provider content. Verified records additionally require a registered trusted scorer to inspect the exact broken/fixed Git objects without executing historical code; required CI binds live merged-PR metadata to those exact base and merge commits. The generated index is timestamp-free and checked byte-for-byte in CI.

Learning validation runs by fixed script paths inside `architecture and agent validation`, so it remains mandatory behind `CI complete` without adding a brittle protected context. `AGENTS.md`, repository skills, learning records, task definitions, and trusted scorer/controller paths remain high-risk agent-governance changes. Failure evidence can create a candidate, but cannot directly rewrite those controls; implementation and any waiver require a normal protected PR with deterministic governance. A waiver does not count as verified proof.

Daily repair triage is write-enabled only for idempotent issue metadata: it can create the six fixed learning labels, create a sanitized learning candidate after operational recovery is proven, append a new unique source to an open matching fingerprint, and link the candidate from the repair. Stable markers prevent duplicate scheduled mutations, and recurrence two adds executable-prevention guidance. The immutable rollout timestamp excludes earlier repair issues; a manual historical backfill requires an exact range of at most 100 issue numbers and defaults to dry run. The workflow retains `contents: read`, `issues: write`, `pull-requests: read`, and `actions: read`, executes no source text, invokes no model, and cannot close repairs unless the existing explicit closure input is enabled. Even then, runtime/PR evidence plus a linked candidate or strict owned and dated no-artifact/transient disposition is required.

The protected-main governance job invokes `scripts/agent-learning/verify-program-evidence.mjs trusted-pr` after exact-head deterministic governance and before publishing `Autonomous review complete`. The candidate checkout is never executed or given a credential. For ordinary PRs the verifier authenticates repository, PR, exact head/base, changed files, controller run/workflow SHA, governance evidence, and a stable final candidate snapshot, then writes a sanitized `not_applicable` artifact. A Phase 2 evidence or acceptance change additionally requires the registered public-safe evidence file and independently verifies its complete GitHub, delivery, ledger, and runtime claims. Missing, malformed, stale, self-referential, or unavailable evidence fails the existing branch-required aggregate. The later merge job retains complete-rollup and exact-head merge defenses but no longer repeats the verifier; no fifth context or model call is introduced.

## Historical agent-task evaluation

General task evaluation is separate from PR governance and never becomes a branch-required paid check. Versioned task files bind full historical SHAs, source PRs, registered setup/scorer IDs, timeouts, path bounds, file-count limits, hard safety gates, and behavioral assertions. The controller creates a detached temporary worktree outside the primary checkout, optionally commits a reviewed current instruction/context overlay, runs one registered adapter, scores from the trusted controller checkout, writes only sanitized local JSON/Markdown, and removes the worktree on success, failure, or timeout.

Required CI runs only task validation, trusted scorer unit tests, and deterministic fake-adapter integration. Real Codex execution requires explicit paid confirmation and existing ChatGPT authentication. Its model-generated commands use `workspace-write`, approval policy `never`, no outbound network, a sterile allowlisted shell environment, and no GitHub, Azure, provider, or production credential. No adapter may push, open a PR, deploy, mutate production, change its task/scorer, or archive a full transcript. Adapter absence, authentication failure, timeout, cleanup failure, or an unavailable scorer is failing evidence.

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

After exact-main CI succeeds, the trusted controller obtains the authenticated, paginated PR file list and compares its exact count with GitHub's PR metadata. Environment deployment is skipped automatically only when every changed path—and both sides of every rename—matches the immutable runtime-neutral allowlist validated from `.github/autonomous-policy.yml`: root Markdown, `docs/**`, Markdown under `.github/**`, Markdown under `.agents/skills/**`, `evals/agent-tasks/**`, the dedicated `scripts/agent-learning/**` and `scripts/agent-task-evals/**` controllers, and their scoped agent-learning tests. These assets remain high-risk repository governance and retain every PR aggregate, fixed-path validation, immutable release construction, exact-main CI, and complete-rollup defense; they are omitted only from Azure environment deployment because they are not shipped in either application package. Empty, malformed, duplicated, traversing, incomplete, workflow, policy, package, contract, infrastructure, application, other-script, mixed, or otherwise deployment-impacting metadata fails closed to normal Deploy Test and Promote Production.

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
