---
name: semantic-falsification
description: Use for substantial behavior changes to test whether implementation success actually proves the requested user-visible outcome.
---

# Semantic falsification

Apply this lightweight phase to a new or materially changed API/tool, provider integration, pagination or completeness
rule, state mutation, deployment/runtime behavior, business-semantic refactor, or externally meaningful terminal status.
Do not invoke it for typo, formatting, mechanical dependency, or behavior-neutral refactor work unless the diff reveals
one of those semantic risks.

## Before implementation is finished

1. Restate the original user-visible outcome without translating it into the current design.
2. Derive 3–8 falsifiable correctness invariants. Keep mechanism invariants (queue persistence, retry, deduplication)
   distinct from outcome invariants (coverage, state change, intended runtime behavior).
3. List only material external assumptions whose falsity could invalidate the outcome. Treat undocumented provider
   behavior as uncertainty, not a guarantee.
4. Add mechanism tests as needed, then add at least one semantic contract test at a provider/service boundary. A key
   contract test should remain meaningful under a different implementation and should fail if the central semantic
   assumption is wrong.

For difficult provider semantics, prefer a minimized, sanitized, immutable provider-derived fixture in the affected
test fixture tree. Remove credentials, tokens, unnecessary PII, and arbitrary bulk data; document provenance without
claiming a sanitized fixture is live-provider verification. Fixtures supplement mocks rather than replacing them.

## Independent critic

After implementation, start from the original outcome, invariants, diff, tests, and authoritative provider contract—not
the implementer's defense. Assume the design is subtly wrong and construct at least one realistic scenario in which all
current tests pass but the requested outcome does not. Focus on completeness claims, terminal-state logic, hidden source
limits, pagination/continuations, stale snapshots, mutations acknowledged without state change, and deployment without
runtime identity/behavior proof. Convert a credible testable scenario into an executable regression; otherwise record
the scoped assumption and truthful limitation. A concern triggers investigation and repair, not a human approval stop.

Review strong names (`complete`, `exhaustive`, `ready`, `successful`, `deployed`, `verified`, `synced`,
`sourceExhausted`) by asking what evidence the state proves and whether a narrower internal condition can make it true.
No pending tool calls does not prove task accomplishment; no failing tests does not prove the requirement; no search
results does not prove absence; a frontier empty for one view does not prove provider-wide exhaustion; HTTP 200 does not
prove a mutation; workflow success does not prove production behavior; per-view completion does not prove global coverage.
These are prompts to examine equivalence, not universal prohibitions.

## Concise result and continuation

Record in the PR/delivery summary:

```text
Semantic verification
Original outcome: ...
Critical invariants: ...
Falsification: scenario; expected outcome; test/result
Material external assumptions: ...
Internal-vs-outcome completion risk: ...
Evidence: implementation | unit | contract | provider | production (verified/not verified/not applicable, with reason)
Verdict: PASS | PASS WITH UNVERIFIED PROVIDER ASSUMPTION | BLOCKING SEMANTIC DEFECT
```

Never promote evidence between levels: mocks can establish unit or contract evidence but not live-provider evidence;
workflow completion is not production verification. Missing evidence does not by itself halt autonomous work. Investigate,
test, safely repair when clear, report the limitation, and continue normal protected delivery unless a real safety or
correctness blocker remains. Repair blocking defects before merge; non-blocking uncertainty stays explicit.

For a significant production defect, use `closed-loop-learning`: preserve both the specific executable regression and
the smallest generalized invariant. Do not create a parallel learning system or turn advisory learning into merge authority.
