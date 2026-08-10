# Autonomous delivery

The canonical policy is `.github/autonomous-policy.yml`. This document explains the local design; it does not prove live repository settings.

## Pull-request gate and merge

One dependency-free classifier maps the exact protected-base diff to documentation, backend, frontend, contracts/integrations, infrastructure/delivery, and privileged profiles. Mixed changes run the union; unknown or malformed inputs fail closed to the privileged profile.

`PR Gate` and `Security Gate` are the only branch-required contexts. Each aggregate has explicit internal dependencies and runs with `if: always()`. A non-applicable internal job must be skipped and is accepted only when the classifier output authorizes that exact skip. `PR Gate` owns formatting, policy, affected application tests/builds, contract drift, Bicep, and workflow/shell validation. `Security Gate` always runs Gitleaks and selects dependency audit, CodeQL, and Trivy by path, with scheduled complete coverage.

Eligible same-repository `codex/...` PRs use GitHub-native exact-head squash auto-merge. Codex records the current head and runs `gh pr merge --auto --squash --delete-branch --match-head-commit <sha>`. Branch protection—not a polling controller or arbitrary status rollup—decides merge eligibility. Optional and advisory checks do not silently become required.

## Required checks

Protected `main` requires exactly the aggregate names in `.github/autonomous-policy.yml`, disallows direct and force pushes and branch deletion, requires an up-to-date PR, preserves linear history and conversation resolution, and prevents admin bypass. CODEOWNERS records accountability but is not a routine approval gate.

## Versioned agent learning

Significant failures are disposed through versioned YAML records under `docs/agent-learning/artifacts/`. The strict validator rejects unknown schema fields, duplicate IDs, non-exact commits, repository path escape, stale or missing durable artifacts, expired exceptions, and secret-shaped or private provider content. Verified records additionally require a registered trusted scorer to inspect the exact broken/fixed Git objects without executing historical code; required CI binds live merged-PR metadata to those exact base and merge commits. The generated index is timestamp-free and checked byte-for-byte in CI.

Learning validation runs by fixed script paths inside `architecture and agent validation`, so it remains mandatory behind `CI complete` without adding a brittle protected context. `AGENTS.md`, repository skills, learning records, task definitions, and trusted scorer/controller paths remain high-risk agent-governance changes. Failure evidence can create a candidate, but cannot directly rewrite those controls; implementation and any waiver require a normal protected PR with deterministic governance. A waiver does not count as verified proof.

Weekly repair triage is write-enabled only for idempotent issue metadata: it can create the six fixed learning labels, create a sanitized learning candidate after operational recovery is proven, append a new unique source to an open matching fingerprint, and link the candidate from the repair. The model-free learning status workflow also runs weekly; both retain manual dispatch for an earlier operator check. Stable markers prevent duplicate scheduled mutations, and recurrence two adds executable-prevention guidance. The immutable rollout timestamp excludes earlier repair issues; a manual historical backfill requires an exact range of at most 100 issue numbers and defaults to dry run. The workflow retains `contents: read`, `issues: write`, `pull-requests: read`, and `actions: read`, executes no source text, invokes no model, and cannot close repairs unless the existing explicit closure input is enabled. Even then, runtime/PR evidence plus a linked candidate or strict owned and dated no-artifact/transient disposition is required.

The protected-main governance job invokes `scripts/agent-learning/verify-program-evidence.mjs trusted-pr` after exact-head deterministic governance and before publishing `Autonomous review complete`. The candidate checkout is never executed or given a credential. For ordinary PRs the verifier authenticates repository, PR, exact head/base, changed files, controller run/workflow SHA, governance evidence, and a stable final candidate snapshot, then writes a sanitized `not_applicable` artifact. A Phase 2 evidence or acceptance change additionally requires the registered public-safe evidence file and independently verifies its complete GitHub, delivery, ledger, and runtime claims. Missing, malformed, stale, self-referential, or unavailable evidence fails the existing branch-required aggregate. The later merge job retains complete-rollup and exact-head merge defenses but no longer repeats the verifier; no fifth context or model call is introduced.

## Historical agent-task evaluation

General task evaluation is separate from PR governance and never becomes a branch-required paid check. Versioned task files bind full historical SHAs, source PRs, registered setup/scorer IDs, timeouts, path bounds, file-count limits, hard safety gates, and behavioral assertions. The controller creates a detached temporary worktree outside the primary checkout, optionally commits a reviewed current instruction/context overlay, runs one registered adapter, scores from the trusted controller checkout, writes only sanitized local JSON/Markdown, and removes the worktree on success, failure, or timeout.

Required CI runs only task validation, trusted scorer unit tests, and deterministic fake-adapter integration. Real Codex execution requires explicit paid confirmation and existing ChatGPT authentication. Its model-generated commands use `workspace-write`, approval policy `never`, no outbound network, a sterile allowlisted shell environment, and no GitHub, Azure, provider, or production credential. No adapter may push, open a PR, deploy, mutate production, change its task/scorer, or archive a full transcript. Adapter absence, authentication failure, timeout, cleanup failure, or an unavailable scorer is failing evidence.

