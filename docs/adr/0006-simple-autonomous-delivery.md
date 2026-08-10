# ADR 0006: Simple autonomous delivery

- Status: accepted
- Date: 2026-08-10
- Supersedes: ADR 0001 delivery-governance mechanism

## Decision

Use two native protected pull-request aggregates—`PR Gate` and `Security Gate`—with deterministic path classification and explicit internal dependencies. Use GitHub-native exact-head squash auto-merge. Build the release once from protected `main` and deliver it through a direct push-triggered DAG to test and production.

The protected branch, rather than a custom PR/main lineage controller, is the trust boundary. Optional checks remain advisory. Runtime-neutral changes skip application release construction. Deployment-impacting changes preserve immutable artifacts, provenance, OIDC, exact SHA/digest verification, public/authenticated smoke, telemetry, compact release ledgers, superseded-generation handling, and one-shot known-good package rollback.

Repair is bounded and monitored by the initiating Codex task. A trusted workflow queue keeps one sanitized issue per failure fingerprint when a failure outlives that task. The official Codex GitHub integration has no unattended implementation callback, so the repository does not add an API key or custom bot.

Closed-loop learning remains objective and protected but is not part of unrelated feature eligibility. GitHub and Git history retain execution evidence; the repository stores only concise invariants, current facts, and architecture decisions.

## Consequences

Ordinary changes run fewer jobs, avoid duplicate builds and tests, and no longer depend on polling, dispatch correlation, exact-main validation reuse, byte-hash manifests, acceptance ledgers, or evidence-only PRs. Security remains fail-closed through branch protection, path fallback, explicit aggregates, supply-chain scans, workflow policy, immutable release identity, and staged runtime verification.
