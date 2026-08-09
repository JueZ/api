# GitHub automation scope instructions

- Execute PR code only in unprivileged PR workflows. `pull_request_target` may run only trusted default-branch controller code.
- Bind review, checks, artifacts, and merge to the exact PR head SHA and expected GitHub App.
- Pin third-party actions to full commit SHAs and keep Dependabot coverage.
- Preserve CodeQL, lint, tests, secret/security/dependency scans, lockfile policy, architecture/evals, policy, and aggregate checks.
- Run learning-artifact validation and generated-index checking by fixed trusted script paths inside the existing architecture/agent job; do not create a separate protected context or route these checks through mutable package aliases.
- Keep every mandatory validation as an internal job while exposing only `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete` as stable protected-branch contexts.
- Publish `Autonomous review complete` successfully only when exact-head independent review and any applicable protected-main program-evidence verification both pass; do not defer the evidence decision only to the later merge job or add another context.
- Aggregate jobs must run with `if: always()`, explicitly depend on all applicable internal jobs, and fail for every result other than success; do not include a PR-inapplicable main-only job in a PR aggregate.
- Build release artifacts once and promote identical digests through test and production.
- Use explicit workflow dispatch for delivery chaining; avoid recursive trigger assumptions.
- Production and rollback share concurrency and must fail closed on runtime, auth smoke, telemetry, or provenance failures.
