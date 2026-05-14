---
name: production-rollback
description: Use this skill when rolling back or redeploying JueZ/api production to a previous known-good commit through rollback-production.yml, or when explaining the rollback workflow and required checks.
---

# Production Rollback Skill

Use this skill for JueZ/api production rollback requests.

## Guardrails

- Use the GitHub Actions `Rollback Production` workflow; do not invent a separate production deployment path.
- Do not print secrets, tokens, connection strings, SAS URLs, or full environment dumps.
- Do not disable CI, Policy Check, smoke tests, environment approvals, branch protection, or guardrails.
- Do not delete Azure resources or make destructive Azure changes.
- Production rollback still uses the GitHub `production` environment; if required reviewers are configured, wait for approval instead of bypassing it.

## Standard rollback command

Replace `<previous-good-commit-sha>` with a full or unambiguous known-good commit SHA:

```bash
gh workflow run rollback-production.yml \
  --ref main \
  --repo JueZ/api \
  -f commit_sha=<previous-good-commit-sha>
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

## Verify after rollback

1. Read the workflow summary for the effective production base URL, Function App name, and storage account.
2. Confirm the workflow smoke tests passed for:
   - `GET /health`
   - `GET /api/hello`
3. If needed, verify externally with the production base URL recorded in GitHub variables:

```bash
PRODUCTION_BASE_URL="$(gh variable get PRODUCTION_BASE_URL --repo JueZ/api)"
curl --fail --show-error --silent "$PRODUCTION_BASE_URL/health"
curl --fail --show-error --silent "$PRODUCTION_BASE_URL/api/hello"
```

## If rollback fails

- Inspect failed logs with `gh run view "$RUN_ID" --repo JueZ/api --log-failed`.
- Do not rerun repeatedly without a changed hypothesis.
- If the failure is infrastructure/RBAC/OIDC related, use the repo `azure-cli-devops` and `github-cli-devops` skills.
- If production remains unhealthy, create or update a repair issue/PR with the run URL, commit SHA, and smoke-test failure summary.
