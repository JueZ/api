# ADR 0006: Simple autonomous delivery

- Status: accepted
- Date: 2026-08-10
- Supersedes: ADR 0001 delivery-governance mechanism

## Decision

Use two native protected pull-request aggregates—`PR Gate` and `Security Gate`—with deterministic path classification and explicit internal dependencies. Use GitHub-native exact-head squash auto-merge. Build the release once from protected `main` and deliver it through a direct push-triggered DAG to test and production.

The protected branch, rather than a custom PR/main lineage controller, is the trust boundary. Optional checks remain advisory. Runtime-neutral changes skip application release construction. Deployment-impacting changes preserve immutable artifacts, provenance, OIDC, exact SHA/digest verification, public/authenticated smoke, telemetry, compact release ledgers, superseded-generation handling, and one-shot known-good package rollback.

Repository-level variables and the trusted classifier—not a per-task deployment approval—select normal delivery. Runtime-affecting work reaches a successful terminal state only after applicable current-main deployment and runtime verification.

Repair execution is bounded, but the requirement is not abandoned when one strategy or generation ends. Two ineffective attempts retire one strategy and require re-diagnosis. A trusted workflow queue keeps one sanitized active continuation per failure lineage when work outlives the initiating task; later applicable unblocked repository work resumes it. The official Codex GitHub integration has no unattended implementation callback, so the repository does not add an API key or custom bot.

Protected security, merge, provenance, deployment, and runtime controls are hard invariants. Other architectural guidance remains challengeable through explicit scoped evidence and validated minimal deviations.

Closed-loop learning remains objective and protected but is not part of unrelated feature eligibility. GitHub and Git history retain execution evidence; the repository stores only concise invariants, current facts, and architecture decisions.

## Consequences

Ordinary changes run fewer jobs, avoid duplicate builds and tests, and no longer depend on polling, dispatch correlation, exact-main validation reuse, byte-hash manifests, acceptance ledgers, or evidence-only PRs. Security remains fail-closed through branch protection, path fallback, explicit aggregates, supply-chain scans, workflow policy, immutable release identity, and staged runtime verification.
