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

`Delivery v2` is loaded from protected `main` on each `push`. Its explicit `needs` graph classifies the exact protected-main diff, skips runtime-neutral changes, builds one Function package, environment-neutral frontend archive, SBOM, manifest, and checksum set, attests them, deploys the exact artifact to test, verifies test, performs one current-main read, and promotes the same application digests to production. It does not rerun PR validation or reconstruct a squash tree.

The frontend application archive remains byte-identical at the trust boundary. Each environment replaces only its runtime configuration and build-identity files, then records the rendered archive digest separately. Production must consume the same Function, source-frontend, and SBOM digests accepted in test. Azure access uses OIDC, and every environment enforces exact source SHA, public smoke, authenticated smoke, telemetry correlation, and a compact release ledger.

`DELIVERY_V2_ENABLED` guards push-based mutation during cutover. Manual `dry-run` and `test-only` modes are restricted to the exact current protected-main SHA. Once the test-only cutover succeeds, the legacy workflow-run controller is disabled before this variable is enabled, so two controllers cannot promote the same SHA.

The single pre-production main read marks an older delivery as superseded without polling. Production promotion and automatic recovery share the `production-deployment` concurrency group. If production verification fails, live health must show either the failed SHA or the exact pre-promotion SHA. Only the former permits one package-only rollback, and only when a retained, successful production run has one matching immutable release artifact and one validated release ledger. Missing, ambiguous, or mismatched identity stops mutation and leaves the repair issue open.

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
