---
name: change-quality-gate
description: Use before and during every repository-changing task in JueZ/api to define the behavior, risk, regression tests, documentation, validation, and delivery evidence required for a safe change.
---

# Change Quality Gate

Use this skill before implementation, and again before handoff to `autonomous-pr-delivery`.

## 1. Establish the change contract

1. Read the root and nearest scoped `AGENTS.md` files.
2. Read `docs/project-memory/current-state.md` plus the relevant architecture, security, operations, or delivery document.
3. State the intended observable behavior and the behavior that must remain unchanged.
4. Classify affected surfaces: API, web, contract, security, data, Azure infrastructure, workflow, operations, agent governance, or documentation.
5. Identify failure modes, rollback constraints, secret boundaries, and cost impact before editing.

## 2. Plan proof before implementation

- A bug fix needs a regression test that fails for the defect and passes for the fix.
- A behavior change needs positive, negative, boundary, authorization, and failure-path tests appropriate to its risk.
- Contract changes need implementation, OpenAPI, generated documentation, and drift checks updated together.
- Azure or workflow changes need compile/lint checks plus structural or behavioral tests for the changed guardrail.
- Agent-governance changes need validator tests and a representative forward-eval or deterministic contract test.
- Formatting-only or comment-only changes may omit new tests, but record why behavior is unaffected.

Read [references/validation-matrix.md](references/validation-matrix.md) and select the smallest sufficient validation set. A skipped or unavailable check is a limitation, never a pass.

## 3. Preserve durable knowledge

Update the closest canonical document when behavior, contracts, operations, security, deployment, or troubleshooting changes. Use `project-memory-maintainer` for durable decisions, incidents, deployment state, known issues, and next steps. Supersede stale statements instead of layering contradictory notes.

Never store credentials, tokens, connection strings, SAS URLs, raw settings, or sensitive logs in documentation or project memory.

## 4. Implement and review

1. Keep the patch scoped and reversible.
2. Prefer fail-closed validation at the boundary where invalid state enters the system.
3. Run focused tests while editing, then the selected validation matrix.
4. Review the final diff for accidental files, secret-bearing paths, missing generated artifacts, weakened gates, and undocumented behavior.
5. Run `npm run ops:preflight-change` before commit and the branch policy check before push.

If a meaningful behavior change has no practical automated test, stop and document the exact reason, compensating evidence, and residual risk in the PR. Do not silently treat manual inspection as regression coverage.

## 5. Hand off to delivery

Use `autonomous-pr-delivery` only after the change contract is satisfied. The PR description must record:

- behavior and risk;
- test and validation evidence;
- documentation and project-memory impact;
- deployment and rollback impact;
- skipped checks, blockers, and residual risks.

Completion means the relevant CI, policy, deployment, smoke, telemetry, and runtime-truth gates reached a successful terminal state, or a concrete external blocker is reported accurately.
