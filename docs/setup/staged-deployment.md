# Staged deployment setup commands

This guide contains the Azure CLI and GitHub CLI commands needed to finish the lightweight `test -> production` deployment setup for `JueZ/api`.

The commands intentionally avoid secrets. They create/verify GitHub environments, Azure resource groups, GitHub OIDC federated credentials, least-privilege deployment RBAC, and then show how to run test deploy, production promotion, and rollback.

## Verified consolidation status on 2026-05-14

Safe inspection during the consolidation sprint found:

- GitHub environments `test` and `production` exist.
- Azure resource groups `rg-api-test` and `rg-api-prod` exist in `westeurope`.
- Test and production Function Apps, plans, App Insights instances, and storage accounts exist.
- Production Function App runtime is Node 22.
- The latest inspected `Deploy Test` run on `main` succeeded (`25849812564`).
- Subsequent `Promote Production` runs were skipped; production auth deployment remains unverified. Production deployment is also expected to fail closed while `DEPLOY_PRODUCTION_ENABLED=false`.
- Production API remains <https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net>.
- Production Angular frontend remains <https://stapicatalogueprodbfjsts.z6.web.core.windows.net/>.
- The deployment workflow uses managed-identity run-from-package blob access, not SAS package URLs.
- Codex could not verify Entra app registrations, federated credentials, or deployment-principal RBAC because the current Azure identity lacked sufficient Microsoft Graph visibility and project memory does not contain the deployment service principal object ID.

Complete the relevant checklist sections below before relying on auth-enabled
production promotion. Do not store secrets, SAS URLs, connection strings, or full
app settings in project memory or docs.

## 1. Local shell variables

Set these values in your shell. Keep using `westeurope` and the existing GitHub Actions Azure OIDC application.

```bash
export GH_OWNER="JueZ"
export GH_REPO_NAME="api"
export REPOSITORY="$GH_OWNER/$GH_REPO_NAME"
export LOCATION="westeurope"
export TEST_RESOURCE_GROUP="rg-api-test"
export PRODUCTION_RESOURCE_GROUP="rg-api-prod"

export AZURE_CLIENT_ID="$(gh variable get AZURE_CLIENT_ID --repo "$REPOSITORY")"
export AZURE_TENANT_ID="$(gh variable get AZURE_TENANT_ID --repo "$REPOSITORY")"
export AZURE_SUBSCRIPTION_ID="$(gh variable get AZURE_SUBSCRIPTION_ID --repo "$REPOSITORY")"
```

Verify CLI authentication without printing sensitive values:

```bash
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner,url

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query "{name:name,id:id,tenantId:tenantId}" --output table
```

## 2. Create or verify GitHub environments

Create the `test` environment without required reviewers:

```bash
gh api \
  --method PUT \
  "repos/$REPOSITORY/environments/test" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "wait_timer": 0
}
JSON
```

Create the `production` environment without required reviewers if you want fully automatic promotion after test passes:

```bash
gh api \
  --method PUT \
  "repos/$REPOSITORY/environments/production" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "wait_timer": 0
}
JSON
```

Alternatively, configure a production approval gate. Replace `YOUR_GITHUB_LOGIN` with the reviewer login. For a solo project, do not enable `prevent_self_review` unless another reviewer exists.

```bash
export PRODUCTION_REVIEWER_LOGIN="YOUR_GITHUB_LOGIN"
export PRODUCTION_REVIEWER_ID="$(gh api "users/$PRODUCTION_REVIEWER_LOGIN" --jq '.id')"

jq -n \
  --argjson reviewer_id "$PRODUCTION_REVIEWER_ID" \
  '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [
      {type: "User", id: $reviewer_id}
    ]
  }' | gh api \
    --method PUT \
    "repos/$REPOSITORY/environments/production" \
    -H "Accept: application/vnd.github+json" \
    --input -
```

Verify both environments:

