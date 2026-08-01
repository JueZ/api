# ADR 0001: Autonomous high-risk review

- Status: accepted locally; not yet deployed
- Date: 2026-07-30

## Decision

Routine and high-risk delivery remains fully autonomous. High-risk paths require deterministic guardrail classification plus an independent structured AI review on the exact PR head. No human approval is required by policy. Critical or high findings block merge.

The trusted controller runs from `main`, never executes PR code under `pull_request_target`, verifies required checks by exact name, SHA, and GitHub App, and merges only the reviewed SHA. Paid review starts only after all free deterministic checks pass. Those checks and the mutable PR state are revalidated at both the durable-claim boundary and immediately before the OpenAI request. Serialized controller runs atomically claim the repository/PR/head tuple through a durable check run. If a free gate changes before the request, the unspent claim is released before failure and can be reacquired only after fresh validation. A completed approval is reusable only when the check creator, pinned workflow ID/path/ref/event, repository, exact head, first-attempt successful source run, unique artifact ID, and artifact SHA-256 digest all match independently queried GitHub evidence. Every other existing claim fails closed without another model request. The controller retains the approved high-assurance model and high reasoning, but permits only one bounded call under a conservative per-head cost ceiling.

## Consequences

This avoids a standing human bottleneck while adding a second reasoning gate for workflows, infrastructure, auth, Bring, contracts, and agent governance. Oversized reviews fail closed and must reduce review payload without splitting the single bundled MCP server. Bootstrap remains sensitive: the default-branch controller, repository `OPENAI_API_KEY`, required checks, and branch rules must be configured before autonomous merge is safe.
