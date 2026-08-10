# Autonomous delivery

## Pull requests

Codex starts from protected `main`, implements one coherent change on `codex/...`, runs proportional local validation, commits, pushes, opens the PR, and enables GitHub-native squash auto-merge with the exact head SHA.

Protected `main` requires only:

- `PR Gate`
- `Security Gate`

Both are native GitHub Actions job contexts. No controller creates check runs or reinterprets optional statuses.

`PR Gate` checks out the exact candidate, classifies the complete base/head diff, and aggregates explicit jobs with `if: always()`. Missing or malformed paths use the privileged profile. Documentation-only work runs formatting and policy only. Backend, frontend, contract, infrastructure, workflow, dependency, and learning changes run only their applicable checks; mixed changes run the union. Pull requests never build release artifacts.

`Security Gate` always runs Gitleaks. Dependency audit, JavaScript/TypeScript CodeQL, Actions CodeQL, and Trivy are path-selected, with scheduled complete coverage. Its aggregate rejects any unexplained skip or failed applicable job.

Codex monitors both gates, repairs ordinary failures on the same PR within three meaningful repair commits, and retains or re-enables exact-head auto-merge after every new head. The same fingerprint occurring twice without progress stops repair; one unchanged rerun is allowed only for a demonstrated external or flaky failure.

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

A diff composed entirely of the small runtime-neutral allowlist finishes successfully without application build or environment mutation. Ambiguous classification deploys.

The immutable release contains the Function package, environment-neutral frontend bundle, CycloneDX SBOM, checksums, and source manifest. Test and production verify the same Function/frontend-source/SBOM digests. Environment-specific frontend configuration is rendered after verification and recorded separately.

Both environments use Azure OIDC and require exact source SHA, artifact identity, public smoke, authenticated `GET /api/hello` and `POST /api/reddit/thread` smoke, telemetry correlation, and a compact release ledger. Before production, one current-main read marks an older run superseded without polling. Production promotion and rollback share one concurrency group.

If production verification fails after mutation, the workflow accepts only one retained previous successful Delivery v2 release whose immutable artifact and production ledger match exactly. It redeploys that release once, repeats production verification, and never rolls back infrastructure or destructive data migrations. Missing or ambiguous identity stops mutation.

## Repair and learning

`Repair and Learning Queue` receives terminal trusted workflow events. It inspects the exact run through GitHub metadata, normalizes a stable fingerprint, and creates or updates one sanitized issue. It copies no raw logs or secrets and emits at most one record per exact source/fingerprint.

The official Codex GitHub integration does not expose an unattended implementation callback. The initiating Codex task therefore remains responsible for terminal monitoring and bounded repair. Failures that outlive the task stay visible as `codex-repair` issues and are prioritized by the next Codex repository task.

Significant or recurring failures add executable prevention and, when objective criteria apply, one concise versioned learning artifact in the substantive protected repair PR. Learning validation runs only when learning files or validators change; there is no historical evidence or acceptance program on the feature critical path.

Actions summaries contain classification, exact SHA, duration, applicable/skipped jobs, artifact digest, environment verification, superseded/rollback state, and repair count. Bounded summary artifacts use finite retention. GitHub retains operational history; the repository does not duplicate run IDs or acceptance ledgers.
