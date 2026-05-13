---
name: azure-cli-devops
description: Use this skill when working with Azure CLI, Azure resource diagnostics, Azure Functions, Storage, Bicep, Entra app/OIDC, RBAC, resource groups, deployment debugging, or Azure architecture decisions for JueZ/api.
---

# Azure CLI DevOps Skill

Use `az` for Azure investigation, diagnostics, validation, deployment preparation, and safe operational work.

This skill is for:
- Azure account verification
- resource group inspection
- Azure Functions diagnostics
- Storage/static hosting diagnostics
- Bicep validation
- Entra app and OIDC checks
- RBAC checks
- Azure deployment debugging
- Azure architecture decisions
- cost-aware cloud-native planning

## Expected Codex environment variables

The canonical Codex direct Azure setup variables are:

    CODEX_AZURE_CLIENT_ID
    CODEX_AZURE_CLIENT_SECRET
    CODEX_AZURE_TENANT_ID
    AZURE_SUBSCRIPTION_ID
    AZURE_RESOURCE_GROUP

Do not use AZURE_TENANT_ID for Codex direct Azure setup unless the setup script is explicitly changed later.

Do not print any secret values.

## Before Azure work

Verify the current Azure login and selected subscription:

    az account show --query "{name:name,id:id,tenantId:tenantId}" --output table

Verify the project resource group:

    az group show --name "$AZURE_RESOURCE_GROUP" --query "{name:name,location:location}" --output table

If Azure CLI is not authenticated, report that Codex setup or cached auth is missing.

## Safe output

Use this for commands that could print sensitive data:

    export AZURE_CORE_OUTPUT=none

When output is needed, use narrow queries:

    az account show --query "{name:name,id:id,tenantId:tenantId}" --output table
    az group show --name "$AZURE_RESOURCE_GROUP" --query "{name:name,location:location}" --output table

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

## Resource scope

Prefer resource-group-scoped operations under:

    rg-api-prod

Avoid subscription-wide changes unless explicitly requested and documented.

Do not grant Owner permissions unless explicitly requested and documented.

Prefer least privilege.

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

If adding any paid or always-on Azure service, add a docs/cost note with:
- why it is needed
- expected cost class
- cheaper alternatives considered
- how to disable or remove it

## Bicep and deployment

Prefer Bicep/IaC changes under infra/ over portal-only manual changes.

For Bicep validation, use:

    az bicep build --file infra/main.bicep

Do not deploy infrastructure unless the task explicitly asks for deployment.

Do not enable production deployment unless:
- DEPLOY_PRODUCTION_ENABLED=true
- the task explicitly requires deployment
- CI and Policy Check are passing
- smoke test endpoint is known

## Deployment debugging order

When debugging deployment problems, inspect in this order:

1. GitHub Actions workflow logs.
2. Azure OIDC login result.
3. Azure subscription and resource group.
4. Bicep validation.
5. Function App existence.
6. Function App configuration and app settings.
7. Storage/static hosting configuration.
8. Application logs.
9. Smoke test endpoint.
10. Architecture assumptions.

Do not change architecture until logs and current Azure state have been inspected.

## Dangerous operations

Do not perform these unless explicitly requested:
- delete Azure resources
- rotate credentials
- change billing
- grant Owner
- change subscription-level RBAC
- enable production deployment
- make public unauthenticated APIs
- remove authentication
- weaken authorization
- remove budget/cost guardrails

## Final summary

For Azure CLI work, include:
- Azure CLI commands run
- Azure resources inspected
- Azure resources changed, if any
- deployment status
- cost implications
- security implications
- remaining manual steps
