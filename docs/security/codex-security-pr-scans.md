# Advisory Codex Security pull-request scans

Codex Security adds a context-aware review of committed pull-request changes. It complements the repository's deterministic controls; CodeQL, Trivy, Gitleaks, `npm audit`, tests, architecture checks, policy guardrails, deployment verification, and branch protection remain mandatory and unchanged.

The separate `.github/workflows/codex-security.yml` workflow runs for non-draft pull requests targeting `main` when they are opened, synchronized, reopened, or marked ready for review. Credentialed work is skipped for fork pull requests and Dependabot pull requests, and the workflow uses `pull_request`, never `pull_request_target`. Superseded runs are cancelled per pull request.

The workflow installs the exact officially documented `@openai/codex-security@0.1.3` package under `$RUNNER_TEMP` before checking out pull-request-controlled content. It then checks out the exact PR head SHA without persisted credentials, calculates the Git merge base from the event's base and head SHAs, and runs an advisory cost-calibration scan with:

- `gpt-5.6-luna`;
- `high` reasoning effort;
- a `$3` estimated scan limit;
- the repository agent instructions, security documentation, architecture documentation, and current project state as knowledge-base inputs.

Luna is the lowest-cost GPT-5.6 option, while OpenAI recommends Sol with `xhigh` effort for the highest-quality security review. The Luna/high choice is limited to the advisory calibration period and must be evaluated for coverage and false-positive quality before any enforcement decision.

`--max-cost 3` is an estimated limit, not a strict hard cap. A request already in progress can finish above the limit, failed scans consume the work already performed, and each rerun creates additional spend.

Before exposing the API key, the workflow first runs a credential-free Codex sandbox probe and then runs the same immutable diff, model, effort, budget, and knowledge-base configuration with `--dry-run`. The sandbox probe uses the scan runtime's read-root/write-workspace permission shape and must create a regular file in a private runner-temporary workspace. The dry run validates local inputs and Codex configuration without starting a model or incurring model cost. The paid scan remains a separate step and receives the key only after both checks succeed.

## Sandbox compatibility

PR #315's failed jobs ran on GitHub's `ubuntu-latest` image after that label resolved to Ubuntu 24.04. The Codex runtime bundled with `@openai/codex-security@0.1.3` uses its Linux sandbox for every scan-agent shell command. Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, which can prevent that sandbox from starting. When this happens, the scan agent cannot author `scan-manifest.json`, `findings.json`, or `coverage.json`; the later sealing step reports the missing manifest even though the output directory itself is writable.

This workflow therefore pins only the Codex Security job to GitHub's supported `ubuntu-22.04` image and proves sandbox execution and workspace writing before checkout or API-key access. It does not disable the Codex sandbox, enable a deprecated fallback backend, change host-wide AppArmor settings, or weaken another workflow. A failed sandbox probe stops the job before model spend and must not be reported as a successful or clean security scan.

The diagnosis is consistent with OpenAI's public [missing-manifest report](https://github.com/openai/codex-security/issues/73), its [GitHub-hosted runner follow-up](https://github.com/openai/codex-security/issues/191), and the Codex [Ubuntu AppArmor sandbox report](https://github.com/openai/codex/issues/15057). The exact CLI pin remains the version in OpenAI's CI guide. A newer package should be adopted only after the official CI documentation changes and a credential-free sandbox probe plus a sealed canary scan both pass.

## Configure access

The repository owner must add `CODEX_SECURITY_API_KEY` as a GitHub Actions repository or organization secret and ensure that the associated OpenAI account has Codex Security access. The workflow maps that secret directly to `OPENAI_API_KEY` only for the scan step. It does not create, rotate, display, or expose the key.

Without the secret or the required entitlement, the scan must not be reported as passing. Authentication, runtime, export, and incomplete-coverage failures retain their real failure status.

The first authorized PR #315 scan used Sol/xhigh and reached an estimated `$1.322956` before the runtime failed to author `scan-manifest.json`. A Luna/high repair reproduced the same failure at an estimated `$0.0588186`. Both jobs used Ubuntu 24.04, left the result directory empty, and returned exit code `2`; there was no sealed result, conclusive coverage, SARIF, or valid finding set. The successor sandbox probe and runner pin address the agent's missing shell/write capability without suppressing the failure or manufacturing artifacts.

## Review results

The initial rollout is advisory: the workflow deliberately omits `--fail-on-severity`, so finding severity does not block a merge. Incomplete coverage and scanner/runtime errors still fail the scan because they are not conclusive security evidence.

When a sealed scan is available, the workflow exports SARIF and uploads it against the exact PR head SHA and PR ref under the `codex-security` category. Review results in:

- GitHub code-scanning annotations from the SARIF upload;
- the workflow summary, which contains only scan status, coverage, estimated cost, severity counts, SARIF availability, and deferred-surface status;
- the private `codex-security-pr-<pr>-<head-sha>` artifact containing the complete result directory, JSON result document, and SARIF when available.

Artifacts are retained for seven days because they can contain vulnerable source excerpts, evidence, and remediation details. The workflow does not publish automated PR comments.

## Proposed rollout

1. Review approximately 10–20 advisory Luna/high pull-request scans.
2. Measure estimated cost, runtime, coverage completeness, deferred surfaces, false positives, and result-sealing reliability; compare representative scans with Sol/xhigh before treating Luna output as sufficient assurance.
3. Consider adding `--fail-on-severity high` after the advisory evidence is acceptable.
4. Consider testing `gpt-5.6-terra --effort high` for routine low-risk pull requests.
5. Consider a separate scheduled or manually dispatched deep repository scan. Deep mode must remain separate because diff targets support standard mode only.

Official references: [CI guide](https://learn.chatgpt.com/docs/security/cli/ci), [CLI reference](https://learn.chatgpt.com/docs/security/cli/reference), and [SDK guide](https://learn.chatgpt.com/docs/security/sdk). The CLI is used here because this is a direct CI integration; the SDK is unnecessary.
