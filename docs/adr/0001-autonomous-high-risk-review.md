# ADR 0001: Autonomous high-risk review

- Status: accepted locally; not yet deployed
- Date: 2026-07-30

## Decision

Routine and high-risk delivery remains fully autonomous. High-risk paths require deterministic guardrail classification plus an independent structured AI review on the exact PR head. No human approval is required by policy. Critical or high findings block merge.

The trusted controller runs from the immutable `github.workflow_sha`, never executes PR code under `pull_request_target`, verifies required checks by exact name, SHA, and GitHub App, and merges only the reviewed SHA. Paid review starts only after all free deterministic checks pass. Those checks and the mutable PR state are revalidated both before a permanent paid-call marker is created and immediately before the OpenAI request. Serialized controller runs create one completed neutral marker whose name binds the PR and whose external identity binds repository, PR, and exact head. The marker is never patched or released; any existing marker permanently consumes that head's paid call, even if the request never starts or later fails. Approval is never reused. Repository policy and runtime validation require an explicit top-level permission map in every workflow, calculate effective job permissions, limit `checks: write` to the three approved controller jobs, and reject alternate GitHub credentials in workflow GitHub-auth channels. The repository default remains read-only, but isolation does not rely on an omitted-permission default. The controller retains the approved high-assurance model and high reasoning, but permits only one bounded call under a conservative per-head cost ceiling.

## Consequences

This avoids a standing human bottleneck while adding a second reasoning gate for workflows, infrastructure, auth, Bring, contracts, and agent governance. Oversized reviews fail closed and must reduce review payload without splitting the single bundled MCP server. Bootstrap remains sensitive: the default-branch controller, repository `OPENAI_API_KEY`, required checks, and branch rules must be configured before autonomous merge is safe.
