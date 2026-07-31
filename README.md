# JueZ API Catalogue

v0 serverless foundation for a personal API catalogue platform.

## What is here

- Angular frontend in `apps/web`.
- Azure Functions TypeScript backend in `apps/api`.
- OpenAPI contract in `contracts/openapi.yaml`.
- GPT Actions OpenAPI contract for GPT Builder: `contracts/openapi.gpt.yaml` (the only supported GPT Actions schema; split Reddit/WLH schemas were removed).

- Low-cost Bicep infrastructure skeleton in `infra/main.bicep`.
- Setup documentation in `docs/setup/v0-hello-world.md`, authentication and GPT Actions OAuth setup in `docs/setup/authentication.md`, OAuth security guidance in `docs/security/service-oauth-authentication.md`, and staged deployment setup commands in `docs/setup/staged-deployment.md`.

## Project memory

This repository keeps repo-based project memory in [`docs/project-memory/README.md`](docs/project-memory/README.md). Codex uses it to preserve important project context across sessions, including current state, decisions, deployment history, incidents, known issues, glossary terms, and next steps.

## Quick start

```bash
npm install
npm run build
npm test
```

The v0 backend code exposes public `GET /health` and protected `GET /api/hello` when
`AUTH_ENABLED=true`. Test and production deployments use the same OAuth/OIDC JWT
configuration so authentication is validated before production promotion.

All service-generated REST failures use the Repairable Error Contract with `application/problem+json`. The one bundled `/mcp` server retains stable MCP error codes and adds the same contract at `structuredContent.repairable_problem`. Known failures are deterministic; only sanitized, explicitly uncertain diagnostics may use the optional OpenAI Responses API analyzer, and its output must pass local schema and policy gates.

Current deployment URLs, verified on 2026-05-14:

| Environment | API base URL                                                      | Angular frontend                                            |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Test        | <https://func-api-catalogue-test-iwt54bovfzvrc.azurewebsites.net> | <https://stapicataloguetestiwt54b.z6.web.core.windows.net/> |
| Production  | <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net> | <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/> |

For both environments, `GET /health` is public and unauthenticated
`GET /api/hello` returns `401` when auth is enabled.

## Lightweight staged deployment

This project now uses a simple **test -> production** promotion flow for the small v0 app:

1. Pull requests must pass CI and Policy Check before merge.
2. After `main` CI succeeds, `Deploy Test` deploys the same commit to the low-cost test resource group `rg-api-test` with `environmentName=test`.
3. `Deploy Test` runs smoke tests against the discovered test Function App URL:
   - `GET /health` must stay public.
   - unauthenticated `GET /api/hello` must return `401` when auth is enabled.
4. Only after the test deployment and smoke tests pass, `Promote Production` can deploy the same commit to `rg-api-prod` with `environmentName=prod`; production deployment fails closed unless `DEPLOY_PRODUCTION_ENABLED=true`.
5. `Promote Production` runs the same production smoke tests and then updates the non-secret GitHub repository variables `PRODUCTION_BASE_URL`, `AZURE_FUNCTIONAPP_NAME`, and `AZURE_STATIC_WEB_STORAGE_ACCOUNT`.

The normal path needs no routine human input. If the GitHub `production` environment has required reviewers configured, GitHub pauses the production job for approval before Azure changes are made. For a solo project, configure required reviewers only if you want that gate, and do not enable "prevent self-review" unless another reviewer exists. The `test` environment should normally have no reviewer approval.

### Deploying test

`Deploy Test` runs automatically after successful `main` CI. It can also be started manually for a specific commit or ref:

```bash
gh workflow run deploy-test.yml \
  --ref main \
  --repo JueZ/api \
  -f commit_sha=<commit-sha>
```

### Promoting to production

`Promote Production` runs automatically after `Deploy Test` succeeds for `main`. It can also be started manually to promote a specific commit or ref:

```bash
gh workflow run promote-production.yml \
  --ref main \
  --repo JueZ/api \
  -f commit_sha=<commit-sha> \
  -f test_delivery_correlation=<exact-successful-deploy-test-correlation> \
  -f test_run_id=<exact-successful-deploy-test-run-id>
```

### Rolling back production

Rollback redeploys only the preserved immutable Function/frontend bundle from an exact previously accepted production release. Current `main` remains authoritative for Bicep, identity, storage policy, and security settings. Supply the full source SHA, exact successful `Promote Production` run ID, and that run's delivery correlation.

```bash
gh workflow run rollback-production.yml \
  --ref main \
  --repo JueZ/api \
  -f commit_sha=<previous-good-commit-sha> \
  -f release_run_id=<previous-good-promote-production-run-id> \
  -f release_delivery_correlation=<previous-good-release-correlation>
```

