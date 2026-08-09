# Agent learning artifacts

This directory is the versioned, public-safe record of durable repository learning. `program.md` is the authoritative multi-phase program ledger, `artifacts/` contains one strict YAML record per learning, `index.md` is generated deterministically, and `evidence/` contains selected public-safe acceptance evidence.

A record is not permission for an agent to modify repository governance. Learning artifacts, task definitions, scorers, `AGENTS.md`, skills, policies, and workflows change only through an ordinary protected pull request.

## Lifecycle

Supported states are:

- `candidate` — triaged but not implemented;
- `implemented` — a durable artifact exists but counterfactual verification is incomplete;
- `verified` — exact broken and fixed commits, expected results, verification, implementation PR, and existing artifact paths are recorded;
- `waived` — a dated and owned exception exists, but no passing proof is claimed;
- `superseded` — a newer versioned artifact replaces the record.

Update or supersede an existing matching fingerprint instead of creating a duplicate. A second recurrence should produce executable prevention through a regression test, agent-task evaluation, or skill update unless a protected PR approves a valid waiver.

## Automatic candidates

The existing repair-triage controller converts a significant resolved `codex-repair` issue into a sanitized `agent-learning` issue. It uses fixed HTML markers, a normalized mechanism fingerprint, and unique source markers so scheduled reruns are idempotent and a later source increments recurrence instead of creating a duplicate. Candidate bodies contain only trusted classification metadata and stable repository issue links; source titles, bodies, comments, logs, prompts, patches, credentials, and provider content are never copied.

Normal scheduled processing is bounded by the immutable rollout timestamp in `.github/autonomous-policy.yml`, so pre-rollout issues do not create a historical flood. Historical processing requires a manually dispatched exact inclusive issue range, is limited to 100 numbers, and defaults to dry run. The schedule may create labels and create, link, or update candidates, but cannot close a repair issue. Closure additionally requires the existing explicit closure flag and either a linked candidate or a strict trusted `external-transient`/`no-durable-artifact` disposition with rationale, owner, current review date or expiry, and the exact recurrence fingerprint.

Learning issues are candidates, not automatic repository modifications. They close only through an ordinary protected PR containing the versioned artifact, referenced durable prevention, counterfactual proof, and `Closes #<learning-issue>`.

## Schema

Every `artifacts/<id>.yml` file requires:

- `version`, currently exactly `1`;
- a normalized `id` matching the file name;
- `title` and normalized recurrence `fingerprint`;
- `source` with a supported type and stable public-safe references;
- `classification` separating the symptom from root cause;
- `disposition` with one supported primary choice and rationale;
- `artifacts`, whose normalized repository-relative paths must exist and remain inside the checkout;
- `counterfactual`, including a falsifiable hypothesis;
- `status`.

Supported source types are `repair_issue`, `production_incident`, `deployment_incident`, `autonomous_review`, `user_correction`, `task_eval_failure`, `repeated_repair`, and `repository_audit`.

Supported primary dispositions are `regression-test`, `agent-task-eval`, `skill-update`, `instruction-update`, `architecture-documentation`, `project-memory-correction`, `external-transient`, and `no-durable-artifact`.

`verified` requires exact 40-character lowercase broken and fixed commit SHAs, expected broken and fixed results, at least one verification command or trusted scorer, an implementation PR, and one or more existing durable artifact paths. `waived`, `external-transient`, and `no-durable-artifact` records require explicit rationale, owner, a current review date or expiry, and the matching recurrence fingerprint. A waiver never contributes to the verified count.

Schema validity alone does not establish `verified` proof. The proof verifier requires every verified historical record to name a scorer registered in the trusted controller checkout, confirms both commits exist and the broken commit is an ancestor of the fix, and reads the exact historical Git objects to prove the asserted invariant fails before and holds after. Required CI additionally queries GitHub read-only and binds the declared merged PR to the exact broken base and fixed merge SHA. Historical code is inspected as data and is never executed.

