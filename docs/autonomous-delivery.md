# Autonomous delivery

## Pull requests

Codex starts from protected `main`, implements one coherent change on `codex/...`, runs proportional local validation, commits, pushes, opens the PR, and enables GitHub-native squash auto-merge with the exact head SHA.

Protected `main` requires only:

- `PR Gate`
- `Security Gate`

Both are native GitHub Actions job contexts. No controller creates check runs or reinterprets optional statuses.

`PR Gate` checks out the exact candidate, classifies the complete base/head diff, and aggregates explicit jobs with `if: always()`. Missing or malformed paths use the privileged profile. Documentation-only work runs formatting and policy only. Backend, frontend, contract, infrastructure, workflow, dependency, and learning changes run only their applicable checks; mixed changes run the union. Pull requests never build release artifacts.

`Security Gate` always runs Gitleaks. Dependency audit covers both the root build/frontend lock and the standalone deployed Function lock. JavaScript/TypeScript CodeQL, Actions CodeQL, and Trivy are path-selected, with scheduled complete coverage. Its aggregate rejects any unexplained skip or failed applicable job.

Codex monitors both gates, repairs ordinary failures on the same PR within one bounded repair generation, and retains or re-enables exact-head auto-merge after every new head. A strategy fingerprint binds the failing gate or failure class, root-cause hypothesis, affected surface, and repair mechanism. Two ineffective attempts with one fingerprint retire that strategy and require re-diagnosis, a different hypothesis, and a discriminating action; they do not abandon the requirement. One unchanged rerun is allowed only for a demonstrated external or flaky failure.

## Semantic verification

Substantial user-visible changes add one proportional pre-delivery phase between implementation and validation. Codex
restates the original outcome, derives 3–8 correctness invariants, separates mechanism tests from semantic contract tests,
and independently tries to falsify its interpretation. The critic starts from the request, diff, tests, and relevant
external contract rather than an implementer defense. A realistic counterexample that can be executed becomes a regression
at the provider/service boundary. Acceptance tests should not merely copy the current algorithm's output: at least one key
test must fail if the central semantic assumption is false.

Internal completion and outcome completion are separate evidence. An empty queue, successful request, passing workflow,
or exhausted provider view supports only the claim its contract justifies. In particular, a narrower mechanism must not
be promoted to a stronger `complete`, `exhaustive`, `successful`, or `verified` state without evidence that the two are
equivalent. Material undocumented provider assumptions remain explicit. Difficult provider behavior may use minimized,
sanitized provider-derived fixtures, but a fixture or mock is not live-provider evidence.

PR reporting states the evidence actually obtained at these levels: implementation, unit, contract, provider, and
production. Levels may be not applicable or not verified; they are never silently promoted. A critic concern causes
investigation, a test, a safe repair, or a truthful limitation—not a routine human approval or an autonomous-delivery stop.
The phase applies to new APIs/tools, provider/pagination/completeness logic, mutations, runtime semantics, major business
behavior, and strong terminal statuses. Trivial or behavior-neutral changes remain on the existing lightweight path.

## Protected-main delivery

`Delivery v2` starts directly on a push to `main`:

```text
classify protected-main diff
  -> build immutable release once
  -> attest and upload
  -> deploy exact artifact to test
  -> verify test
  -> read current main once
  -> promote the same digest to production
  -> verify production
```

The trusted change classifier and repository-level delivery variables select this path. Routine protected deployment and production promotion do not require a per-task request or approval.

A diff composed entirely of the small runtime-neutral allowlist finishes successfully without application build or environment mutation. Ambiguous classification deploys.

The immutable release contains the Function package, environment-neutral frontend bundle, CycloneDX SBOM, checksums, and source manifest. The SBOM is generated from the exact installed production Function stage; the compiled frontend/build graph remains covered by the root lock audit, Dependabot, CodeQL, and Trivy rather than being misrepresented as a second installed runtime tree. A separate compiled-frontend component inventory remains a future concern only if release-level frontend inventory is needed. Test and production verify the same Function/frontend-source/SBOM digests. Environment-specific frontend configuration is rendered after verification and recorded separately.

Both environments use Azure OIDC and require exact source SHA, artifact identity, public smoke, authenticated `GET /api/hello` and `POST /api/reddit/thread` smoke, telemetry correlation, and a compact release ledger. Before production, one current-main read marks an older run superseded without polling. Production promotion and rollback share one concurrency group.

A superseded generation records the newer protected-main SHA but is not completion evidence. Codex verifies that the requested change is present in that newer commit and follows the Delivery v2 generation representing current main.

Runtime-affecting work is not complete at merge or after test deployment alone. Its terminal success requires the applicable current-main Delivery v2 generation and production runtime evidence. A runtime-neutral change may finish without environment mutation only when the trusted classifier records that result.

If production verification fails after mutation, the workflow accepts only one retained previous successful Delivery v2 release whose immutable artifact and production ledger match exactly. It redeploys that release once, repeats production verification, and never rolls back infrastructure or destructive data migrations. Missing or ambiguous identity stops mutation.

## Repair and learning

`Repair and Learning Queue` receives terminal trusted workflow events. It inspects the exact run through GitHub metadata, normalizes a stable fingerprint, and creates or updates one sanitized issue. It copies no raw logs or secrets and emits at most one record per exact source/fingerprint.

The official Codex GitHub integration does not expose an unattended implementation callback. The initiating Codex task therefore monitors and repairs while it can. If its execution or repair-generation budget ends first, the deduplicated `codex-repair` lineage remains active with the exact failure, attempted strategy fingerprints, evidence, current hypothesis, next discriminating action, blocker or resume condition, and rollback/runtime state. The protected-main queue accepts a bounded, public-safe workflow-dispatch progress snapshot tied to the exact source run; it schema-sanitizes the input, policy-checks new attempts, forces the task to remain active and unverified, and appends advisory bot-authored history. An exact expected candidate SHA explicitly carries a protected-main repair into its next generation without merging unrelated same-fingerprint tasks. Repair writers serialize in one repository-wide `queue: max` concurrency group, which retains at most 100 pending runs. A 101st or later run canceled at that platform boundary is a visible incomplete continuation, never success. After the backlog drains, the active delivery task uses its existing repair authority to redispatch the exact retained source run without asking the owner to restate the requirement: `gh workflow run repair-triage.yml --repo JueZ/api -f source_run_id=<exact-source-run-id> -f dry_run=false`. The immutable source workflow run remains the evidence, a redispatch is not completion evidence, and the repair queue has no schedule or recursive self-trigger. Later repository work resumes applicable unblocked lineages without requiring the owner to restate the requirement; blocked or unrelated lineages do not freeze safe work.

Significant or recurring failures add executable prevention and, when objective criteria apply, one concise versioned learning artifact in the substantive protected repair PR. Learning validation runs only when learning files or validators change; there is no historical evidence or acceptance program on the feature critical path.

The artifact pairs the specific regression with the smallest generalized invariant, so a provider-specific incident can
improve future semantic review without becoming a rigid unrelated rule.

Protected security, merge, provenance, deployment, and runtime-verification controls are hard invariants. Architectural and implementation guidance is advisory: a scoped exception or counterexample may change the default when the deviation is explicit, minimally bounded, and validated.

Actions summaries contain classification, exact SHA, duration, applicable/skipped jobs, artifact digest, environment verification, superseded/rollback state, and repair count. Bounded summary artifacts use finite retention. GitHub retains operational history; the repository does not duplicate run IDs or acceptance ledgers.
