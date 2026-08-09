# Next steps

## Closed-loop agent-learning program

- `docs/agent-learning/program.md` is authoritative. Phase 1 is accepted at implementation merge `da8459aec5756f684b27d692dd838b0135c7fe9f`; live protection and negative-canary evidence is archived under `docs/agent-learning/evidence/`.
- Phase 2 implementation PR #349 merged as `9310c94f97541e57f83b186af2cacf989d6f5330` and completed staged delivery/runtime verification, but the phase remains `in_progress`. Evidence PRs #350 and #352 closed unmerged after exhausting their repair limits; issue #351 records the recurrence.
- Complete trusted-verifier foundation PR #354 on `codex/agent-learning-trusted-verifier` from exact baseline `74f09b72789ad3acc5c2ce82747298b4bd8264be`: keep PR CI tokenless; execute authenticated evidence collection only from protected-main controller code; treat fixed candidate files as data; bind the exact head and review claim; verify artifact bytes/digests; allowlist exact runtime hosts; disable redirects; and retain every existing aggregate, rollup, review, permission, and delivery gate. Do not mark Phase 2 accepted in that foundation PR.
- After the foundation is merged and active, use a separate evidence-only PR to exercise it and record final acceptance. Keep task-evaluation aliases fail closed until Phase 4, add no new protected context, and do not begin Phase 3 or paid/general task execution first. A merged PR alone remains insufficient runtime or live-configuration evidence.

## Quality 10 program

- Parent issue [#316](https://github.com/JueZ/api/issues/316) tracks the resumable program; `docs/quality/quality-10-program.md` is authoritative.
- Phase 0 is accepted: PR #317 and its exact CI, policy, review, merge, deployment, smoke, telemetry, and runtime evidence are archived under `docs/quality/evidence/`. The next implementation slice is Phase 1 fail-closed runtime environment and explicit local-development bypass security on `codex/quality-10-phase-1-runtime-security`.
- Future runs resume one incomplete, unblocked slice in one coherent PR. Do not bulk-execute the remaining phases or add their planned required checks before each owning phase makes them stable and green. Normal feature and maintenance work continues between phases.
- Do not report a category as 10/10 from the supplied static score or from local checks alone. The deterministic report currently fails incomplete gates by design.

## Current delivery boundary

- Main Delivery `31276530181`, exact-main CI `31276543255`, Deploy Test `31276618522`, and Promote Production `31276791354` accepted exact release `da8459aec5756f684b27d692dd838b0135c7fe9f` with exact-generation, public/authenticated smoke, telemetry, provenance, release-ledger, and fresh live-plus-ledger runtime-truth evidence.
- The one existing production smoke federation record was repaired in place under explicit operator authorization. Keep the exact repository/environment/`deploy-environment.yml` subject and the minimal `catalogue.read`/`reddit.read` roles; do not create an alternate or broader trust route.
- `DEPLOY_PRODUCTION_ENABLED=true` remains intentionally configured. Codex Auto-Merge, Codex Main Delivery, Deploy Test, and Promote Production remain active for always-on autonomous delivery overseen by Codex. Any later main commit still requires fresh exact-main CI, accepted Deploy Test provenance, and the complete production promotion gates. Rollback remains a separately requested operation.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Superseded PR #285 is closed and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Monitor the accepted production release and use the preserved run `30746368440` ledger/bundle as rollback evidence if a later incident requires `rollback-production.yml`.
2. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes. The deployed server, all 14 tools, and deterministic protected-tool REC are already independently verified without a provider call.
3. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
4. Leave orphaned zero-job runs `30663819848` and `30693764586` documented unless GitHub later permits deletion; cancel/force-cancel/delete attempts already failed. Superseded PRs #285 and #288 are cleaned up; retain accepted deployment and review evidence.
5. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
6. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's `$0.31` control is per reviewed exact head and is not a monthly billing cap.
