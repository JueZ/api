# GitHub automation scope instructions

- Execute PR code only in unprivileged PR workflows. `pull_request_target` may run only trusted default-branch controller code.
- Bind governance evidence, checks, artifacts, and merge to the exact PR head SHA and expected GitHub App.
- Pin third-party actions to full commit SHAs and keep Dependabot coverage.
- Preserve CodeQL, lint, tests, secret/security/dependency scans, lockfile policy, architecture/evals, policy, and aggregate checks.
- Run learning-artifact validation and generated-index checking by fixed trusted script paths inside the existing architecture/agent job; do not create a separate protected context or route these checks through mutable package aliases.
- Run agent-task schema validation, trusted scorer tests, and fake-adapter worktree/timeout/cleanup tests by fixed paths in the same architecture/agent job. Never run a real paid agent in required CI.
- Keep every mandatory validation as an internal job while exposing only `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete` as stable protected-branch contexts.
- Treat `Autonomous review complete` as the stable legacy aggregate name. Publish it successfully only when deterministic exact-head governance and any applicable protected-main program-evidence verification both pass; do not invoke a model, expose `OPENAI_API_KEY`, defer the evidence decision only to the later merge job, or add another context.
- Aggregate jobs must run with `if: always()`, explicitly depend on all applicable internal jobs, and fail for every result other than success. The only exception is exact-main validation reuse: after full PR validation, `CI complete` may accept explicitly skipped full-validation jobs only when the protected verifier authenticates the exact governance run, merged PR, complete runtime-neutral file list, and identical PR-head/main tree. A missing or mismatched proof fails closed. Do not include a PR-inapplicable main-only job in a PR aggregate.
- Build release artifacts once and promote identical digests through test and production.
- Keep exact-main CI mandatory. After full exact-head PR validation, protected Main Delivery may reuse those results only when it reauthenticates the successful governance artifact, merged PR identity, complete runtime-neutral file list, and identical Git tree. The same runtime-neutral classification may skip environment deployment. Documentation, scoped instructions, agent-task definitions, and dedicated non-shipped agent-learning/evaluation code may be allowlisted; workflow, policy, package, application, contract, infrastructure, ambiguous, and mixed changes retain full exact-main validation and deployment.
- Use explicit workflow dispatch for delivery chaining; avoid recursive trigger assumptions.
- Production and rollback share concurrency and must fail closed on runtime, auth smoke, telemetry, or provenance failures.