This is enough for a small personal project because it proves the exact commit in a separate Azure resource group before production without adding always-on services or expensive routing infrastructure. Blue/green and canary deployments are overkill for v0. Azure Functions deployment slots could be a later hardening upgrade, but this task deliberately keeps the current low-cost consumption-style model and does not switch to a more expensive plan for slots.

See [`docs/setup/staged-deployment.md`](docs/setup/staged-deployment.md) for the exact Azure CLI and GitHub CLI setup commands for environments, resource groups, OIDC federated credentials, RBAC, manual deployment, promotion, and rollback. See [`docs/project-memory/current-state.md`](docs/project-memory/current-state.md) before operational work; it records the latest verified difference between code on `main` and production.

<!-- markdownlint-disable MD013 -->

## Manual bootstrap guide for a new repo

Use this reusable bootstrap guide to set up a future repository with the same autonomous delivery pattern as this
one. It covers:

- GitHub repository settings
- branch protection
- required checks
- auto-merge
- labels
- test and production environments
- Azure resource groups
- Entra app for GitHub Actions OIDC
- federated credentials
- Azure RBAC
- GitHub repository variables
- Codex direct Azure service principal
- Codex environment secrets
- Codex setup and maintenance scripts

Use placeholders for repository-specific values:

- `OWNER`
- `REPO`
- `OWNER/REPO`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_TENANT_ID`
- `TEST_AZURE_RESOURCE_GROUP`
- `PRODUCTION_AZURE_RESOURCE_GROUP`
- `LOCATION`
- `GHA_APP_NAME`
- `CODEX_APP_NAME`
- `GHA_APP_ID`
- `GHA_SP_OBJECT_ID`
- `CODEX_APP_ID`
- `CODEX_SP_OBJECT_ID`
- `CODEX_AZURE_CLIENT_SECRET`
- `CODEX_GH_TOKEN`
- `PRODUCTION_BASE_URL`

For the current repository, the non-secret values used were:

- `OWNER=JueZ`
- `REPO=api`
- `LOCATION=westeurope`
- `TEST_AZURE_RESOURCE_GROUP=rg-api-test`
- `PRODUCTION_AZURE_RESOURCE_GROUP=rg-api-prod`
- `GHA_APP_NAME=github-actions-api-prod`
- `CODEX_APP_NAME=codex-direct-api-devops`

Do not include real secret values in documentation, chat, issues, pull requests, shell history, or logs. Keep production promotion manual or protected by GitHub Environment approval until test deployment and smoke tests are verified.

### 1. GitHub repository settings

Configure the repository for autonomous pull-request delivery:

- auto-merge enabled
- squash merge enabled
- merge commits disabled
- rebase merges disabled
- delete branch on merge enabled
- `main` branch protected
- no force pushes
- no branch deletion
- admins enforced
- required status checks
- required approving review count = `0` for autonomous mode

```bash
gh api \
  --method PATCH \
  "repos/OWNER/REPO" \
  -H "Accept: application/vnd.github+json" \
  -F allow_auto_merge=true \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true
```

Protect `main` with the required checks. This JSON intentionally avoids organization-only restriction fields that
can break personal repositories.

```bash
gh api \
  --method PUT \
  "repos/OWNER/REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "install",
      "lint",
      "type-check",
      "unit tests",
      "API tests",
      "Angular build",
      "Azure Functions build",
      "OpenAPI validation",
      "Bicep validation",
      "security scan",
      "secret scan",
      "dependency audit",
      "CI complete",
      "cost-policy check",
      "guardrail policy check",
      "Policy complete"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
JSON
```

### 2. GitHub labels

Create labels used by autonomous delivery, repair, and production-failure workflows.

```bash
gh label create codex-automerge --repo OWNER/REPO --description "Allow Codex-created PRs to use auto-merge" || true
gh label create codex-repair --repo OWNER/REPO --description "Codex repair task" || true
gh label create production-failure --repo OWNER/REPO --description "Production deployment or smoke test failure" || true
```

### 3. GitHub production environment

Create the `production` environment.

```bash
gh api \
  --method PUT \
  "repos/OWNER/REPO/environments/production" \
  -H "Accept: application/vnd.github+json" \
  -f wait_timer=0 \
  -F prevent_self_review=false
```

For routine autonomous production deploys, do not configure required reviewers. If you want a production approval gate, configure required reviewers here; for a solo project, do not enable prevent self-review unless another reviewer exists. Test should normally have no reviewer approval.

### 4. Azure login and base variables

Confirm Azure CLI access, choose the subscription, and define base shell variables.

```bash
az account show --output table

