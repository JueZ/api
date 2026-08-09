# ADR 0001: Deterministic autonomous governance

- Status: superseded in part; deterministic governance accepted as the current decision when delivered
- Date: 2026-08-09
- Supersedes: the API-backed independent-review portion of this ADR's 2026-07-30 decision

## Decision

Routine and high-risk delivery remains autonomous. High-risk paths retain deterministic classification, proportional validation, exact-head binding, protected merge, and complete check-rollup enforcement. The custom independent model reviewer is removed because it repeats reasoning already performed by the Codex session that implements and validates the change.

The stable branch-required context remains named `Autonomous review complete` for branch-protection compatibility, but it is now a deterministic governance aggregate. The trusted default-branch controller publishes it only after free exact-head CI, Policy Check, and CodeQL aggregates pass; workflow permissions and immutable workflow hashes validate; pull-request eligibility and head identity remain current; and applicable protected-main agent-learning evidence verification succeeds. The controller never exposes `OPENAI_API_KEY`, counts provider tokens, creates a paid-call claim, or invokes a model.

The controller continues to execute only immutable trusted code under `pull_request_target`, never executes candidate code with write credentials, limits `checks: write` to the eligibility resolver and aggregate publisher, rejects alternate GitHub credentials and dynamic secret access, verifies expected GitHub App identity, evaluates every latest exact-head check and legacy status at the final boundary, and squash-merges only the verified head.

## Consequences

Repository delivery no longer spends OpenAI API credits on PR review or blocks on provider capacity. Codex performs implementation review and validation within the active ChatGPT-authenticated session; GitHub protection relies on executable tests, scanners, policy, workflow integrity, program-evidence verification, exact-head provenance, and complete-rollup enforcement rather than a second pass by the same model family.

The repository `OPENAI_API_KEY` remains available only to deployed repairable-error classification. It must not be injected into repository governance, general task evaluation, or pull-request automation.
