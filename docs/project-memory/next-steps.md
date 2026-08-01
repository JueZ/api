# Next steps

## Current delivery boundary

- Test release `5d9e3cc87ed0f8e18e70544b6b1587ae2ddcf56c` is accepted by first-attempt Deploy Test run `30695340416`, including authenticated smoke, telemetry, ledger, provenance, and independent live bundled-MCP/REC verification.
- Production deployment is not authorized for this rollout and remains disabled. Do not infer production acceptance from the successful test run.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Superseded PR #285 is closed and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Keep production disabled until a later explicit request. Any future promotion must consume the exact accepted test evidence or run a fresh test if main changed, then pass production authenticated smoke, telemetry, ledger/runtime truth, and rollback-bundle verification.
2. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
3. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes. The deployed server, all 14 tools, and deterministic protected-tool REC are already independently verified without a provider call.
4. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
5. Leave orphaned zero-job runs `30663819848` and `30693764586` documented unless GitHub later permits deletion; cancel/force-cancel/delete attempts already failed. Superseded PRs #285 and #288 are cleaned up; retain accepted deployment and review evidence.
6. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
7. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's `$0.31` control is per reviewed exact head and is not a monthly billing cap.