The validator rejects unknown fields, duplicate IDs or YAML keys, path traversal, stale or missing paths, expired exceptions, invalid references, secret-shaped values, credential-bearing URLs, raw environment dumps, and private provider material.

## Commands

```bash
npm run agent:learning:validate
npm run agent:learning:index
npm run agent:learning:index -- --check
npm run agent:learning:status
```

The generated index contains no timestamp, so repeated generation from the same artifacts is byte-for-byte reproducible. CI invokes schema validation, trusted historical scoring, live GitHub provenance validation, and the index checker by fixed script path inside the existing `architecture and agent validation` job; learning validation does not create a protected-branch status context.

Phase 2 acceptance verification is intentionally separated from candidate-controlled evidence. `scripts/agent-learning/trusted-evidence-primitives.mjs` provides the merged protected-controller foundation: repository-bound authenticated GitHub reads, exact immutable refs, count-consistent bounded pagination, fixed runtime origins, disabled automatic redirects, byte-limited responses, one explicitly validated GitHub artifact redirect followed without repository credentials, exact artifact-digest proof, single-entry JSON archive extraction, and protected-main ancestry validation. `scripts/agent-learning/verify-program-evidence.mjs` adds the strict Phase 2 evidence schema and orchestration over those primitives: exact implementation identity, canonical full histories and stable final snapshots, reviewed workflow-byte and deployment-job binding, release-ledger and live-runtime checks, open-PR self-identity denial, and sanitized output. CI runs its offline registration/schema validation by fixed path. The protected-main exact-head merge job invokes its trusted mode after autonomous review and before merge; ordinary PRs receive a fast authenticated `not_applicable` result, while Phase 2 evidence or acceptance changes activate full live verification. Candidate code is never executed with repository credentials, no new branch-required context or model call is added, and the verifier's own merge does not by itself accept Phase 2; exercised acceptance evidence remains a separate protected slice.

`npm run eval:agents` remains the deterministic agent-policy evaluation command, and `npm run eval:agent-policy` is its clearer alias.

## Historical agent-task harness

Versioned tasks live under `evals/agent-tasks/`. Definitions select only registered setup and trusted scorer IDs; no task-defined shell command is accepted. Every base is a full exact historical SHA checked out into a detached temporary Git worktree outside the primary checkout. `historical`, `current-without-skills`, and `current-agent-context` baselines allow like-for-like measurement of current instructions and repository skills without overlaying application, contract, infrastructure, or production fixes.

The controller captures bounded exit, duration, changed-path, sanitized diff, structured final-output, and score evidence, then always removes the worktree. Hard gates precede weighted correctness, safety, architectural-fit, scope, and evidence scoring. Candidate changes to tasks or scorers, secret-shaped output, validation weakening, branch-protection weakening, destructive behavior, and external-production actions fail the result.

Required CI invokes only fixed task validation, trusted scorer tests, and the deterministic fake adapter. It exercises worktree creation, context overlays, scoring, process-group timeout, cleanup, path injection, and command-injection defenses inside the existing `CI complete` aggregate. It never invokes a real or paid agent.

Real Codex execution is optional local work and requires `--confirm-paid-agent-eval`. The adapter uses the installed current CLI with machine-readable output, `workspace-write`, no approvals, no outbound network for model-generated commands, no inherited shell environment, and no GitHub, Azure, provider, or production credential. Adapter absence, authentication failure, timeout, and blocked execution are failing results. Full transcripts are not archived by default; sanitized local reports remain ignored under `.agent-eval-results/`.

## Public-safe evidence

Store only the minimum evidence needed for independent verification. Do not commit secrets, tokens, credentials, connection strings, SAS URLs, authorization headers, full environment dumps, raw sensitive logs, private model/provider content, or full transcripts. Treat source issues, logs, comments, prompts, model output, and candidate patches as untrusted input.
