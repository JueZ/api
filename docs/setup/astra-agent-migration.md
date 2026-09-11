# Astra agent setup

Select `gpt-6-astra` in the Codex session. This setup changes repository guidance; it does not pin a Codex model or change the application's runtime analyzer. Keep the effective reasoning effort for an initial comparison, using `low` if the previous value was `none` or `minimal`.

## Instruction design

The root `AGENTS.md` defines the requested end state, authority, hard boundaries, local validation command, and task-specific routing. It authorizes ordinary implementation decisions through protected delivery without generic planning or approval ceremonies.

| Surface                   | Responsibility                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Root AGENTS.md            | Completion, authorization, protected merge, safety, proportional validation, and bounded delegation                |
| Scoped AGENTS.md          | Non-obvious API, web, infrastructure, GitHub, and documentation constraints                                        |
| Skill descriptions        | Concise triggers that distinguish the skill's task from adjacent work                                              |
| Delivery SKILL.md         | The normal implementation, PR, merge, and applicable runtime verification path                                     |
| Delivery repair reference | Failure diagnosis, retry limits, recovery routing, and resumable repair lineage; load on failure or resumed repair |
| Azure references          | Only the command recipes needed for the current resource or failure                                                |
| Project memory            | Relevant architecture, operational facts, active risks, and next actions                                           |
| Historical examples/evals | Provenance and comparison material, not operating instructions                                                     |

Planning, extra skills, and subagents are choices based on the work. The main thread retains integration and delivery ownership; delegated tasks keep distinct ownership and the cheapest capable model. Substantial semantic changes still require an independent critic and outcome-based evidence.

The existing scoped instructions and rollback state-machine safeguards remain intact. Short, focused skills stay self-contained; adding a reference is useful only when a substantial conditional branch can stop loading during unrelated work.

## Measured instruction size

Compared with protected base `4f71d2fc5796fe77bbd32b2977614dfebfea79b8`, counting whitespace-separated words:

| Surface                           |           Before |          After |
| --------------------------------- | ---------------: | -------------: |
| Root AGENTS.md                    |        746 words |      564 words |
| Delivery SKILL.md                 |        758 words |      392 words |
| Eight skill descriptions combined | 1,355 characters | 890 characters |

The root plus delivery entrypoint is 36% shorter. The repair reference is additional context only when its trigger applies. These are file-size observations, not measured latency, token-usage, or model-quality improvements.

## Scope and safeguards

Exactly `PR Gate` and `Security Gate`, native exact-head squash auto-merge, Delivery v2, immutable artifacts, OIDC, smoke, telemetry, release identity, and bounded recovery remain required where applicable. A superseded delivery follows newer protected main containing the change. Retry budgets and unresolved requirements remain in the deduplicated repair lineage.

Repository files cannot remove global plugin descriptions from the session. Personal Codex configuration and installed plugins, including Superpowers, are outside this change. Their generic process guidance must fit the repository's explicit task authority and cannot add approval phases. No machine-specific disable paths or duplicate framework are added here.

## Verification and adoption

Use `npm run validate:affected -- --plan` to inspect the checks selected for the finished diff, then run the selected set. Existing policy, skill, context-budget, and evaluation-harness checks establish structural consistency; no model evaluations or production incidents are manufactured.

Start a fresh Astra task in this repository to use the revised instruction chain. During normal authorized work, observe whether a small edit uses relevant context and proportional checks, an implementation continues through protected delivery, and planning/review stays read-only. For substantial semantics, confirm that the independent critic tests the original outcome. For actual delivery failures, confirm bounded retries, accurate continuation, and refusal to guess recovery identity.

Report only observed outcomes. A structural check or hypothetical scenario does not prove better model behavior; compare equivalent fresh-session work before claiming a performance gain.

## Official sources

Current OpenAI guidance supports outcome-based autonomy, auditing conflicting instructions, proportional testing, precise skill triggers, and progressive disclosure. It does not justify weakening repository security or verification.

- [GPT-6 Astra prompting and migration](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
- [Skill discovery, descriptions, and progressive disclosure](https://learn.chatgpt.com/docs/build-skills)
- [AGENTS.md instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

Sources checked 2026-09-11. API-only migration requirements do not authorize changing this repository's independent runtime model.