az account list \
  --query "[].{Name:name, SubscriptionID:id, TenantID:tenantId, IsDefault:isDefault}" \
  --output table

export AZURE_SUBSCRIPTION_ID="<subscription-id>"
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

export AZURE_TENANT_ID="$(az account show --query tenantId -o tsv)"
export AZURE_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
export LOCATION="westeurope"
export AZURE_RESOURCE_GROUP="rg-api-prod"
export GH_OWNER="OWNER"
export GH_REPO_NAME="REPO"
export GHA_APP_NAME="github-actions-api-prod"
export CODEX_APP_NAME="codex-direct-api-devops"
export SCOPE="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP"
```

### 5. Create resource group

Create the Azure resource group for the project.

```bash
az group create \
  --name "$AZURE_RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output table
```

### 6. Create GitHub Actions Azure OIDC identity

This identity is for GitHub Actions only. It should use federated credentials, not a client secret.

```bash
GHA_APP_ID="$(az ad app create \
  --display-name "$GHA_APP_NAME" \
  --query appId \
  -o tsv)"

GHA_SP_OBJECT_ID="$(az ad sp create \
  --id "$GHA_APP_ID" \
  --query id \
  -o tsv)"

echo "GHA_APP_ID=$GHA_APP_ID"
echo "GHA_SP_OBJECT_ID=$GHA_SP_OBJECT_ID"
```

### 7. Add federated credentials

Add a production environment federated credential.

```bash
cat > gha-production-env-federated-credential.json <<EOF
{
  "name": "github-production-environment",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$GH_OWNER/$GH_REPO_NAME:environment:production",
  "description": "GitHub Actions OIDC for $GH_OWNER/$GH_REPO_NAME production environment",
  "audiences": [
    "api://AzureADTokenExchange"
  ]
}
EOF

az ad app federated-credential create \
  --id "$GHA_APP_ID" \
  --parameters @gha-production-env-federated-credential.json
```

Add a main branch federated credential.

```bash
cat > gha-main-branch-federated-credential.json <<EOF
{
  "name": "github-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$GH_OWNER/$GH_REPO_NAME:ref:refs/heads/main",
  "description": "GitHub Actions OIDC for $GH_OWNER/$GH_REPO_NAME main branch",
  "audiences": [
    "api://AzureADTokenExchange"
  ]
}
EOF

az ad app federated-credential create \
  --id "$GHA_APP_ID" \
  --parameters @gha-main-branch-federated-credential.json
```

Verify the federated credentials.

```bash
az ad app federated-credential list \
  --id "$GHA_APP_ID" \
  --query "[].{Name:name, Subject:subject}" \
  --output table
```

### 8. Assign Azure RBAC for GitHub Actions

Assign GitHub Actions only the access needed for project deployment.

```bash
az role assignment create \
  --assignee-object-id "$GHA_SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Contributor" \
  --scope "$SCOPE" \
  --output table
```

Use resource group scope, not subscription owner. Only add RBAC administrator roles if Bicep later requires role
assignments.

### 9. Add GitHub repository variables

Set repository variables for GitHub Actions. These are non-secret values.

```bash
gh variable set AZURE_CLIENT_ID \
  --body "$GHA_APP_ID" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

gh variable set AZURE_TENANT_ID \
  --body "$AZURE_TENANT_ID" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

gh variable set AZURE_SUBSCRIPTION_ID \
  --body "$AZURE_SUBSCRIPTION_ID" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

```

Add these later, after real deployment targets exist.

```bash
gh variable set PRODUCTION_BASE_URL \
  --body "https://YOUR-PRODUCTION-URL" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

gh variable set AZURE_FUNCTIONAPP_NAME \
  --body "YOUR-FUNCTION-APP-NAME" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

gh variable set AZURE_STATIC_WEB_STORAGE_ACCOUNT \
  --body "YOUR-STORAGE-ACCOUNT-NAME" \
  --repo "$GH_OWNER/$GH_REPO_NAME"
```

### 10. Create Codex direct Azure identity

This identity is separate from the GitHub Actions identity. It is for Codex direct `az` CLI access. It uses a client
secret stored in Codex environment secrets; do not store that secret in the README or GitHub variables.

```bash
CODEX_APP_ID="$(az ad app create \
  --display-name "$CODEX_APP_NAME" \
  --query appId \
  -o tsv)"

CODEX_SP_OBJECT_ID="$(az ad sp create \
  --id "$CODEX_APP_ID" \
  --query id \
  -o tsv)"

