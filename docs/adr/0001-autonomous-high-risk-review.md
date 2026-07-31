# ADR 0001: Autonomous high-risk review

- Status: accepted locally; not yet deployed
- Date: 2026-07-30

## Decision

Routine and high-risk delivery remains fully autonomous. High-risk paths require deterministic guardrail classification plus an independent structured AI review on the exact PR head. No human approval is required by policy. Critical or high findings block merge.

The trusted controller runs from `main`, never executes PR code under `pull_request_target`, verifies required checks by exact name, SHA, and GitHub App, and merges only the reviewed SHA.

## Consequences

This avoids a standing human bottleneck while adding a second reasoning gate for workflows, infrastructure, auth, Bring, contracts, and agent governance. Bootstrap remains sensitive: the default-branch controller, repository `OPENAI_API_KEY`, required checks, and branch rules must be configured before autonomous merge is safe.
