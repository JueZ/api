---
name: production-rollback
description: Use this skill when rolling back or redeploying JueZ/api production to a previous known-good full commit SHA from main through rollback-production.yml, or when explaining the rollback workflow and required checks.
---

# Production Rollback Skill

Use this skill for JueZ/api production rollback requests.

## Guardrails

- Use the GitHub Actions `Rollback Production` workflow; do not invent a separate production deployment path.
- Roll back only to a full 40-character known-good commit SHA from `main`.
- The rollback source commit must have passed the repository deployment provenance gates required by the workflow.
- Supply the exact prior successful `Promote Production` run ID and delivery correlation whose accepted release ledger and preserved release bundle match the rollback SHA and artifact digests.
- Current `main` remains authoritative for the immutable rollback controller and validation logic. Rollback must not execute Bicep or reconcile identity, storage policy, or safety settings; it may switch only to the exact Function/frontend bytes preserved by that accepted production run.
- The accepted production run and the new rollback run must both be workflow attempt 1. Never rerun either workflow run; dispatch a new run with a new correlation after diagnosing a failure.
- Rollback requires both application deployment flags, resolves existing Azure resources read-only, validates existing safety settings and the complete rendered frontend before mutation, requires the digest-addressed Function blob to already exist, changes only the Function package pointer/release provenance without writing safety settings, and uploads the preserved rendered frontend archive without rewriting its configuration or build metadata.
- `DEPLOY_PRODUCTION_ENABLED=true` is required for production rollback deployment.
- Do not enable `DEPLOY_PRODUCTION_ENABLED=true` unless the operator/user explicitly requests enabling production deployment and the guardrails, approval posture, and risk are documented.
- Do not print secrets, tokens, connection strings, SAS URLs, or full environment dumps.
- Do not bypass, remove, disable, or weaken CI, Policy Check, smoke tests, telemetry gates, environment approvals, branch protection, required status checks, or guardrails.
- Do not delete Azure resources or make destructive Azure changes.
- Production rollback still uses the GitHub `production` environment; if required reviewers are configured, wait for approval instead of bypassing it.
- Do not use GitHub's rerun operation for deployment workflows. Diagnose the failure, then create a new dispatch with a new correlation.

## Preflight

Verify GitHub CLI auth and repository access:

```bash
gh auth status
gh repo view JueZ/api
```

Verify production deployment is enabled before starting rollback:

```bash
gh variable get DEPLOY_PRODUCTION_ENABLED --repo JueZ/api
```

If `DEPLOY_PRODUCTION_ENABLED` is not `true`, report rollback as blocked. Do not set it to `true` unless the operator/user explicitly requests enabling production deployment and the guardrails, approval posture, and risk are documented.

Identify a previous known-good full 40-character commit SHA from `main`, its exact successful `Promote Production` run ID, and the delivery correlation in that run title/ledger. Useful evidence sources include:

```bash
gh run list --repo JueZ/api --workflow promote-production.yml --branch main --limit 20
gh run list --repo JueZ/api --workflow rollback-production.yml --branch main --limit 20
gh run list --repo JueZ/api --workflow deploy-test.yml --branch main --limit 20
```

Do not roll back to an ambiguous short SHA if the workflow requires a full SHA.

## Standard rollback command

Replace all placeholders with evidence from the same previously accepted production release:

```bash
gh workflow run rollback-production.yml \
  --ref main \
  --repo JueZ/api \
  -f commit_sha=<previous-good-commit-sha> \
  -f release_run_id=<previous-good-promote-production-run-id> \
  -f release_delivery_correlation=<previous-good-release-correlation>
```

Watch the run:

```bash
RUN_ID="$(gh run list \
  --repo JueZ/api \
  --workflow rollback-production.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$RUN_ID" \
  --repo JueZ/api \
  --exit-status
```

Inspect details if needed:

```bash
gh run view "$RUN_ID" --repo JueZ/api
gh run view "$RUN_ID" --repo JueZ/api --log-failed
```

## Verify after rollback

1. Read the workflow summary for:
   - effective production base URL
   - Function App name
   - storage account
   - deployed source ref
   - smoke-test status
   - authenticated smoke status
   - telemetry status
   - release-ledger artifact status

2. Confirm workflow smoke tests passed for:
   - `GET /health`
   - unauthenticated `GET /api/hello`
   - authenticated `GET /api/hello` when a smoke token is available
   - authenticated `POST /api/reddit/thread` when a smoke token is available
   - telemetry smoke correlation when configured

3. Resolve the production base URL in this order:
   - Use the rollback workflow summary or deployment output effective base URL.
   - Use `PRODUCTION_BASE_URL` if it is set as a GitHub variable.
   - Discover the Function App `defaultHostName` and use `https://<defaultHostName>`.

Example fallback:

```bash
EFFECTIVE_BASE_URL="<effective-base-url-from-workflow-summary-if-known>"

if [ -z "$EFFECTIVE_BASE_URL" ]; then
  EFFECTIVE_BASE_URL="$(gh variable get PRODUCTION_BASE_URL --repo JueZ/api 2>/dev/null || true)"
fi

if [ -z "$EFFECTIVE_BASE_URL" ]; then
  function_app_name="<function-app-name-from-workflow-summary-or-resource-discovery>"
  default_host_name="$(az resource show \
    --resource-group rg-api-prod \
    --resource-type Microsoft.Web/sites \
    --name "$function_app_name" \
    --api-version 2023-12-01 \
    --query properties.defaultHostName \
    --output tsv)"
  EFFECTIVE_BASE_URL="https://$default_host_name"
fi
```

4. Verify externally with the resolved effective base URL:

```bash
curl --fail --show-error --silent "$EFFECTIVE_BASE_URL/health"

hello_status="$(curl --show-error --silent --output /dev/null --write-out '%{http_code}' "$EFFECTIVE_BASE_URL/api/hello")"
test "$hello_status" = "401"
```

Production authentication is a fail-closed safety invariant. An unauthenticated `200` is an incident and a failed rollback verification; never accept it by deriving an expected status from a mutable or missing `AUTH_ENABLED` variable.

5. Verify `/health` reports the expected deployed commit/source ref when the response contains deployment metadata.

6. Validate release/runtime-truth ledger artifacts when produced by the workflow.

## If rollback fails

- Inspect failed logs with `gh run view "$RUN_ID" --repo JueZ/api --log-failed`.
- Do not use GitHub's rerun operation. Diagnose the failure, then create a new dispatch with a new correlation.
- If the failure is infrastructure, RBAC, OIDC, package, or runtime related, use the repo `azure-cli-devops`, `github-cli-devops`, and `azure-observability-diagnostics` skills.
- If production remains unhealthy, create or update a repair issue/PR with the run URL, commit SHA, deployed source ref, smoke-test failure summary, and telemetry/runtime-truth evidence.
- Production repair issues must not be closed merely because a PR merged; require CI, deployment, runtime, smoke, telemetry, or release-ledger evidence as applicable.

## Final summary

For rollback work, include:

- rollback commit SHA
- rollback workflow run URL
- production deployment status
- smoke-test status
- authenticated smoke status
- telemetry/runtime-truth status
- release-ledger status when available
- effective production base URL checked
- whether any resources were changed outside the workflow
- remaining risks or blockers
