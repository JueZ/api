# GitHub automation scope instructions

- Execute PR code only in unprivileged PR workflows. `pull_request_target` may run only trusted default-branch controller code.
- Bind review, checks, artifacts, and merge to the exact PR head SHA and expected GitHub App. Resolve Actions checks to
  the pinned workflow ID/path, event, first attempt, repository, PR/base/head, and exact run/job; bind controller checks
  to their recorded check-run IDs.
- Pin third-party actions to full commit SHAs and keep Dependabot coverage.
- Preserve CodeQL, lint, tests, secret/security/dependency scans, lockfile policy, architecture/evals, policy, and aggregate checks.
- Build release artifacts once and promote identical digests through test and production.
- Use explicit workflow dispatch for delivery chaining; avoid recursive trigger assumptions.
- Production and rollback share concurrency and must fail closed on runtime, auth smoke, telemetry, or provenance failures.
- Changes matching `merge.autonomousExcludedPaths` are trust-root changes and must be rejected by autonomous merge.
- During the credential incident, preserve protected-branch-only deployment environments, exact
  `repo,context,job_workflow_ref` OIDC customization, disabled incident workflows, and the active-only hold. Repository
  comments cannot clear an incident involving GitHub credentials.
