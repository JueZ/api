# Validation matrix

Choose every row touched by the change. Add focused regression tests before broad suites.

| Surface                             | Minimum focused proof                                    | Broader proof before delivery                                                                           |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| API/application                     | `npm run build:api`; affected API test file              | `npm run type-check`; `npm run test:api`; `npm run ops:check-operation-drift`                           |
| Web                                 | affected web test file                                   | `npm run type-check`; `npm run build:web`; `npm run test:web`                                           |
| OpenAPI/operation contract          | Redocly lint for changed spec; affected handler test     | `npm run ops:check-openapi-drift`; `npm run ops:check-operation-drift`; `npm run docs:check-operations` |
| Security/auth/destructive operation | focused denial, scope, replay, and redaction tests       | `npm test`; `npm run ops:policy-guardrails:branch`; independent high-risk review                        |
| Azure/Bicep                         | `az bicep build --file infra/main.bicep --stdout`        | workflow validation; exact-parameter ARM validation/what-if in deployment; test deployment and smoke    |
| GitHub workflow/shell               | affected structural test; `shellcheck` for changed shell | `actionlint -shellcheck=shellcheck`; `npm run ops:policy-guardrails:branch`                             |
| Release/runtime scripts             | focused unit/contract test including failure path        | `npm run test:ops`; release artifact build/verification when relevant                                   |
| Agent skill/governance              | official-compatible skill validation; negative fixture   | `npm run ops:validate-agent-skills`; `npm run eval:agents`; policy checks                               |
| Dependency manifest/lock            | both manifest/lock pairs validated together              | `npm run ops:check-lockfile`; root and Function dependency audits; release build                        |
| Documentation only                  | link/path and command accuracy review                    | formatting check; project-memory consistency review                                                     |

Always run `npm run ops:preflight-change` before commit. Run `npm run lint`, `npm run test:coverage`, and a production build for broad cross-cutting changes.
