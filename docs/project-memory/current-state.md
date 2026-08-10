<!-- project-memory-asOf: 2026-08-10 -->
# Current state

This file contains current operational facts only. Historical phase, incident, and delivery detail remains in the program record, chronological logs, linked PRs/runs, and Git history.

## Repository and protected delivery

- PR #403 established the exact-main validation-reuse implementation baseline at merge `a0ad8c424d82ce5ca83b19ca3c27a68a7ee79ce1`. Its exact head `2d79b28649de8d1375f6c494f5d2f1152d6b9b28` passed CI `31382712566`, Policy Check `31382712609`, CodeQL `31382712573`, and deterministic Codex Auto-Merge `31382712540` with zero repair pushes. Query GitHub for the current protected-main SHA rather than treating this implementation baseline as live state.
- Main Delivery `31382884043` and exact-main CI `31382916620` passed. Because PR #403 changed workflow/policy/controller code, it correctly used full exact-main validation. The explicit operator-authorized marker omitted environment deployment; Deploy Test, Promote Production, smoke, telemetry, and release-ledger/runtime evidence are not applicable to that merge.
- Exact-main runtime-neutral validation reuse requires the trusted first-attempt governance artifact, exact merged PR/head/main identities, the authenticated complete runtime-neutral file list, stable protected main, identical PR-head/squash-merge Git trees, and a dependency-free classifier entrypoint. PR #404's first live canary exposed the missing-runtime-dependency recurrence: Main Delivery `31383919993` failed closed to full CI `31383958260`, which passed, and the run was cancelled before Azure deployment. PR #406 merged the dependency-free classifier and isolated regression as `35d7438155e64d16c28dce6d1365b41d4b8bbd7b`; exact-main CI `31384910775` and Main Delivery `31384871300` passed without environment deployment. Query subsequent runtime-neutral delivery metadata for live reuse evidence rather than copying each observation into memory.
- Live branch protection requires exactly `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete`, all from GitHub Actions, with strict/up-to-date checks, required PRs, admin enforcement, linear history, conversation resolution, force-push denial, and deletion denial preserved.
- `Autonomous review complete` is deterministic and model-free. It retains immutable workflow hashes, exact-head/app identity, high-risk classification, applicable program-evidence verification, complete latest check/status rollup, and exact-head protected merge. No independent model reviewer or PR-governance provider credential exists.

## Runtime

- Test and production public `/health` both report `ok` for deployed commit/source `0a85184c866fbea789b320e9559fe276c072fffa`.
- Test deployment run `31333348155` and production promotion `31333503474` are the latest successful environment runs. That release passed the then-applicable public/authenticated smoke, telemetry, provenance, and ledger gates recorded in the deployment log.
- Later accepted repository-governance and runtime-neutral merges do not change shipped application bytes. A merged PR alone is not deployment or runtime evidence.
- `DEPLOY_PRODUCTION_ENABLED=true` remains intentionally configured. Normal runtime-impacting delivery uses GitHub Actions, Azure OIDC, exact-main CI, Deploy Test, Promote Production, smoke, telemetry, and ledgers. Rollback remains separately authorized.

## Agent learning and evaluation

- All five phases in `docs/agent-learning/program.md` are accepted with strict public-safe evidence. The artifact validator/index, automatic rollout-bounded repair conversion, fake-adapter historical task harness, and memory/status reporting are active.
- Agent Learning Status and Repair Triage are model-free and scheduled weekly on Monday, with manual dispatch retained. Repair triage remains idempotent, cannot flood pre-rollout issues, and cannot close repairs unless explicitly enabled and both operational and learning coverage pass.
- No real or paid historical agent-task evaluation has run. Pass rates remain unavailable rather than passing. Required CI uses only deterministic trusted scorers and the fake adapter.
- Provider inference is restricted to the bounded repairable-error runtime contract. PR governance, maintenance, and required evaluation do not receive `OPENAI_API_KEY` or invoke a model.

## Current operational posture

- Project-memory active files are concise routing documents. Read historical logs only when the task needs them; do not copy terminal workflow narration into active memory.
- Quality 10 is resumable from its authoritative ledger; ordinary maintenance and feature work remain allowed between slices.
- Remaining actionable risks and work are in `known-issues.md` and `next-steps.md`.
