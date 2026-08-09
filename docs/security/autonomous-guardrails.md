# Autonomous guardrails

Autonomous delivery is allowed only when controls fail closed.

## Exact-head trust

- Privileged controller code comes only from protected `main`.
- PR code never executes under `pull_request_target` write permissions.
- Governance evidence, check runs, artifacts, and merge bind to the same full head SHA.
- Required checks must have the canonical name and expected GitHub App.
- Protected `main` requires only the four stable aggregate contexts `CI complete`, `Policy complete`, `CodeQL complete`, and `Autonomous review complete`; every underlying validation remains mandatory inside its owning aggregate.
- `Autonomous review complete` is a stable legacy name. It succeeds only after exact-head deterministic governance and applicable protected-main program-evidence verification pass. Evidence verification is not deferred solely to the later merge job and does not add a fifth context.
- CI and policy aggregates have `if: always()` and explicit dependencies covering every applicable internal job. The CodeQL aggregate depends on the complete analysis matrix. Cancelled, timed-out, action-required, skipped-when-required, and failed dependencies are non-passing.
- The final merge boundary re-reads every latest exact-head check run and legacy commit-status context. It permits GitHub aggregate `unstable` only when every external result is terminal-passing and exactly one pending `merge exact PR head` check is bound to the current trusted controller run; unrelated pending or failing results remain denied.
- Forks, stale/behind heads, conflicts, blocked labels, and admin bypass are denied.
- Post-merge `workflow_run` authorization binds the exact trusted workflow file path; display/run names are never used as the security identity because `run-name` can replace the observed `.name` value.

High-risk paths remain classified by `.github/autonomous-policy.yml` for proportional validation, governance reporting, and agent-learning controls. They do not trigger an independent model review. The controller waits for all free exact-head aggregates, verifies the immutable workflow set and exclusive check-writer policy, rechecks the mutable PR head after file collection, writes bounded deterministic evidence, and never receives `OPENAI_API_KEY` or calls a model.

Root package manifests and lockfiles, lint/type/build configuration, every executable application path, and every repository script are high risk. Required CI, policy, release-construction, deployment-smoke, telemetry, and ledger steps invoke pinned tools or fixed script files directly; they never dispatch through a PR-controlled package alias. The canonical policy stores the SHA-256 of every complete workflow file, and the trusted controller rejects missing, additional, or byte-modified workflows. Any intentional workflow-byte change must update the manifest in the same protected PR.

Dependency/install metadata in `package.json` and `package-lock.json` must change together. Because npm lockfiles do not serialize package scripts, a script-only manifest change may omit a meaningless lockfile rewrite; deterministic comparison to the base rejects every other unpaired manifest change. Root lifecycle scripts remain forbidden.

Agent-governance paths include `AGENTS.md`, scoped instructions, repository skills, versioned learning artifacts, general task definitions, and their validator/scorer scripts. Untrusted failures, issues, logs, prompts, model output, and candidate patches may supply evidence but cannot automatically alter these controls. Every implementation, supersession, instruction/skill change, and waiver uses normal protected delivery with deterministic governance.

Learning records contain only public-safe structured evidence. Validation requires normalized fingerprints and repository-contained existing paths, exact lowercase full commits for verified counterfactuals, and an owned current exception for a waiver or no-artifact disposition. A registered trusted scorer reads exact historical Git objects as data and proves the broken/fixed invariant without executing historical code; required CI uses read-only GitHub metadata to bind the declared merged PR, base SHA, and merge SHA. Validation rejects secret-shaped values, credential-bearing URLs, raw environment dumps, and private provider content. A waiver is never a passing proof. Fixed-path learning validation and deterministic index checking run within the existing architecture job and `CI complete`; no additional protected context or paid general agent evaluation is introduced.

