# Closed-loop agent-learning program

As of 2026-08-08, this document is the authoritative, resumable ledger for the JueZ/api agent-learning program.

## Objective

Build a production-grade closed loop that evaluates broad repository tasks and agent behavior, converts significant failures into structured learning candidates, turns approved candidates into versioned verifiable artifacts, evaluates historical tasks end to end, measures the effect of repository instructions and skills, and reports memory freshness without weakening any existing security, CI, delivery, authentication, authorization, provenance, smoke, telemetry, audit, idempotency, or production control.

Accepted phase statuses are `not_started`, `in_progress`, `accepted`, `blocked`, and `superseded`.

## Evidence rules

- Local checks, exact-head PR checks, merge, deployment, smoke, telemetry, release-ledger validation, runtime truth, and live repository configuration are separate evidence classes.
- A merged PR alone is not runtime evidence and is not proof that a live GitHub or Azure setting changed.
- Every accepted reference must identify the exact 40-character commit and the relevant PR, workflow run, artifact, or live read-back.
- Unavailable evidence is `blocked` or pending; it is never counted as passing.
- Evidence stored under `docs/agent-learning/evidence/` must be public-safe and exclude tokens, headers, credentials, connection strings, SAS URLs, provider data, and unrelated settings.

## Program status

| Phase | Scope                                              | Status        | PR and exact commit references                                                                                   | Accepted evidence                                                                                                                                                                                                                                             | Remaining risk                                                                                                                       |
| ----- | -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Stable branch-protection aggregation               | `in_progress` | Implementation PR and merge commit pending. Protected-main baseline: `fc22acb824c643a7986900fe70df8b5e09dfb410`. | Live pre-change inspection found strict classic protection with 23 required GitHub Actions contexts spanning individual jobs and existing aggregates. Repository implementation, remote gates, live migration, read-back, and negative canary remain pending. | The live required-check surface remains brittle until the implementation merges and the protection endpoint is changed and verified. |
| 2     | Versioned learning artifacts and closed-loop skill | `not_started` | None.                                                                                                            | None.                                                                                                                                                                                                                                                         | No validated artifact schema, generated index, or curated historical artifacts yet.                                                  |
| 3     | Automatic failure-to-learning conversion           | `not_started` | None.                                                                                                            | None.                                                                                                                                                                                                                                                         | Significant failures do not yet create deduplicated learning candidates automatically.                                               |
| 4     | General historical agent-task evaluation harness   | `not_started` | None.                                                                                                            | None.                                                                                                                                                                                                                                                         | No detached-worktree adapter/scorer harness or context-variant comparison yet.                                                       |
| 5     | Memory freshness and day-to-day reporting          | `not_started` | None.                                                                                                            | None.                                                                                                                                                                                                                                                         | No deterministic freshness report or scheduled closed-loop status summary yet.                                                       |

## Phase 1 acceptance boundary

Phase 1 is accepted only after all of the following are true:

1. `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete` succeed on the exact implementation PR head under the pre-existing branch protection.
2. The implementation reaches protected main with terminal exact-main delivery evidence.
3. Live branch protection is read, only its required-check list is changed to those four GitHub Actions contexts, strict mode is preserved, and the complete protection state is read back.
4. A temporary low-risk canary deterministically fails one harmless internal CI job, causes `CI complete` to fail, remains blocked and unmerged, makes no paid autonomous-review call, and is closed with its branch deleted.
5. Public-safe before/after and canary evidence is archived at `docs/agent-learning/evidence/branch-protection-aggregation.json` through a protected PR.

## Next exact slice

Finish the Phase 1 implementation PR on `codex/agent-learning-phase-1-aggregation`: validate every aggregate dependency and controller regression locally, pass the existing old protection and old main controller, observe all four aggregate checks on the exact head, and monitor protected merge plus the complete post-merge delivery chain. Do not change live protection or start the canary until that exact-head evidence exists on protected main.