```bash
gh api "repos/$REPOSITORY/environments" \
  --jq '.environments[] | select(.name == "test" or .name == "production") | {name, protection_rules}'
```

## 3. Create Azure resource groups

Create the test resource group. Verify production already exists and is also in `westeurope`.

```bash
az group create \
  --name "$TEST_RESOURCE_GROUP" \
  --location "$LOCATION" \
  --tags workload=api-catalogue environment=test costProfile=serverless-consumption \
  --query "{name:name,location:location}" \
  --output table

az group show \
  --name "$PRODUCTION_RESOURCE_GROUP" \
  --query "{name:name,location:location}" \
  --output table
```

If `rg-api-prod` does not exist in a fresh setup, create it with the same location and production tags:

```bash
az group create \
  --name "$PRODUCTION_RESOURCE_GROUP" \
  --location "$LOCATION" \
  --tags workload=api-catalogue environment=prod costProfile=serverless-consumption \
  --query "{name:name,location:location}" \
  --output table
```

## 4. Add GitHub Actions OIDC federated credentials

Because the deployment jobs use GitHub Environments, the Azure app should trust these subjects:

- `repo:JueZ/api:environment:test`
- `repo:JueZ/api:environment:production`

The branch subject is useful for the existing Azure OIDC verification workflow:

- `repo:JueZ/api:ref:refs/heads/main`

Create missing federated credentials:

```bash
cat > /tmp/juez-api-oidc-test.json <<JSON
{
  "name": "github-juez-api-test",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$REPOSITORY:environment:test",
  "description": "JueZ/api test environment deployment",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON

cat > /tmp/juez-api-oidc-production.json <<JSON
{
  "name": "github-juez-api-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$REPOSITORY:environment:production",
  "description": "JueZ/api production environment deployment",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON

cat > /tmp/juez-api-oidc-main.json <<JSON
{
  "name": "github-juez-api-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:$REPOSITORY:ref:refs/heads/main",
  "description": "JueZ/api main branch verification workflows",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON

for credential_file in \
  /tmp/juez-api-oidc-test.json \
  /tmp/juez-api-oidc-production.json \
  /tmp/juez-api-oidc-main.json; do
  credential_name="$(jq -r '.name' "$credential_file")"
  if az ad app federated-credential list --id "$AZURE_CLIENT_ID" --query "[?name=='$credential_name'] | length(@)" -o tsv | grep -q '^0$'; then
    az ad app federated-credential create \
      --id "$AZURE_CLIENT_ID" \
      --parameters "@$credential_file" \
      --only-show-errors
  else
    echo "Federated credential already exists: $credential_name"
  fi
done
```

Verify only non-secret OIDC metadata:

```bash
az ad app federated-credential list \
  --id "$AZURE_CLIENT_ID" \
  --query "[].{name:name,subject:subject}" \
  --output table
```

## 5. Grant deployment RBAC for test and production

Resolve the GitHub Actions service principal object ID:

```bash
export GHA_SP_OBJECT_ID="$(az ad sp show --id "$AZURE_CLIENT_ID" --query id -o tsv)"
```

Grant the GitHub Actions identity the least roles currently needed by the workflows at each resource-group scope:

- `Contributor` for Bicep deployments and Function App configuration.
- `Storage Blob Data Contributor` for uploading Function and Angular artifacts through Azure Storage data-plane APIs.
- `Role Based Access Control Administrator` so `infra/main.bicep` can create the Function App managed identity's storage-reader role assignment. Keep this scoped to the resource groups, not the subscription.

