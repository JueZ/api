# Workflow packaging review (2026-05-24)

## Scope and evidence window

Review window: last 30 days of available repository evidence (May 2026).

Evidence sources used (in priority order from task request):
- Recent Codex session evidence available in-repo via project-memory and rollout-oriented logs (`docs/project-memory/*`)
- Existing skills/custom workflow assets under `.agents/skills/*` and `.github/workflows/*`
- Autonomous-delivery and guardrail documentation (`docs/autonomous-delivery.md`, `docs/security/autonomous-guardrails.md`)
- Chronicle: not available in this checkout/session, so no Chronicle-derived candidates were promoted

## Compact shortlist

| Repeated workflow | Supporting evidence (dates) | Frequency / confidence | Recommendation | Why |
|---|---|---:|---|---|
| PR preflight + create/update + status reporting loop | Decision and state logs repeatedly mention missing/repairing remote and explicit PR creation requirements (2026-05-14, 2026-05-17), plus autonomous-delivery docs codifying preflight commands. | High / High | **Create skill** (`autonomous-pr-delivery`) | Repeated, error-prone, strict stopping condition, and directly required for Definition of Done. |
| CI/policy failure repair loop with bounded attempts | Autonomous-delivery and guardrail docs define repeated “inspect logs → smallest safe fix → max 2 attempts” pattern (May 2026). | Medium-High / High | Extend existing (`github-cli-devops`) | Already mostly covered by existing skill and policy docs; no separate asset needed now. |
| Production rollback + post-deploy smoke verification | Existing dedicated skill and deployment/project-memory logs show recurring use (May 2026). | Medium / High | **Skip (already covered)** | Existing `production-rollback` skill already packages this workflow with clear commands and safeguards. |
| Project-memory update after meaningful ops/auth/deploy changes | Repeatedly required in AGENTS + autonomous-delivery docs and already provided by dedicated skill. | High / High | **Skip (already covered)** | Existing `project-memory-maintainer` skill adequately covers procedure and constraints. |
| Scheduled stale repair-issue hygiene | Already implemented via `repair-triage.yml` + `ops:triage-repair-issues` dry-run automation in project memory state. | Medium / High | **Skip (already automated)** | Existing automation is present; avoid duplication. |

## High-confidence missing item created

1. **Created skill:** `.agents/skills/autonomous-pr-delivery/SKILL.md`
   - Narrow scope: mandatory repo-changing delivery loop.
   - Includes explicit preflight recovery commands required by project guardrails.
   - Defines required final-output fields to avoid incomplete autonomous reports.

## Deliberately skipped

- New standalone CI-repair skill: skipped because `github-cli-devops` + guardrail docs already provide sufficient procedure.
- New rollback/deploy skills: skipped because `production-rollback` exists and is current.
- New repair-triage automation: skipped because a workflow and script are already implemented.

## Needs more evidence before packaging

- Personal admin/communication/research workflows outside repo history (Chronicle or external systems not available in this checkout) need corroborated multi-occurrence evidence before creating additional skills/subagents/automations.


## Follow-up refinement (2026-05-24)

- Clarified that the packaged delivery workflow must halt on `main` and always resolve/check a concrete PR number before check queries.
- Added explicit failed-run inspection commands to keep the bounded repair loop evidence-first and consistent with existing GitHub CLI practices.