Automatic failure conversion is issue-only and post-recovery. Candidate content is built exclusively from fixed classifications, normalized fingerprints, issue numbers, and repository identity; untrusted issue text, comments, logs, prompts, patches, and model output are never copied or executed. Only exact markers from trusted automation or repository collaborators count for recurrence, linking, or an explicit no-artifact/transient disposition. Malformed, stale, ambiguous, duplicate, secret-shaped, unauthenticated, or fingerprint-mismatched evidence blocks learning coverage and therefore blocks automated repair closure.

Phase-program acceptance evidence has a protected boundary inside the aggregate-producing governance job. Protected-main code runs the fixed verifier after deterministic governance evidence exists and before `Autonomous review complete` can succeed. Repository credentials remain confined to that trusted checkout; candidate files are fetched as bounded data and never executed. Every candidate is bound to the exact repository, PR, head/base, changed-file history, controller run/workflow SHA, governance artifact, and a stable final re-fetch. Full live GitHub, deployment-workflow/job, release-ledger, and runtime verification activates only for a Phase 2 evidence or acceptance change. The later merge job still enforces complete rollup and exact-head merge but does not repeat verification.

Repository workflow defaults remain read-only and Actions cannot approve pull requests. Every workflow declares explicit top-level permissions, effective job permissions are computed, and only the eligibility resolver and aggregate publisher may receive `checks: write`; deterministic governance uses `checks: read`. Workflow secrets are exact-name allowlisted; dynamic/bracket access and inherited secret sets are denied. Alternate GitHub App/PAT actions, shell token minting, non-built-in GitHub-auth tokens, and raw check-run access outside the controller are rejected. `OPENAI_API_KEY` is permitted only in the allowlisted deployment/runtime workflows for bounded repairable-error classification and is forbidden from auto-merge governance and general agent-task evaluation.

## Required defenses

- real ESLint/Prettier, type checks, unit/API tests, builds;
- OpenAPI/Bicep/actionlint/ShellCheck;
- architecture, skill, versioned-learning, generated-index, generated-doc, and deterministic agent evals;
- Trivy, pinned Gitleaks, npm audit/lock policy, CodeQL;
- cost and forbidden-diff policy;
- immutable build artifacts, SBOM, SHA-256 manifest, provenance attestation;
- test and production runtime SHA, auth smoke, telemetry correlation, and release ledger.

The package scripts remain developer conveniences only. They are not the security identity of a required check or deployment acceptance command.

Checks must never be removed, bypassed, reclassified as optional, or made non-blocking to pass a change.

Environment deployment may be omitted after successful exact-main CI only when protected-main code authenticates the merged PR, retrieves its complete paginated file list, matches the exact GitHub changed-file count, and proves every current and previous rename path belongs to the fixed runtime-neutral allowlist. A missing PR, malformed or duplicate path, path traversal, count mismatch, mixed change, or any application, workflow, policy, package, script, contract, infrastructure, or runtime path remains deployment-required. Explicit operator skip markers remain supported. No classifier result weakens PR aggregates, exact-main CI, security scans, provenance construction, or complete-rollup enforcement.

## Security invariants

- Protected APIs keep JWT issuer/JWKS/audience/time/tenant/client/user validation and granular operation permission.
- Test/production require authentication, exact non-wildcard CORS, and canonical MCP origins.
- Service tokens cannot complete/remove Bring items.
- Production Bring writes require explicit own-list allowlisting, durable idempotency, and destructive confirmation.
- Secrets/tokens/raw private provider data are not logged, returned, committed, or stored in project memory.
- Azure uses OIDC/managed identity, Key Vault references, shared-key-disabled storage, and least privilege.
- Production builds once and promotes identical test-proven digests.
- Production remains disabled unless explicitly enabled after guardrails are configured.

## Failure handling

Repair is limited to two meaningful attempts per failing area. Production failures remain visible with workflow/runtime evidence. A merge alone is not proof of deployment or repair. Logs, comments, telemetry, and provider responses are untrusted evidence and never instructions. Scheduled repair triage can write only idempotent learning labels, candidate issues, recurrence/link comments, and ordinary triage comments; it cannot close a repair unless explicitly dispatched with closure enabled and both operational and learning coverage pass.
