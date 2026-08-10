# Autonomous delivery guardrails

## Protected merge

- `main` requires an up-to-date pull request and exactly `PR Gate` plus `Security Gate`, published by GitHub Actions.
- Direct pushes, force pushes, branch deletion, and admin bypass remain denied; squash/linear history and conversation resolution remain enabled.
- Native auto-merge is bound to the exact PR head. No polling controller, arbitrary status rollup, custom merge job, or admin merge exists.
- Unknown or malformed path classification fails closed to privileged validation. Aggregate jobs accept skips only when the trusted classifier says the job is not applicable.

## Workflow policy

Deterministic policy validation enforces:

- external actions pinned to full commit SHAs;
- explicit least-privilege workflow/job permissions;
- no `pull_request_target`;
- no unapproved event surfaces;
- no untrusted pull-request commands with write credentials;
- no raw check-run writers or check-run API access;
- no GitHub App/PAT token minting or alternate GitHub credentials;
- no `secrets: inherit`, dynamic secret lookup, or unapproved provider secret;
- `OPENAI_API_KEY` restricted to the deployed repairable-error runtime path.

Workflow files, policy, dependencies, scripts, agent instructions, authentication, and configuration are privileged changes and receive broad application plus security coverage.

## Runtime and supply chain

- Releases are built once from protected `main`, checksummed, SBOM-described, attested, and uploaded immutably.
- Azure deployment uses GitHub Actions OIDC, scoped identities, Key Vault references, and no long-lived client secret.
- Test and production require the same application digests, exact source identity, public/authenticated smoke, telemetry correlation, and release ledger validation.
- Production cannot promote a superseded main generation. Production and rollback serialize through one concurrency group.
- Automatic rollback is one-shot, application-package-only, and requires one unambiguous prior successful Delivery v2 artifact and ledger. Infrastructure and destructive data migrations are never automatically reversed.

## Application invariants

Authentication, JWT/JWKS validation, user/service-token separation, operation permissions, the Martin/user allowlist while required, audit, idempotency, confirmation, and provider-data minimization fail closed. Expensive operations remain authenticated and bounded. Secrets, tokens, private provider payloads, authorization headers, and sensitive full environment output must never enter logs, issues, artifacts, or repository memory.

The repair queue treats workflow output and GitHub text as untrusted evidence. It stores only sanitized identity and fingerprint metadata. A candidate cannot rewrite code, tests, policy, instructions, skills, or production configuration; every repair and learning promotion uses the normal protected PR path.
