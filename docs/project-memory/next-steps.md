# Next steps

## Quality 10 program

- Parent issue [#316](https://github.com/JueZ/api/issues/316) tracks the resumable program; `docs/quality/quality-10-program.md` is authoritative.
- Phase 0 is in progress on `codex/quality-10-phase-0`: archive a deterministic protected-main/local baseline, mandatory gates, and an empty waiver registry. After terminal PR evidence is recorded, the next implementation slice is Phase 1 fail-closed runtime environment and explicit local-development bypass security.
- Do not report a category as 10/10 from the supplied static score or from local checks alone. The deterministic report currently fails incomplete gates by design.

## Current delivery boundary

- Main CI `30710606677`, Deploy Test `30710685029`, and Promote Production `30715766542` accepted exact release `3810259823ce0694623a306eb5b390c2781d4b68`. Live production health and frontend metadata report that SHA and production run.
- The one existing production smoke federation record was repaired in place under explicit operator authorization. Keep the exact repository/environment/`deploy-environment.yml` subject and the minimal `catalogue.read`/`reddit.read` roles; do not create an alternate or broader trust route.
- `DEPLOY_PRODUCTION_ENABLED=true` remains intentionally configured. Codex Auto-Merge, Codex Main Delivery, Deploy Test, Promote Production, and Rollback Production remain disabled between bounded delivery windows. Any later runtime-affecting main commit requires fresh exact-main CI, accepted Deploy Test provenance, and the complete production promotion gates.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Superseded PR #285 is closed and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Monitor the accepted production release and use the preserved run `30715766542` ledger/bundle as rollback evidence if a later incident requires `rollback-production.yml`.
2. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes. The deployed server, all 14 tools, and deterministic protected-tool REC are already independently verified without a provider call.
3. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
4. Leave orphaned zero-job runs `30663819848` and `30693764586` documented unless GitHub later permits deletion; cancel/force-cancel/delete attempts already failed. Superseded PRs #285 and #288 are cleaned up; retain accepted deployment and review evidence.
5. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
6. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's `$0.31` control is per reviewed exact head and is not a monthly billing cap.
7. After `CODEX_SECURITY_API_KEY` is configured with Codex Security access, review approximately 10–20 advisory PR scans and measure estimated cost, runtime, coverage completeness, and false positives. Then consider `--fail-on-severity high`, a `gpt-5.6-terra --effort high` low-risk lane, and a separate scheduled or manually dispatched deep repository scan.