```bash
for resource_group in "$TEST_RESOURCE_GROUP" "$PRODUCTION_RESOURCE_GROUP"; do
  scope="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$resource_group"

  for role in \
    "Contributor" \
    "Storage Blob Data Contributor" \
    "Role Based Access Control Administrator"; do
    assignment_count="$(az role assignment list \
      --assignee "$GHA_SP_OBJECT_ID" \
      --role "$role" \
      --scope "$scope" \
      --query "length(@)" \
      -o tsv)"

    if [ "$assignment_count" = "0" ]; then
      az role assignment create \
        --assignee-object-id "$GHA_SP_OBJECT_ID" \
        --assignee-principal-type ServicePrincipal \
        --role "$role" \
        --scope "$scope" \
        --only-show-errors
    else
      echo "Role already assigned at $scope: $role"
    fi
  done
done
```

Verify role assignments without printing secrets:

```bash
for resource_group in "$TEST_RESOURCE_GROUP" "$PRODUCTION_RESOURCE_GROUP"; do
  scope="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$resource_group"
  echo "Roles for $resource_group"
  az role assignment list \
    --assignee "$GHA_SP_OBJECT_ID" \
    --scope "$scope" \
    --query "[].{role:roleDefinitionName,scope:scope}" \
    --output table
done
```

## 6. Verify GitHub variables

These repository variables should already exist. Set or correct them only with non-secret values:

```bash
gh variable set AZURE_CLIENT_ID --repo "$REPOSITORY" --body "$AZURE_CLIENT_ID"
gh variable set AZURE_TENANT_ID --repo "$REPOSITORY" --body "$AZURE_TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPOSITORY" --body "$AZURE_SUBSCRIPTION_ID"

# Keep false until you intentionally allow guarded production promotion.
gh variable set DEPLOY_PRODUCTION_ENABLED --repo "$REPOSITORY" --body "false"

gh variable list --repo "$REPOSITORY"
```

Authentication variables are shared by `Deploy Test` and `Promote Production`; keep them identical so test validates the same Microsoft Entra issuer, API audience, scope, tenant, and allowlisted user as production before promotion. Set these non-secret values before running the first authenticated test deployment:

```bash
gh variable set AUTH_ENABLED --repo "$REPOSITORY" --body "true"
gh variable set OIDC_ISSUER --repo "$REPOSITORY" --body "<issuer URL or comma-separated issuer URLs>"
gh variable set OIDC_AUDIENCE --repo "$REPOSITORY" --body "<API application ID URI or client ID>"
gh variable set OIDC_REQUIRED_SCOPES --repo "$REPOSITORY" --body "api.access"
gh variable set OIDC_ALLOWED_OBJECT_IDS --repo "$REPOSITORY" --body "<allowed user object ID>"
gh variable set OIDC_ALLOWED_APP_OBJECT_IDS --repo "$REPOSITORY" --body ""
gh variable set OIDC_ALLOWED_CLIENT_IDS --repo "$REPOSITORY" --body ""
gh variable set OIDC_ALLOWED_TENANTS --repo "$REPOSITORY" --body "<tenant ID>"
gh variable set WEB_AUTH_ENABLED --repo "$REPOSITORY" --body "true"
gh variable set WEB_AUTH_CLIENT_ID --repo "$REPOSITORY" --body "<SPA application client ID>"
gh variable set WEB_AUTH_AUTHORITY --repo "$REPOSITORY" --body "<MSAL authority URL>"
gh variable set WEB_AUTH_API_SCOPE --repo "$REPOSITORY" --body "api://<api-app-client-id>/api.access"
```

For app-only test-zone service/e2e auth, prefer environment-level GitHub variables on the `test` environment for `OIDC_REQUIRED_SCOPES=api.access,api.test`, `OIDC_ALLOWED_APP_OBJECT_IDS`, `OIDC_ALLOWED_CLIENT_IDS`, `TEST_SERVICE_AUTH_CLIENT_ID`, `TEST_SERVICE_AUTH_TENANT_ID`, and `TEST_SERVICE_AUTH_SCOPE`; see `docs/security/service-oauth-authentication.md` and `scripts/configure-entra-service-oauth.sh`. Keep production service-client allowlists empty unless production app-to-app access is intentionally required.

