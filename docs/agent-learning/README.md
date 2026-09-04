# Closed-loop learning

Repository learning is deliberately small and non-blocking. GitHub issues hold sanitized failure candidates; this directory holds only durable invariants that have executable prevention.

## Lifecycle

1. A trusted failed workflow creates or updates one `codex-repair` issue per normalized failure fingerprint.
2. Each exact SHA and fingerprint is recorded once. A recurrence increments the same issue instead of creating a duplicate.
3. Significant failures receive `learning-candidate`. A production rollback or recurrence count of two receives `learning-promotion-required`.
4. Codex repairs the cause through the normal protected pull-request path and adds a regression test or deterministic guard where appropriate.
5. When objective promotion criteria are met, the substantive repair PR (or a later normal protected PR) adds or updates one concise artifact under `artifacts/`.

Untrusted candidate records and workflow output cannot apply changes automatically. The authorized agent implements evidence-backed repairs and learning through a normal protected PR. They contain no raw logs, prompts, model transcripts, environment dumps, private provider content, or secrets.

Two ineffective attempts end one unchanged causal strategy, not the autonomous task. Re-diagnose from the earliest relevant evidence, choose a materially different hypothesis and discriminating check, and preserve the task as incomplete while safe work remains.

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

Each `artifacts/<id>.yml` file uses schema version 2 and contains:

- normalized `id` and stable mechanism `fingerprint`;
- `severity`, concise reusable `invariant`, and affected `scope`;
- one or more existing executable prevention paths;
- `recurrenceCount` and `status` (`active`, `verified`, or `superseded`);
- for `verified`, exact broken and fixed commits plus the repair PR;
- for `superseded`, the replacement artifact ID.

Unknown fields, duplicate IDs or fingerprints, missing prevention paths, path traversal, malformed identities, and secret-shaped values fail validation.

An artifact may also carry one optional `reusableClaim`. Existing schema-v2 artifacts need no migration. A reusable claim records a falsifiable claim, bounded path/component/condition scope, applicability, scoped exceptions, challenge state, supersession, optional review date or retirement reason, and one evidence observation:

```yaml
reusableClaim:
  id: stable-claim-id
  claim: Concise falsifiable guidance.
  scope:
    paths: []
    components: []
    conditions: []
  relation: supports # supports | refutes | bounds | supersedes
  evidence:
    kind: deterministic-reproduction
    source: test:stable-source-locator
    independence: independent # or shared-lineage with derivedFrom
  lineageId: stable.evidence-lineage
  independenceBasis: Why this source is or is not independent from earlier evidence.
  applicability: The bounded context in which the claim is expected to hold.
  exceptions: []
  challenge:
    state: none # none | open | resolved | accepted-exception
    severity: low # low | medium | high | blocking
  enforcement:
    kind: none # none | test | contract | policy | workflow | runtime-check
  supersedes: []
```

One exact evidence source belongs to one lineage. Evidence declares `independent` or `shared-lineage`; copied reviews also name their stable `derivedFrom` source so distinct restatements cannot invent new lineages. Repeated code occurrences and agent assertions do not manufacture corroboration. `independenceBasis` explains the relationship but does not make an agent identity independent evidence.

The index derives only qualitative navigation states: `candidate`, `corroborated`, `enforced`, `challenged`, `superseded`, or `retired`. A `supersedes` relation names the replaced claim IDs and leaves their history visible. A deterministic reproduction, protected-check failure, or runtime counterexample can challenge a claim regardless of advisory agreement. `enforced` requires an existing executable prevention path whose prevention kind and file type match the claimed control; prose and skills cannot produce that state. These states, challenge severities, review dates, and exceptions never create another merge or deployment authority, and an elapsed optional review date does not block unrelated work.

## Commands

```bash
npm run agent:learning:validate
npm run agent:learning:index
npm run agent:learning:index -- --check
```

The generated index is deterministic and contains no run IDs or timestamps. Git history, pull requests, workflow runs, deployments, and bounded workflow artifacts retain execution history; this directory does not duplicate it.