echo "CODEX_APP_ID=$CODEX_APP_ID"
echo "CODEX_SP_OBJECT_ID=$CODEX_SP_OBJECT_ID"

CODEX_AZURE_CLIENT_SECRET=$(az ad app credential reset \
  --id "$CODEX_APP_ID" \
  --append \
  --display-name "codex-direct-secret" \
  --years 1 \
  --query password \
  -o tsv)

echo "Store CODEX_AZURE_CLIENT_SECRET in Codex secrets now. Do not paste it into chat, README, issues, or PRs."
```

### 11. Assign Azure RBAC for Codex direct access

Give Codex read visibility at subscription scope and write access only at the project resource group scope.

```bash
az role assignment create \
  --assignee-object-id "$CODEX_SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Reader" \
  --scope "/subscriptions/$AZURE_SUBSCRIPTION_ID" \
  --output table

az role assignment create \
  --assignee-object-id "$CODEX_SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Contributor" \
  --scope "$SCOPE" \
  --output table
```

`Reader` at subscription scope is for visibility. `Contributor` at resource group scope is for project work. Avoid
`Owner` and broad subscription write permissions.

### 12. Codex environment variables and secrets

Configure Codex environment secrets:

- `CODEX_AZURE_CLIENT_SECRET`
- `CODEX_GH_TOKEN`

Configure Codex non-secret variables:

- `CODEX_AZURE_CLIENT_ID`
- `CODEX_AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `TEST_AZURE_RESOURCE_GROUP`
- `PRODUCTION_AZURE_RESOURCE_GROUP`

`CODEX_AZURE_TENANT_ID` is canonical for Codex setup, and `CODEX_GH_TOKEN` is canonical for Codex setup GitHub
authentication. Do not use `GH_TOKEN` or `GITHUB_TOKEN` for Codex setup auth if you want `gh` to persist credentials.
The setup script clears `GH_TOKEN` and `GITHUB_TOKEN` before running `gh auth login`.

### 13. Codex setup and maintenance scripts

Run setup on a fresh Codex host.

```bash
sudo -E scripts/setup-codex-env.sh
```

Run maintenance on an existing Codex host.

```bash
sudo scripts/maintain-codex-env.sh
```

The setup script installs `az` and `gh`, logs into Azure using the Codex service principal, and logs into `gh` using
`CODEX_GH_TOKEN`. The maintenance script reinstalls or verifies CLIs and verifies cached authentication. Maintenance
does not use or print secrets. Neither script deploys anything.

### 14. Verification commands

Use these commands to verify repository variables, Azure OIDC configuration, and branch protection.

```bash
gh variable list --repo OWNER/REPO

az ad app federated-credential list \
  --id "$GHA_APP_ID" \
  --query "[].{Name:name, Subject:subject}" \
  --output table

gh workflow run verify-azure-oidc.yml --repo OWNER/REPO

RUN_ID="$(gh run list \
  --repo OWNER/REPO \
  --workflow verify-azure-oidc.yml \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$RUN_ID" \
  --repo OWNER/REPO \
  --exit-status

gh api "repos/OWNER/REPO/branches/main/protection" \
  --jq '{required_status_checks: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled, required_linear_history: .required_linear_history.enabled, allow_force_pushes: .allow_force_pushes.enabled, allow_deletions: .allow_deletions.enabled}'
```

### 15. When to rely on production promotion

Rely on automatic production promotion only after:

- CI passes
- Policy Check passes
- Azure OIDC verification passes
- branch protection is active
- the test resource group `rg-api-test` exists and can be deployed
- the production resource group `rg-api-prod` exists and can be deployed
- test smoke tests pass for `/health` and `/api/hello`
- production smoke tests pass for `/health` and `/api/hello`
- the GitHub `production` environment approval policy matches your risk tolerance

If you want a human gate, configure required reviewers on the GitHub `production` environment instead of adding deployment secrets or disabling automation.

### 16. Common pitfalls

- Branch protection personal repo issue: if the repo is private on GitHub Free, protection may not enforce. Use a
  public repo or GitHub Pro/Team.
- Do not include organization-only restriction fields when setting branch protection for personal repos.
- Do not paste OIDC subject strings like `repo:OWNER/REPO:ref:refs/heads/main` into the shell as commands.
- Do not use `GH_TOKEN` or `GITHUB_TOKEN` for Codex setup auth if you want `gh` to persist credentials.
- Rotate any secret accidentally pasted into chat or logs.
- Keep production protected by the GitHub `production` environment until staged deployment is verified.

<!-- markdownlint-enable MD013 -->
