# Advisory Codex Security pull-request scans

Codex Security adds a context-aware review of committed pull-request changes. It complements the repository's deterministic controls; CodeQL, Trivy, Gitleaks, `npm audit`, tests, architecture checks, policy guardrails, deployment verification, and branch protection remain mandatory and unchanged.

The separate `.github/workflows/codex-security.yml` workflow runs for non-draft pull requests targeting `main` when they are opened, synchronized, reopened, or marked ready for review. Credentialed work is skipped for fork pull requests and Dependabot pull requests, and the workflow uses `pull_request`, never `pull_request_target`. Superseded runs are cancelled per pull request.

The workflow installs the exact officially documented `@openai/codex-security@0.1.3` package under `$RUNNER_TEMP` before checking out pull-request-controlled content. It then checks out the exact PR head SHA without persisted credentials, calculates the Git merge base from the event's base and head SHAs, and runs a standard diff scan with:

- `gpt-5.6-sol`;
- `xhigh` reasoning effort;
- a `$3` estimated scan limit;
- the repository agent instructions, security documentation, architecture documentation, and current project state as knowledge-base inputs.

`--max-cost 3` is an estimated limit, not a strict hard cap. A request already in progress can finish above the limit, and partial results can remain available.

## Configure access

The repository owner must add `CODEX_SECURITY_API_KEY` as a GitHub Actions repository or organization secret and ensure that the associated OpenAI account has Codex Security access. The workflow maps that secret directly to `OPENAI_API_KEY` only for the scan step. It does not create, rotate, display, or expose the key.

Without the secret or the required entitlement, the scan must not be reported as passing. Authentication, runtime, export, and incomplete-coverage failures retain their real failure status.

## Review results

The initial rollout is advisory: the workflow deliberately omits `--fail-on-severity`, so finding severity does not block a merge. Incomplete coverage and scanner/runtime errors still fail the scan because they are not conclusive security evidence.

When a sealed scan is available, the workflow exports SARIF and uploads it against the exact PR head SHA and PR ref under the `codex-security` category. Review results in:

- GitHub code-scanning annotations from the SARIF upload;
- the workflow summary, which contains only scan status, coverage, estimated cost, severity counts, SARIF availability, and deferred-surface status;
- the private `codex-security-pr-<pr>-<head-sha>` artifact containing the complete result directory, JSON result document, and SARIF when available.

Artifacts are retained for seven days because they can contain vulnerable source excerpts, evidence, and remediation details. The workflow does not publish automated PR comments.

## Proposed rollout

1. Review approximately 10–20 pull-request scans.
2. Measure estimated cost, runtime, coverage completeness, and false positives.
3. Consider adding `--fail-on-severity high` after the advisory evidence is acceptable.
4. Consider testing `gpt-5.6-terra --effort high` for routine low-risk pull requests.
5. Consider a separate scheduled or manually dispatched deep repository scan. Deep mode must remain separate because diff targets support standard mode only.

Official references: [CI guide](https://learn.chatgpt.com/docs/security/cli/ci), [CLI reference](https://learn.chatgpt.com/docs/security/cli/reference), and [SDK guide](https://learn.chatgpt.com/docs/security/sdk). The CLI is used here because this is a direct CI integration; the SDK is unnecessary.
