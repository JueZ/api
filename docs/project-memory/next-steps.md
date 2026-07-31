# Next steps

## Current delivery boundary

- Commit, push, PR, and a test deployment are authorized.
- Production deployment is not authorized for this rollout. Apply `skip-autodeploy`, verify no production promotion starts, and manually dispatch only the exact merged commit to `Deploy Test`.
- Do not change or reveal the shared repository `OPENAI_API_KEY`; verify only that deployment wiring and secret references succeed.

## Operational rollout

1. Commit on the existing non-`main` branch, generate commit-bound release evidence in CI, open a PR, and verify the PR exact-head checks.
2. Bootstrap and verify the trusted autonomous controller, expected GitHub App/check identities, CodeQL, repository `OPENAI_API_KEY`, squash/no-bypass branch rules, and high-risk independent AI review.
3. Create intentionally failing and pending-check test PRs and prove they cannot merge. Prove a high-risk PR cannot merge when its exact-head review fails or is absent.
4. Configure granular Entra delegated scopes/application roles and least-privilege service/GitHub OIDC identities. Keep complete/remove unavailable to service tokens.
5. Inventory and migrate existing WLH/session/private data into split storage with backup, digest validation, access tests, and rollback evidence.
6. Run Azure what-if and deploy test. Verify fail-closed auth/origin, storage/Key Vault/RBAC boundaries, read-only Bring access, authenticated/unauthenticated smokes, telemetry correlation, release ledger, runtime SHA, and exactly one delivery chain.
7. Enable the GET-only Bring canary only after its dedicated `bring.read` identity and list are verified. Never add a mutation canary.
8. Stop after test verification for the current user-authorized rollout. Production promotion requires a later explicit request despite the repository enablement variable.
9. Record PR, CI, test, smoke, telemetry, artifact-digest, and runtime-truth evidence in project memory after rollout.
