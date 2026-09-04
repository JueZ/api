# Codex instruction migration: Sol to Astra

This repository migration changes agent guidance, not the application model or API. Select `gpt-6-astra` in the Codex session; no repository model pin or personal/plugin configuration change is required. Keep the effective reasoning effort for the first trial; if it was `none` or `minimal`, start with `low`. The separately approved runtime diagnostic model remains unchanged.

## Official guidance

OpenAI recommends auditing skills and instruction files because Astra is more sensitive to conflicting guidance. It also recommends calibrating autonomy, delegation, writing style, and testing to the workflow. It does not recommend deleting all project instructions. Codex guidance recommends a small AGENTS.md and on-demand skill references.

- [Astra prompting and migration](https://developers.openai.com/api/docs/guides/latest-model)
- [Codex customization and skills](https://learn.chatgpt.com/docs/customization/overview)
- [Instruction discovery and fresh sessions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

Sources consulted 2026-09-04. API-only migrations have additional requirements: no `none` reasoning, no custom sampling/logprob parameters, and Responses for tool calling. Those requirements do not authorize changes to this repository's independent runtime analyzer.

## Instruction ownership and audit disposition

| Surface                                        | Decision                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root AGENTS.md                                 | Rebuild around scope, completion, hard safety boundaries, validation, and routing. Preserve native exact-head merge, superseded-generation handling, and bounded repair.                                          |
| API/web scoped instructions                    | Retain domain constraints; make local validation depend on affected behavior.                                                                                                                                     |
| Infrastructure/GitHub/docs scoped instructions | Retain existing domain-specific controls; no change needed.                                                                                                                                                       |
| Autonomous delivery skill                      | Preserve the delivery procedure and repair limits; clarify inherited repair authority and concise evidence reporting.                                                                                             |
| Azure CLI and diagnostics skills               | Keep safety and authorization at the entrypoint; move conditional command recipes into linked references. Remove the local production-deployment exception, raw log-tail recipe, and retired memory-log guidance. |
| Closed-loop learning                           | Clarify that untrusted records cannot apply changes automatically; an authorized agent can implement an evidence-backed protected repair. Preserve promotion criteria and executable prevention.                  |
| GitHub, rollback, memory skills                | Retain their focused procedures, ambiguity stops, and evidence requirements.                                                                                                                                      |
| Semantic falsification                         | Retain the newer protected-main skill and its independent outcome critic; do not remove it because it postdates the migration plan.                                                                               |
| Architecture and setup documentation           | Correct removed controller/model-review references and current Bring MCP capabilities. Label historical setup/review material and distinguish application prompts from operating instructions.                    |
| Learning, historical evals, and ADRs           | Preserve provenance, prevention references, historical baselines, and accepted decisions. Do not rewrite deployment status without live evidence.                                                                 |

Root/scoped instructions define persistent obligations. Skills own procedures. References provide conditional recipes. Project memory records current durable facts and uncertainty; it is not a workflow log. Historical documents and the Reddit application prompt are not operating instructions. Personal instructions and installed plugins are outside this migration and can still influence behavior.

The small fixed merge example and existing safety wording remain compatible with current instruction checks and historical scorers. No scorer, protected policy, workflow, application contract, credential, or runtime behavior changes are part of this migration. Agent instruction paths still receive their protected privileged validation; runtime applicability is independently classified.

## Validation and manual trial

Offline validation covers skill metadata/references, formatting, context budgets, native merge/semantic-falsification policy, learning consistency, operation-document drift, and the existing historical evaluation definitions/harness. These checks establish structural consistency, not an improvement in model behavior. Real model evaluation runs are not part of this migration.

Start a fresh Astra session so the new instruction chain is loaded. During explicitly requested work, check:

1. Planning/review remains read-only and does not open a PR.
2. A small implementation runs proportional checks and continues through protected delivery without redundant approval.
3. Ordinary delivery failure is diagnosed and repaired under the original authorization; unrelated work or new privileges are not silently added.
4. Ambiguous known-good rollback identity stops production mutation and produces an accurate blocker report.
5. A superseded delivery follows the newer main generation containing the requested change.
6. Scoped work reads relevant guidance, and independent delegated work has distinct ownership with one delivery owner.
7. Reports distinguish local checks, merge, deployment, and observed runtime; unavailable evidence is not reported as passing.

Use existing evidence or hypothetical review scenarios for failure cases; do not manufacture production incidents. Record a concrete regression only when observed. Do not claim these manual trials passed based on static checks. If the revised guidance causes a demonstrated regression, repair or revert it through the protected PR path while retaining all safety requirements.
