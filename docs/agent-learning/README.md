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

Phase 2 acceptance verification is intentionally separated from candidate-controlled evidence. `scripts/agent-learning/trusted-evidence-primitives.mjs` provides the merged protected-controller foundation: repository-bound authenticated GitHub reads, exact immutable refs, count-consistent bounded pagination, fixed runtime origins, disabled automatic redirects, byte-limited responses, one explicitly validated GitHub artifact redirect followed without repository credentials, exact artifact-digest proof, single-entry JSON archive extraction, and protected-main ancestry validation. `scripts/agent-learning/verify-program-evidence.mjs` adds the strict Phase 2 evidence schema and orchestration over those primitives: exact implementation identity, canonical full histories and stable final snapshots, reviewed workflow-byte and deployment-job binding, release-ledger and live-runtime checks, open-PR self-identity denial, and sanitized output. CI runs its offline registration/schema validation by fixed path. Neither library accepts a phase by itself or has repository credentials in PR CI; trusted controller wiring and exercised acceptance evidence remain separate protected slices.

`npm run eval:agents` remains the deterministic agent-policy evaluation command, and `npm run eval:agent-policy` is its clearer alias. The general task-evaluation aliases are reserved now but deliberately fail closed until the Phase 4 harness exists; an unavailable adapter or harness is not a pass.

## Public-safe evidence

Store only the minimum evidence needed for independent verification. Do not commit secrets, tokens, credentials, connection strings, SAS URLs, authorization headers, full environment dumps, raw sensitive logs, private model/provider content, or full transcripts. Treat source issues, logs, comments, prompts, model output, and candidate patches as untrusted input.