## Build and delivery

The operating model is always-on autonomous delivery. GitHub-native auto-merge owns protected merge. During the controlled delivery-v2 cutover, the existing Main Delivery, Deploy Test, and Promote Production workflows remain enabled until the push-based replacement has passed complete test verification and cannot duplicate a promotion. Codex monitors every terminal gate, applies scoped repairs within the repository repair bound, and reports any concrete blocker.

For deployment-impacting work, main CI builds the Function, frontend source bundle, and CycloneDX SBOM once. Release construction begins after the standalone dependency-install validation and runs in parallel with the remaining lint, test, build, architecture, policy-independent security, and contract jobs. `CI complete` waits for release construction and every other merge-relevant job and rejects every non-success result; downstream delivery accepts artifacts only from the exact successful main CI run. The release manifest contains the full source SHA and SHA-256 digests; main artifacts receive build provenance attestations. Each environment then renders its approved runtime frontend configuration before deployment, updates the manifest and checksums with the rendered archive digest, and preserves the exact accepted production archive for rollback.

`Codex Main Delivery` is the only normal post-merge controller. It explicitly dispatches and waits for:

1. main CI;
2. Deploy Test;
3. Promote Production.

Main CI remains an exact-main `workflow_dispatch`. Protected Main Delivery may request `runtime-neutral-reuse` only after a successful exact-head PR run. The CI verifier independently authenticates the first-attempt governance workflow and artifact, merged PR/head/main identities, complete paginated runtime-neutral file list, stable protected-main generation, and identical Git tree for the fully checked PR head and squash merge. Its isolated import graph uses only Node.js built-ins: governance evidence validation and the synchronized runtime-neutral patterns are fixed modules, while strict JSON duplicate-key rejection no longer requires a package installation. Only then may the aggregate accept every full-validation job as explicitly not applicable. A direct/manual request, stale main, missing artifact, wrong workflow/app identity, file-count drift, malformed rename, mixed or runtime-impacting path, or tree mismatch fails closed; ordinary PR, push, and main runs stay full. Privileged deployment entry points use typed repository dispatch events so GitHub loads them only from the default branch.

The `workflow_run` entry gate identifies CI and auto-merge by their immutable workflow file paths, not the display-oriented run name. A workflow-level `run-name` can replace the observed `.name` value, while `.path` remains the authoritative controller identity. An ineligible auto-merge resolver publishes its exact-head denial and then fails its own job, so a controller that performed no merge cannot produce the successful workflow conclusion that starts Main Delivery.

Main Delivery keeps its existing bounded polling, exact-run correlation, authentication, and timeout behavior. Routine wait output is emitted only when a pinned workflow changes state, completes, fails, or times out; repeated unchanged polling attempts are intentionally silent.

Test and production receive the exact first-attempt main-CI run ID and its title correlation from the controller, validate that run through the Actions API, and download only that run's artifact; they never select a latest interchangeable CI run. Production also requires those same CI coordinates in the exact successful test provenance. The environment-specific rendered frontend is independently hashed before either application package is deployed and is recorded in the ledger. Deployments use Azure OIDC, never a local production command or long-lived Azure client secret.

Production stays disabled unless `DEPLOY_PRODUCTION_ENABLED=true`. The user can prevent deployment with the supported skip markers. The post-merge controller accepts only first-attempt trigger and controller runs and treats a duplicate event for the same exact trigger as an idempotent no-op. Promotion and rollback share `production-deployment` concurrency; only the dedicated rollback repository-dispatch event may intentionally deploy an older known-good full `main` SHA. Every production promotion and rollback must deploy both application packages. Rollback is strictly package-only: current `main` supplies the immutable controller and validation logic, the complete Bicep-owned app-setting key set and every non-secret value are validated read-only before mutation, and the workflow does not execute Bicep, reconcile safety settings, create release blobs, or rewrite the preserved frontend bundle. Workflow reruns are rejected before mutation; recovery requires a new dispatch and correlation.

Before dispatching exact-main CI, the trusted controller obtains the authenticated, paginated PR file list and compares its exact count with GitHub's PR metadata. Its classifier entrypoint uses only Node.js built-ins in the dependency-free controller checkout; deterministic tests keep its static runtime-neutral patterns synchronized with `.github/autonomous-policy.yml`. Validation reuse and environment-deployment omission are requested only when every changed path—and both sides of every rename—matches that immutable allowlist: root Markdown, `docs/**`, Markdown under `.github/**`, Markdown under `.agents/skills/**`, `evals/agent-tasks/**`, the dedicated `scripts/agent-learning/**` and `scripts/agent-task-evals/**` controllers, and their scoped agent-learning tests. These assets remain high-risk repository governance and retain every PR aggregate, fixed-path validation, exact-head governance, exact-main CI, and complete-rollup defense; their identical checked tree makes rebuilding unchanged application bytes in exact-main CI unnecessary. Empty, malformed, duplicated, traversing, incomplete, workflow, policy, package, contract, infrastructure, application, other-script, mixed, or otherwise deployment-impacting metadata fails closed to full exact-main validation and normal Deploy Test and Promote Production.

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
