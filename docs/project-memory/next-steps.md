# Next steps

## Closed-loop agent-learning program

- `docs/agent-learning/program.md` is authoritative. Phase 1 stable branch-protection aggregation is in progress from protected-main baseline `fc22acb824c643a7986900fe70df8b5e09dfb410`.
- Finish the one Phase 1 implementation PR under the existing protection, observe all four aggregate contexts on its exact head, migrate only the live required-check list with strict mode preserved, verify the complete protection read-back, run and close the deterministic negative canary, archive public-safe evidence, and then mark Phase 1 accepted.
- Do not begin Phase 2 artifact-schema work until Phase 1 has terminal PR, live-protection, and canary evidence. A merge alone is not runtime or live-configuration evidence.

## Quality 10 program

- Parent issue [#316](https://github.com/JueZ/api/issues/316) tracks the resumable program; `docs/quality/quality-10-program.md` is authoritative.
- Phase 0 is accepted: PR #317 and its exact CI, policy, review, merge, deployment, smoke, telemetry, and runtime evidence are archived under `docs/quality/evidence/`. The next implementation slice is Phase 1 fail-closed runtime environment and explicit local-development bypass security on `codex/quality-10-phase-1-runtime-security`.
- Future runs resume one incomplete, unblocked slice in one coherent PR. Do not bulk-execute the remaining phases or add their planned required checks before each owning phase makes them stable and green. Normal feature and maintenance work continues between phases.
- Do not report a category as 10/10 from the supplied static score or from local checks alone. The deterministic report currently fails incomplete gates by design.

## Current delivery boundary

- Main Delivery `30746175284`, exact-main CI `30746184730`, Deploy Test `30746252148`, and Promote Production `30746368440` accepted exact release `056c7b4eb1938549d7d901f27d9b47c022f8d8f9` with exact-generation, public/authenticated smoke, telemetry, provenance, release-ledger, and runtime-truth evidence.
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
