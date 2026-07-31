# Next steps

## Current delivery boundary

- PR #264 is merged and its exact commit was deployed to test, but runtime acceptance failed on the unauthenticated auth gate after the two permitted deployment repair attempts.
- Do not retry deployment again in the same repair loop. Open a focused repair PR first.
- Production deployment is not authorized for this rollout and remains blocked.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; verify only that deployment wiring and secret references succeed.

## Operational rollout

1. Repair the Azure Functions bootstrap so the deployed package loads `dist/index.js` and executes `assertRuntimeSafety()` before function registration. Add a regression check for the package entry point.
2. Manage Function app settings through an explicit app-settings resource and add deployment verification that proves the effective `AUTH_ENABLED=true` value without exposing settings or secrets.
3. Have a privileged Entra operator verify or configure the granular delegated scopes/application roles and register the exact new test SPA redirect URI. Keep complete/remove unavailable to service tokens.
4. Run the focused repair through exact-head PR CI, Policy Check, CodeQL, and the trusted merge controller.
5. Start a fresh test deployment repair cycle. Require `/health` at the exact SHA, unauthenticated `GET /api/hello` returning `401`, authenticated `GET /api/hello` and `POST /api/reddit/thread` passing, MCP origin/auth checks, telemetry correlation, release ledger, and accepted provenance.
6. Inventory any remaining Bring session/private data before enabling Bring. Enable the GET-only canary only after its dedicated `bring.read` identity and list fingerprint/allowlist are verified; never add a mutation canary.
7. Prove intentionally failing and pending-check PRs cannot merge, and prove a high-risk PR cannot merge when its exact-head independent review fails or is absent.
8. Stop after successful test verification. Production promotion requires a later explicit request for this rollout despite the repository enablement variable.
9. Record the repair PR, CI, test, authenticated smoke, telemetry, artifact-digest, and runtime-truth evidence in project memory.
