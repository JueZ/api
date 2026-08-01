# Next steps

## Current delivery boundary

- Deploy Test `30710196812` accepted exact main `99289ab26cdb34eb42d59c2ca4f583fc997c1de6`, including complete configuration, authenticated smoke, telemetry, ledger, and provenance. The ARM deployment-name repair advances `main`, so it requires new exact-current-main CI and Deploy Test evidence before production preparation or promotion.
- The operator explicitly authorized `DEPLOY_PRODUCTION_ENABLED=true` and subsequently authorized only bounded production private-storage preparation/migration without application deployment. `Promote Production`, `Rollback Production`, and `Codex Main Delivery` remain disabled between bounded delivery windows; do not infer application deployment authority from the enabled latch or storage preparation.
- Production attempt `30700059811` previously failed Azure OIDC before mutation. The operator reports updating the one existing production federated credential in place to the exact workflow-bound subject; the bounded preparation job's Azure login is the live proof. Do not create an alternate or broader trust route. Issues #292 and #294 retain the failed-run evidence until replacement operational evidence exists.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Superseded PR #285 is closed and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Merge the bounded ARM preview/create deployment-name isolation repair through protected CI/policy/review, then run and accept Deploy Test for that exact current `main`.
2. Pin the accepted exact-main evidence in `PREP_CI_RUN_ID`, `PREP_CI_CORRELATION`, `PREP_TEST_RUN_ID`, and `PREP_TEST_CORRELATION`. Enable only `Prepare Production Private Storage` for one first-attempt run. Require its exact OIDC login, storage-only what-if, shared-Bicep deployment, fixed-digest no-overwrite migration, policy/RBAC checks, evidence artifact, and unchanged production runtime identity; disable it again immediately after dispatch.
3. Keep production application workflows disabled after storage preparation. A later separately authorized promotion must still pass production authenticated smoke, telemetry, ledger/runtime truth, and rollback-bundle verification.
4. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
5. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes. The deployed server, all 14 tools, and deterministic protected-tool REC are already independently verified without a provider call.
6. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
7. Leave orphaned zero-job runs `30663819848` and `30693764586` documented unless GitHub later permits deletion; cancel/force-cancel/delete attempts already failed. Superseded PRs #285 and #288 are cleaned up; retain accepted deployment and review evidence.
8. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
9. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's `$0.31` control is per reviewed exact head and is not a monthly billing cap.
