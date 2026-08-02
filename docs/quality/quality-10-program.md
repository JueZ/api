# JueZ/api Quality 10 engineering program

Parent tracking issue: [#316](https://github.com/JueZ/api/issues/316)

This is a multi-PR engineering program. The repository ledger is authoritative; the issue is only a checklist and link hub. A category reaches 10/10 only when every mandatory gate in `quality-gates.yml` passes with present evidence and no active waiver substitutes for a failure.

## Original assessment

The supplied static assessment used protected-main commit `56f4208070ad5777267326f5e2d70e43dd64073c`.

| Category                           | Original score |
| ---------------------------------- | -------------: |
| Architecture and boundaries        |            8.7 |
| Readability and organization       |            7.8 |
| Type safety and runtime validation |            7.6 |
| API and contract design            |            8.8 |
| Correctness and resilience         |            8.8 |
| Security and privacy               |            9.2 |
| Error handling and diagnostics     |            9.1 |
| Automated testing                  |            8.7 |
| Frontend implementation            |            7.3 |
| Performance and scalability        |            7.4 |
| CI/CD and supply-chain controls    |            9.6 |
| Observability and operability      |            9.1 |
| Documentation                      |            8.8 |
| Maintainability and consistency    |            7.9 |
| Simplicity and proportionality     |            6.9 |
| **Overall**                        |        **8.5** |

## Current measured baseline

Protected `main` was inspected on 2026-08-02 and still pointed to the assessment commit `56f4208070ad5777267326f5e2d70e43dd64073c`. PR #314, exact-head CI, Policy Check, CodeQL, independent review, auto-merge, main CI, Deploy Test, Promote Production, smoke, telemetry, and runtime truth all completed successfully for that lineage. Exact references are archived in `evidence/protected-main-56f420.json`.

The reproducible local collector recorded:

- 68 production TypeScript files and 13,503 logical lines.
- Largest modules: `apps/api/src/mcp/server.ts` (1,905 logical lines), `apps/api/src/shared/reddit/service.ts` (994), `apps/web/src/main.ts` (706), `apps/api/src/shared/security/auth.ts` (592), and `apps/api/src/application/operations/bring/mutations.ts` (572).
- Largest function: `createPrivateMcpServer` at 310 logical lines; nine other measured functions exceed 95 logical lines.
- 16 explicit `any` occurrences in production source, concentrated mainly in the Willhaben integration.
- 3 unsafe `as unknown as` assertions.
- TypeScript `strict` and unknown catch variables are effective; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are not enabled.
- ESLint is not type-aware, disables the production `no-explicit-any` rule, and therefore has a global production exemption.
- 21 canonical operations: 20 have unknown input schemas and all 21 have unknown output schemas in the registry.
- 22 test files, 298 statically declared cases, and 294 executed passing tests on the exact protected-main worktree. Coverage, maintained mutation, browser E2E, accessibility, and benchmark commands are absent.
- The production Angular build passes with 539,123 bytes across built JavaScript files and a measured 542.77 kB initial bundle against a 500 kB warning and 1 MB error budget.
- Architecture, OpenAPI drift, operation drift, generated operation docs, policy guardrails, the complete test suite, web build, and local dependency audit passed during baseline collection.
- Trivy, Gitleaks, dependency audit, and CodeQL are configured; their protected-main results are separately linked as CI evidence.
- The known operational gaps remain the merge-protection negative proof, authenticated live MCP provider smoke, private Bring migration/read acceptance, the bundle warning, two orphaned zero-job runs, and documented Reddit upstream limits.

The first deterministic gate report passes 7 of 71 mandatory gates and reports 0 of 15 categories eligible for 10/10. The supplied numerical assessment remains the only scorecard; Phase 0 does not rescore categories or infer quality from gate absence.

## Ordered phases

| Phase                                                                | Status      | Scope                                                                                                     | PR and commit                                        | Accepted evidence                                         | Remaining risk                                                                                                         |
| -------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0 — Reproducible baseline and quality evidence                       | in_progress | Ledger, gates, waiver registry, deterministic collector/report, protected-main and local baseline archive | Branch `codex/quality-10-phase-0`; PR/commit pending | Local Phase 0 evidence only; terminal PR evidence pending | The report correctly fails 64 mandatory gates; Phase 0 is not accepted until exact-head delivery evidence is archived. |
| 1 — Fail-closed runtime and local-development security               | not_started | Explicit invalid environment, explicit local bypass, startup rejection, threat model, negative tests      | —                                                    | —                                                         | Current permissive unknown/local behavior remains the first high-risk implementation target.                           |
| 2 — Complete type safety and trusted boundaries                      | not_started | Type-aware lint, strict compiler flags, provider/persistence/frontend schemas in provider-sized slices    | —                                                    | —                                                         | Willhaben has the largest explicit-any and trust gap.                                                                  |
| 3 — Executable operation contracts and transport convergence         | not_started | Canonical typed operation schemas, REST/MCP/OpenAPI/frontend convergence, golden compatibility            | —                                                    | —                                                         | Registry contains 20 unknown inputs and 21 unknown outputs.                                                            |
| 4 — Provider resilience and correctness                              | not_started | Bounded shared transport and provider-specific retry, parsing, concurrency, and state guarantees          | —                                                    | —                                                         | Provider hardening evidence is incomplete.                                                                             |
| 5 — Architecture, readability, maintainability, and simplicity       | not_started | Cohesive decomposition and size/complexity/dependency gates                                               | —                                                    | —                                                         | Several production modules and functions materially exceed the targets.                                                |
| 6 — Testing quality                                                  | not_started | Coverage, mutation, property/model, storage integration, browser, accessibility, and flake gates          | —                                                    | —                                                         | Coverage and runtime browser/accessibility evidence is absent.                                                         |
| 7 — Frontend quality, accessibility, and bundle discipline           | not_started | Component/service decomposition, generated contract input, WCAG 2.2 AA, bundle reduction                  | —                                                    | —                                                         | Initial JS is 539,123 bytes and the current error budget is 1 MB.                                                      |
| 8 — Performance, scalability, observability, and SLOs                | not_started | Benchmarks, bounded transformations, typed events/metrics, SLOs/runbooks, authenticated MCP smoke         | —                                                    | —                                                         | Benchmark and explicit MCP/observability evidence is absent.                                                           |
| 9 — CI/CD completion, documentation consolidation, and final archive | not_started | Stable quality gates in CI, protection negative proof, docs consolidation, final assessment and closure   | —                                                    | —                                                         | New gates must not become required until stable and green.                                                             |

Allowed phase states are `not_started`, `in_progress`, `accepted`, `blocked`, and `superseded`. Accepted status requires exact evidence; a merged PR alone is insufficient.

## Phase 0 evidence

- Local baseline: `docs/quality/evidence/phase-0-baseline.json`.
- Protected-main/GitHub/runtime references: `docs/quality/evidence/protected-main-56f420.json`.
- Deterministic gate result: `docs/quality/evidence/quality-report.json` and `.md`.
- Baseline local commands: architecture, OpenAPI drift, operation drift, generated operation docs, policy guardrails, full tests, production web build, and dependency audit all passed. Exact command names and statuses are recorded in the baseline JSON.
- Phase 0 PR CI, policy, autonomous review, auto-merge, main CI, deployment, smoke, telemetry, and runtime evidence: pending.

## Current risks and constraints

- No category is 10/10; 64 mandatory gates are unsatisfied.
- The explicit TypeScript, operation-schema, module-size, testing, accessibility, mutation, benchmark, and bundle gaps above are measured rather than waived.
- `waivers.yml` is empty.
- Open PR #315 adds a separate advisory Codex Security scan and does not implement or supersede this phase. Its missing credential/entitlement is not treated as successful evidence.
- `DEPLOY_PRODUCTION_ENABLED=true` is operator-configured, while Codex Auto-Merge, Codex Main Delivery, Deploy Test, Promote Production, and Rollback Production were disabled at inspection time. This program does not change that variable or weaken any delivery control.

## Next exact phase or slice

First archive terminal Phase 0 PR, CI, policy, autonomous-review, merge, main-delivery, deployment, smoke, telemetry, and runtime-truth evidence without relabelling unavailable checks. Then begin **Phase 1 — fail-closed runtime environment and explicit local-bypass slice** on `codex/quality-10-phase-1-runtime-security`, including the complete negative environment matrix, startup rejection, threat-model update, and full high-risk security/policy gates.
