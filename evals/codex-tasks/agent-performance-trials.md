# Advisory agent-performance trials

This procedure records a small, controlled sample of fresh-session agent work. It is advisory research only. It does not change CI, delivery, permissions, model selection, or the existing Codex-task evaluation mechanism.

The historical Codex tasks and deterministic safety cases remain useful for their stated purpose. They reconstruct bounded historical worktrees and use a no-network, no-subagent adapter, so their scores do not measure live provider behavior, production delivery, or comparative agent performance.

## Record format

Validate each local JSON record with Node 22:

```powershell
& "C:\Program Files\nodejs\node.exe" scripts/codex-evals/performance-record.mjs .agent-runtime/agent-performance/<trial>.json
```

The valid synthetic [example](agent-performance-record.example.json) documents the shape only. It intentionally omits model, effort, time, CI/deployment, and token values and is not a trial result.

Each record requires a fixed `sourceRevision`, `comparisonId`, `variant`, `taskType`, `instructionRevision`, validations with an explicit `repeated` flag, `repairAttempts`, and `finalDeliveryOutcome`. `actualModel`, `actualEffort`, active-agent milliseconds, CI/deployment milliseconds, and token counts are optional: omit a value that the session or external system did not report. Do not estimate or derive them.

`activeAgentTimeMs` describes active agent work only. `ciDeploymentTimeMs.ci` and `.deployment` are separate external waits when observed. Neither field represents elapsed wall-clock time for the entire trial. A validation row records whether it was repeated; a repeat should have a concrete reason in the trial notes held outside this minimal record.

## Controlled representative pairs

For every row below, run a baseline and revised trial with the same source revision, task prompt, acceptance criteria, allowed tools, and environment. Use a fresh agent session for each trial. Change only `instructionRevision`; record the actual model and effort only when the session reports them. A blocked case is a valid result and must not be retried with broader permission.

| `taskType`                | Representative request                                | Required comparison condition                                                                                                                                   |
| ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordinary_feature`        | A bounded ordinary feature change                     | Same acceptance test and source revision                                                                                                                        |
| `small_fix`               | A focused defect repair                               | Same reproduction and regression check                                                                                                                          |
| `provider_shape_mismatch` | Diagnose or repair a provider payload shape mismatch  | Same sanitized fixture or provider contract; do not call a paid provider                                                                                        |
| `permissions_blocker`     | Reach the point where a required permission is absent | Same least-privilege identity; preserve `blocked_permissions` when blocked                                                                                      |
| `superseded_deployment`   | Follow a delivery generation that becomes superseded  | Same requested change and current-main containment check; preserve `superseded_following_current_main` until the replacement generation reaches its own outcome |

Do not force a target delivery result for ordinary features or small fixes. `finalDeliveryOutcome` records the state actually reached: local validation, protected merge, runtime-neutral completion, runtime verification, a permissions block, supersession being followed, or incomplete work. Existing protected checks and Delivery v2 remain the authority for those states.

Compare paired records descriptively: completion state, validation outcome, repeated validations, repairs, and only the metrics reported by the respective sessions. Keep unavailable values absent on both sides rather than replacing them with zero. A small controlled sample can reveal a follow-up question; it cannot prove that Astra, a model, an effort level, or an instruction revision improved performance.
