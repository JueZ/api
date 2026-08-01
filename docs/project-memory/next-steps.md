# Next steps

## Current delivery boundary

- Test release `6cadc861954af706cd752c022b194c742c0aa6fd` is accepted by first-attempt Deploy Test run `30666921988`, including authenticated smoke, telemetry, ledger, and provenance.
- Production deployment is not authorized for this rollout and remains disabled. Do not infer production acceptance from the successful test run.
- The operator deferred credential rotation and an independent trust-root bootstrap. Keep the stronger workflow-bound GitHub OIDC subject; do not restore the legacy broad subject. Open PR #285 remains unmerged and is not the current delivery path.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; deployment verified its managed reference without exposing its value.

## Operational rollout

1. Complete PR #287 repair attempt 1 for authoritative review provenance, repeated free-gate boundaries, restored label evaluation, the read-only pinned test identity verifier, and REC bounds. Push one fully validated head, let free gates pass, and permit only its final bootstrap review.
2. Deploy the merged successor only to test, then require exact `/health`, unauthenticated and authenticated REST smokes, bundled MCP/REC behavior, telemetry correlation, release ledger, provenance, and runtime-truth evidence. Keep `DEPLOY_PRODUCTION_ENABLED=false` and production workflows disabled.
3. Have a privileged Entra operator verify the granular delegated scopes/application roles and exact current test SPA redirect. Keep complete/remove unavailable to service tokens.
4. Add a token-safe authenticated MCP smoke to the deployment workflow if live MCP provider execution must become a formal release gate; retain the existing REST authenticated smokes.
5. Inventory remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and target list are verified; never add a mutation canary.
6. Retry cancellation of orphaned zero-job run `30663819848` through GitHub or support; do not delete the evidence without explicit approval.
7. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
8. Keep production disabled until a later explicit request. Any future promotion must consume the exact accepted test evidence or run a fresh test if main changed, then pass production authenticated smoke, telemetry, ledger/runtime truth, and rollback-bundle verification.
9. Configure an OpenAI project hard spend limit with earlier alerts in the Platform; the repository's $0.31 control is per reviewed exact head and is not a monthly billing cap.
