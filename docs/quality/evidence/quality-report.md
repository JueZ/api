# Quality 10 gate report

Result: **failed**

Mandatory gates: 7/71 passed.

Categories eligible for 10/10: 0/15.

| Category | Required gates | 10/10 eligible |
| --- | ---: | :---: |
| Architecture and boundaries | 1/4 | no |
| Readability and organization | 0/4 | no |
| Type safety and runtime validation | 0/5 | no |
| API and contract design | 1/5 | no |
| Correctness and resilience | 0/4 | no |
| Security and privacy | 1/5 | no |
| Error handling and diagnostics | 0/4 | no |
| Automated testing | 0/6 | no |
| Frontend implementation | 0/5 | no |
| Performance and scalability | 0/4 | no |
| CI/CD and supply-chain controls | 3/6 | no |
| Observability and operability | 0/5 | no |
| Documentation | 1/5 | no |
| Maintainability and consistency | 0/5 | no |
| Simplicity and proportionality | 0/4 | no |

## Unsatisfied mandatory gates

- **Architecture and boundaries:** `dependency-direction`, `circular-dependencies`, `canonical-operations`
- **Readability and organization:** `implementation-file-size`, `function-size`, `cohesive-frontend-shell`, `named-provider-parsers`
- **Type safety and runtime validation:** `type-aware-eslint`, `no-explicit-any`, `strict-indexed-and-optional-types`, `no-unsafe-double-assertions`, `trusted-boundary-schemas`
- **API and contract design:** `concrete-operation-inputs`, `concrete-operation-outputs`, `operation-drift`, `golden-compatibility`
- **Correctness and resilience:** `bounded-provider-transport`, `retry-classification`, `provider-malformation`, `bring-state-model`
- **Security and privacy:** `fail-closed-runtime`, `auth-invariants`, `critical-findings`, `privacy-redaction`
- **Error handling and diagnostics:** `sanitized-errors`, `provider-classification`, `diagnostic-mutation`, `safe-correlation`
- **Automated testing:** `deterministic-test-suite`, `backend-coverage`, `critical-coverage`, `frontend-coverage`, `mutation-score`, `integration-and-browser`
- **Frontend implementation:** `component-boundaries`, `typed-catalogue`, `browser-flows`, `wcag-aa`, `initial-bundle`
- **Performance and scalability:** `benchmark-regression`, `bounded-resources`, `no-known-quadratic-paths`, `consumption-concurrency`
- **CI/CD and supply-chain controls:** `immutable-actions`, `quality-suite`, `negative-merge-proof`
- **Observability and operability:** `typed-events`, `required-metrics`, `telemetry-correlation`, `authenticated-mcp-smoke`, `slos-and-runbooks`
- **Documentation:** `required-guides`, `markdown-links`, `concise-current-docs`, `final-archive`
- **Maintainability and consistency:** `complexity`, `no-duplicate-policy`, `no-test-hooks`, `dependency-justification`, `production-complexity-trend`
- **Simplicity and proportionality:** `no-unjustified-services`, `bounded-synchronous-design`, `abstraction-value`, `no-migration-scaffolding`
