# Next steps

## Current delivery boundary

- Deploy Test `30699788985` accepted `d359035b1fda01a00b90a4e892399526b6c2a03c`, including complete configuration, authenticated smoke, telemetry, ledger, and provenance. Documentation merge `b7bc4b5c8fa7111f711dac09ecf670f5d30ff881` subsequently advanced `main`, so that evidence is not exact-current-main promotion provenance.
- The operator explicitly authorized `DEPLOY_PRODUCTION_ENABLED=true`, but did not request a production deployment. `Promote Production`, `Rollback Production`, and `Codex Main Delivery` remain disabled between bounded delivery windows; do not infer production acceptance or dispatch authority from the enabled latch.
- Production attempt `30700059811` passed configuration validation but failed Azure OIDC before mutation because the exact workflow-bound production subject has no matching existing federated identity credential. Do not create an alternate or broader trust route. Issues #292 and #294 remain open with the failed-run evidence.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Superseded PR #285 is closed and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Keep production workflows disabled until a separately controlled release window. Run and accept Deploy Test for the exact current `main` after the memory reconciliation lands.
2. Only with separate operator authorization, have a privileged Entra operator repair or verify the existing production federated credential for the exact workflow-bound subject. Do not create a broader or alternate trust route. Verify the existing production smoke-client identity at the same time.
3. Migrate and digest-check the WLH reference blob in the new production private storage before a production application mutation can proceed. Then require production authenticated smoke, telemetry, ledger/runtime truth, and rollback-bundle verification.
4. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
5. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes. The deployed server, all 14 tools, and deterministic protected-tool REC are already independently verified without a provider call.
6. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
7. Leave orphaned zero-job runs `30663819848` and `30693764586` documented unless GitHub later permits deletion; cancel/force-cancel/delete attempts already failed. Superseded PRs #285 and #288 are cleaned up; retain accepted deployment and review evidence.
8. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
9. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's `$0.31` control is per reviewed exact head and is not a monthly billing cap.
