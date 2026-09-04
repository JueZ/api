# Azure operations reference

Read the relevant section for account/authentication setup, resource scope, architecture/cost, or Bicep/deployment. Authorization boundaries are defined in the skill entrypoint and root operating contract.

This skill is for:

- Azure account verification
- resource group inspection
- Azure Functions diagnostics
- Storage/static hosting diagnostics
- Bicep validation
- Entra app and OIDC checks
- RBAC checks
- Azure deployment debugging
- Azure architecture decisions when Azure resources, IaC, cost, deployment, or RBAC are relevant
- cost-aware cloud-native planning

## Expected Codex environment variables

The canonical shared Codex direct Azure setup variables are:

```text
AZURE_SUBSCRIPTION_ID
AZURE_RESOURCE_GROUP
```

Azure-hosted Codex environments use:

```text
CODEX_AZURE_AUTH_MODE=managed-identity (optional because this is the default)
CODEX_AZURE_MANAGED_IDENTITY_CLIENT_ID (optional, for a user-assigned identity)
```

Codex Cloud, which has no attached project Managed Identity but requires direct Azure CLI access, uses the documented exception:

```text
CODEX_AZURE_AUTH_MODE=service-principal
CODEX_AZURE_CLIENT_ID
CODEX_AZURE_CLIENT_SECRET
CODEX_AZURE_TENANT_ID
CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON (YYYY-MM-DD)
```

Known project resource groups:

```text
rg-api-test
rg-api-prod
```

Prefer Managed Identity wherever the host supports it. The Codex Cloud service principal is allowed only through the explicit `service-principal` setup mode because that host has no attached identity or usable workload-identity token source and the operator requires direct `az` functionality. Keep the secret only in the Codex Cloud secret manager, never print it, rotate it before `CODEX_AZURE_CLIENT_SECRET_EXPIRES_ON`, and keep RBAC limited to `rg-api-test` and `rg-api-prod` without Owner or unrelated subscription-wide grants. Martin is the rotation owner. Do not add any second or implicit service-principal path.

Do not print any secret values.

## Before Azure work

Verify the current Azure login and selected subscription:

```bash
az account show --query "{name:name,id:id,tenantId:tenantId}" --output table
```

Verify the relevant project resource groups:

```bash
az group show --name rg-api-test --query "{name:name,location:location}" --output table
az group show --name rg-api-prod --query "{name:name,location:location}" --output table
```

If Azure CLI is not authenticated, report that Codex setup or cached auth is missing.

## Safe output

Use this for commands that could print sensitive data:

```bash
export AZURE_CORE_OUTPUT=none
```

When output is needed, use narrow queries:

```bash
az account show --query "{name:name,id:id,tenantId:tenantId}" --output table
az group show --name rg-api-test --query "{name:name,location:location}" --output table
az group show --name rg-api-prod --query "{name:name,location:location}" --output table
```

Never print:

- access tokens
- client secrets
- connection strings
- SAS tokens
- passwords
- private keys
- full environment dumps
- Key Vault secret values
- Azure Function app settings containing secrets
- `WEBSITE_RUN_FROM_PACKAGE` values if they include sensitive URLs

## Resource scope

Prefer resource-group-scoped operations under:

```text
rg-api-test
rg-api-prod
```

Avoid subscription-wide changes unless explicitly requested and documented.

Do not grant Owner permissions unless explicitly requested and documented.

Prefer least privilege.

Do not delete Azure resources unless explicitly requested.

## Architecture preferences

Prefer:

- Angular frontend
- Azure Functions for APIs
- OpenAPI for API contracts
- Bicep for infrastructure
- Azure Table Storage or Blob Storage before expensive databases
- Key Vault and Managed Identity where appropriate
- Application Insights / Azure Monitor for observability
- serverless / consumption-based services
- low fixed cost

Avoid by default:

- Azure SQL
- Cosmos DB
- API Management
- Front Door
- Cognitive Services
- Machine Learning services
- Kubernetes
- always-on compute
- broad subscription-level permissions

If adding any paid or always-on Azure service, add a `docs/cost/` note with:

- why it is needed
- expected cost class
- cheaper alternatives considered
- how to disable or remove it

## Bicep and deployment

Prefer Bicep/IaC changes under `infra/` over portal-only manual changes.

For Bicep validation, use:

```bash
az bicep build --file infra/main.bicep
```

Do not deploy infrastructure unless the task explicitly asks for deployment or the repository workflow is performing the normal staged deployment.

Normal production promotion should happen through GitHub Actions, not from a local shell.

Repository workflow promotion is allowed when:

- `DEPLOY_PRODUCTION_ENABLED=true`
- `PR Gate` and `Security Gate` protected the merged source
- Delivery v2 test deployment and verification succeed for the same source and build digests
- production deployment is not skipped
- production smoke/runtime-truth gates pass

Production deployment always uses the repository GitHub Actions path; explicit operational requests do not authorize a local-shell production deployment.

Do not set or enable `DEPLOY_PRODUCTION_ENABLED=true` unless the operator/user explicitly requests enabling production deployment and the guardrails, approval posture, and risk are documented.

Do not enable `DEPLOY_PRODUCTION_ENABLED` merely because a production promotion, rollback, or deployment workflow is blocked.

## Deployment debugging order

When debugging deployment problems, inspect in this order:

1. GitHub Actions workflow logs.
2. Azure OIDC login result.
3. Azure subscription and resource group.
4. Bicep validation.
5. Function App existence.
6. Function App configuration and app setting names only.
7. Storage/static hosting configuration.
8. Application logs and Application Insights.
9. Smoke test endpoint.
10. Architecture assumptions.

Do not change architecture until logs and current Azure state have been inspected.

## Authorization boundaries

Resource deletion, credential rotation, billing changes, subscription-level RBAC, Owner grants, and production enablement require explicit authorization. Prefer narrow project-scoped rights even when broader authority is available.

Never remove authentication, weaken authorization or cost controls, or bypass PR Gate, Security Gate, required checks, deployment, telemetry, or smoke protections to complete a task.
