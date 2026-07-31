# GitHub automation scope instructions

- Execute PR code only in unprivileged PR workflows. `pull_request_target` may run only trusted default-branch controller code.
- Bind review, checks, artifacts, and merge to the exact PR head SHA and expected GitHub App.
- Pin third-party actions to full commit SHAs and keep Dependabot coverage.
- Preserve CodeQL, lint, tests, secret/security/dependency scans, lockfile policy, architecture/evals, policy, and aggregate checks.
- Build release artifacts once and promote identical digests through test and production.
- Use explicit workflow dispatch for delivery chaining; avoid recursive trigger assumptions.
- Production and rollback share concurrency and must fail closed on runtime, auth smoke, telemetry, or provenance failures.
