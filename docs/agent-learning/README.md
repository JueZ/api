# Closed-loop learning

Repository learning is deliberately small and non-blocking. GitHub issues hold sanitized failure candidates; this directory holds only durable invariants that have executable prevention.

## Lifecycle

1. A trusted failed workflow creates or updates one `codex-repair` issue per normalized failure fingerprint.
2. Each exact SHA and fingerprint is recorded once. A recurrence increments the same issue instead of creating a duplicate.
3. Significant failures receive `learning-candidate`. A production rollback or recurrence count of two receives `learning-promotion-required`.
4. Codex repairs the cause through the normal protected pull-request path and adds a regression test or deterministic guard where appropriate.
5. When objective promotion criteria are met, the substantive repair PR (or a later normal protected PR) adds or updates one concise artifact under `artifacts/`.

Candidates and workflow output never rewrite code, instructions, skills, policy, or learning artifacts directly. They contain no raw logs, prompts, model transcripts, environment dumps, private provider content, or secrets.

## Promotion criteria

Promotion is required when any of these is true:

- production rolled back;
- the same fingerprint recurred at least twice;
- a high or critical failure has a successful causal repair and executable regression prevention;
- a security, authentication, authorization, data-integrity, or idempotency invariant was repaired;
- an explicit user correction or repeated Codex task failure produced a reusable testable invariant;
- repair required more than one causal attempt.

Learning maintenance never blocks an unrelated feature PR. The PR Gate validates learning files only when a learning artifact or validator changes.

## Artifact schema

Each `artifacts/<id>.yml` file uses schema version 2 and contains only:

- normalized `id` and stable mechanism `fingerprint`;
- `severity`, concise reusable `invariant`, and affected `scope`;
- one or more existing executable prevention paths;
- `recurrenceCount` and `status` (`active`, `verified`, or `superseded`);
- for `verified`, exact broken and fixed commits plus the repair PR;
- for `superseded`, the replacement artifact ID.

Unknown fields, duplicate IDs or fingerprints, missing prevention paths, path traversal, malformed identities, and secret-shaped values fail validation.

## Commands

```bash
npm run agent:learning:validate
npm run agent:learning:index
npm run agent:learning:index -- --check
```

The generated index is deterministic and contains no run IDs or timestamps. Git history, pull requests, workflow runs, deployments, and bounded workflow artifacts retain execution history; this directory does not duplicate it.
