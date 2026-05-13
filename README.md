# JueZ API Catalogue

v0 Hello World skeleton for a personal API catalogue platform.

## What is here

- Angular frontend in `apps/web`.
- Azure Functions TypeScript backend in `apps/api`.
- OpenAPI contract in `contracts/openapi.yaml`.
- Low-cost Bicep infrastructure skeleton in `infra/main.bicep`.
- Setup documentation in `docs/setup/v0-hello-world.md`.

## Quick start

```bash
npm install
npm run build
npm test
```

The v0 backend exposes `GET /health` and `GET /api/hello`. Authentication is
intentionally a placeholder until the next OAuth/OIDC/JWT milestone.

<!-- markdownlint-disable MD013 -->

## Manual bootstrap guide for a new repo

Use this reusable bootstrap guide to set up a future repository with the same autonomous delivery pattern as this
one. It covers:

- GitHub repository settings
- branch protection
- required checks
- auto-merge
- labels
- production environment
- Azure resource group
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
- `AZURE_RESOURCE_GROUP`
- `LOCATION`
- `GHA_APP_NAME`
- `CODEX_APP_NAME`
- `GHA_APP_ID`
- `GHA_SP_OBJECT_ID`
- `CODEX_APP_ID`
- `CODEX_SP_OBJECT_ID`
- `CODEX_AZURE_CLIENT_SECRET`
- `CODEX_GH_TOKEN`

For the current repository, the non-secret values used were:

- `OWNER=JueZ`
- `REPO=api`
- `LOCATION=westeurope`
- `AZURE_RESOURCE_GROUP=rg-api-prod`
- `GHA_APP_NAME=github-actions-api-prod`
- `CODEX_APP_NAME=codex-direct-api-devops`

Do not include real secret values in documentation, chat, issues, pull requests, shell history, or logs. Keep
`DEPLOY_PRODUCTION_ENABLED=false` during bootstrap.

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

If routine autonomous production deploys are intended, do not configure required reviewers for this environment.
Keep `DEPLOY_PRODUCTION_ENABLED=false` until the app and smoke tests work.

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

gh variable set AZURE_RESOURCE_GROUP \
  --body "$AZURE_RESOURCE_GROUP" \
  --repo "$GH_OWNER/$GH_REPO_NAME"

gh variable set DEPLOY_PRODUCTION_ENABLED \
  --body "false" \
  --repo "$GH_OWNER/$GH_REPO_NAME"
```

`PRODUCTION_BASE_URL` and `AZURE_FUNCTIONAPP_NAME` are optional for the first deployment. The production deployment workflow resolves the Function App from the `infra/main.bicep` `functionAppResourceName` output and discovers the Function App URL when `PRODUCTION_BASE_URL` is not set. `AZURE_STATIC_WEB_STORAGE_ACCOUNT` is required when an Angular app is present unless your Bicep template creates a separate static website storage account and outputs it as `staticWebStorageAccountResourceName`; do not point it at the Functions backing storage account.

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
- `AZURE_RESOURCE_GROUP`

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

### 15. When to enable production deployment

Only set `DEPLOY_PRODUCTION_ENABLED=true` after:

- CI passes
- Policy Check passes
- Azure OIDC verification passes
- branch protection and required checks are active
- Azure OIDC is configured for `main` and the `production` environment if used
- app deployment has been intentionally approved

The first production deployment can create the Function App and its backing storage resources from `infra/main.bicep`; `PRODUCTION_BASE_URL` and `AZURE_FUNCTIONAPP_NAME` can remain unset unless you need explicit overrides. Because the repository contains an Angular app, set `AZURE_STATIC_WEB_STORAGE_ACCOUNT` to a separate StorageV2 account intended for static website hosting unless your Bicep template outputs `staticWebStorageAccountResourceName`. After these workflow updates have merged and you are ready to deploy, run:

```bash
gh variable set DEPLOY_PRODUCTION_ENABLED \
  --body "true" \
  --repo OWNER/REPO

gh workflow run deploy-production.yml \
  --ref main \
  --repo OWNER/REPO

RUN_ID="$(gh run list \
  --repo OWNER/REPO \
  --workflow deploy-production.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$RUN_ID" \
  --repo OWNER/REPO \
  --exit-status
```

When the deployment run succeeds, call the deployed health and hello endpoints. If `PRODUCTION_BASE_URL` is not set as a repository variable, use the Function App hostname reported by Azure for the Bicep output `functionAppResourceName`.

```bash
FUNCTION_APP_NAME="$(az deployment group show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name main \
  --query properties.outputs.functionAppResourceName.value \
  -o tsv)"

PRODUCTION_BASE_URL="https://$(az functionapp show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$FUNCTION_APP_NAME" \
  --query defaultHostName \
  -o tsv)"

curl --fail --show-error --silent "$PRODUCTION_BASE_URL/health"
curl --fail --show-error --silent "$PRODUCTION_BASE_URL/api/hello"
```

Do not enable this during bootstrap.

### 16. Common pitfalls

- Branch protection personal repo issue: if the repo is private on GitHub Free, protection may not enforce. Use a
  public repo or GitHub Pro/Team.
- Do not include organization-only restriction fields when setting branch protection for personal repos.
- Do not paste OIDC subject strings like `repo:OWNER/REPO:ref:refs/heads/main` into the shell as commands.
- Do not use `GH_TOKEN` or `GITHUB_TOKEN` for Codex setup auth if you want `gh` to persist credentials.
- Rotate any secret accidentally pasted into chat or logs.
- Keep `DEPLOY_PRODUCTION_ENABLED=false` until ready.

<!-- markdownlint-enable MD013 -->