Use the same SPA app registration for both environments only after adding both redirect origins to that registration. Production still requires `WEB_AUTH_REDIRECT_URI`; test normally omits `TEST_WEB_AUTH_REDIRECT_URI` so the Angular app uses the deployed test frontend origin at runtime. If the identity provider requires an explicit test redirect, set `TEST_WEB_AUTH_REDIRECT_URI` to that exact registered test frontend URI. Do not set `TEST_WEB_API_BASE_URL` unless you intentionally need an override; by default the test frontend calls the test Function App discovered during deployment.

Production variables are updated by `Promote Production` after production smoke tests pass. If you need to seed them with the current known production values before the first staged promotion, use:

```bash
gh variable set PRODUCTION_BASE_URL \
  --repo "$REPOSITORY" \
  --body "https://func-api-catalogue-prod-bfjstshehpbfk.azurewebsites.net"

gh variable set AZURE_FUNCTIONAPP_NAME \
  --repo "$REPOSITORY" \
  --body "func-api-catalogue-prod-bfjstshehpbfk"

gh variable set AZURE_STATIC_WEB_STORAGE_ACCOUNT \
  --repo "$REPOSITORY" \
  --body "stapicatalogueprodbfjsts"
```

## 7. Run test deployment and production promotion

Run test manually after the resource group, OIDC, and RBAC setup is complete:

```bash
gh workflow run deploy-test.yml \
  --ref main \
  --repo "$REPOSITORY"

TEST_RUN_ID="$(gh run list \
  --repo "$REPOSITORY" \
  --workflow deploy-test.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$TEST_RUN_ID" \
  --repo "$REPOSITORY" \
  --exit-status
```

If `Deploy Test` passes, `Promote Production` should start automatically for normal `main` workflow-run events. If you need to promote manually, run:

```bash
gh workflow run promote-production.yml \
  --ref main \
  --repo "$REPOSITORY"

PRODUCTION_RUN_ID="$(gh run list \
  --repo "$REPOSITORY" \
  --workflow promote-production.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$PRODUCTION_RUN_ID" \
  --repo "$REPOSITORY" \
  --exit-status
```

If production has required reviewers configured, approve the waiting deployment in the GitHub Actions UI. Do not bypass environment approval.

## 8. Roll back production to a previous commit

Redeploy a previous known-good commit through the same production path:

```bash
gh workflow run rollback-production.yml \
  --ref main \
  --repo "$REPOSITORY" \
  -f commit_sha=<previous-good-commit-sha>

ROLLBACK_RUN_ID="$(gh run list \
  --repo "$REPOSITORY" \
  --workflow rollback-production.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$ROLLBACK_RUN_ID" \
  --repo "$REPOSITORY" \
  --exit-status
```

The rollback workflow runs production smoke tests and updates production variables only after those tests pass.

## 9. Troubleshooting commands

Inspect failed workflow logs:

```bash
gh run view "$TEST_RUN_ID" --repo "$REPOSITORY" --log-failed
gh run view "$PRODUCTION_RUN_ID" --repo "$REPOSITORY" --log-failed
gh run view "$ROLLBACK_RUN_ID" --repo "$REPOSITORY" --log-failed
```

Verify deployed Azure resources after Bicep runs:

```bash
az deployment group show \
  --resource-group "$TEST_RESOURCE_GROUP" \
  --name main-test \
  --query properties.outputs \
  --output json

az deployment group show \
  --resource-group "$PRODUCTION_RESOURCE_GROUP" \
  --name main-prod \
  --query properties.outputs \
  --output json
```

Run smoke tests against the production URL recorded by GitHub variables:

```bash
PRODUCTION_BASE_URL="$(gh variable get PRODUCTION_BASE_URL --repo "$REPOSITORY")"
curl --fail --show-error --silent "$PRODUCTION_BASE_URL/health"
curl --fail --show-error --silent "$PRODUCTION_BASE_URL/api/hello"
```
