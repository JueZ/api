<!-- project-memory-asOf: 2026-08-10 -->
# Next steps

- Before enabling Bring in test, complete the reviewed private/session migration and verify the dedicated read-only canary identity and target list.
- Reduce the Angular initial bundle before the current warning becomes a release constraint.
- Add token-safe authenticated MCP provider smoke only if live MCP execution needs to become a deployment gate; existing authenticated REST smoke and deterministic MCP authorization tests remain active.
- Treat the first genuine post-cutover delivery, deployment, security, auth, data-integrity, idempotency, recurring-fingerprint, or multi-attempt failure as the next closed-loop learning candidate. Do not manufacture incidents or create evidence-only PRs.
- Leave obsolete zero-job Actions remnants untouched unless GitHub exposes a safe supported cleanup operation.
