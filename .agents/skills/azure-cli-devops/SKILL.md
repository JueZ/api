---
name: azure-cli-devops
description: Use this skill when Azure CLI diagnostics, Bicep validation, Azure Functions, Storage, Entra/OIDC, RBAC, deployment debugging, Azure resource inspection, or Azure cost-aware planning is needed for JueZ/api.
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
- Azure architecture decisions when Azure resources, IaC, cost, deployment, or RBAC are relevant
- cost-aware cloud-native planning

## Expected Codex environment variables

The canonical Codex direct Azure setup variables are:

```text
CODEX_AZURE_CLIENT_ID
CODEX_AZURE_CLIENT_SECRET
CODEX_AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
AZURE_RESOURCE_GROUP
```

Known project resource groups:

```text
rg-api-test
rg-api-prod
```

Do not use `AZURE_TENANT_ID` for Codex direct Azure setup unless the setup script is explicitly changed later.

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

- the repository security deployment hold has been replaced only after external revocation and an independently reviewed out-of-band trust-root bootstrap; the current active-only record cannot be cleared by a GitHub comment or PR field
- `npm run ops:verify-github-deployment-controls` passes: deployment environments are protected-branch-only, the OIDC subject is bound to `repo`, `context`, and `job_workflow_ref`, and incident-disabled workflows remain disabled while held
- the old Azure federated credentials have been removed and exact workflow-bound replacements installed; never restore GitHub's default OIDC subject as a workaround
- `DEPLOY_PRODUCTION_ENABLED=true`
- required CI and Policy Check gates pass
- Deploy Test succeeds for the same source ref
- production deployment is not skipped
- production smoke/runtime-truth gates pass

Do not deploy production from local CLI unless the user explicitly requested operational production deployment. Even then, `DEPLOY_PRODUCTION_ENABLED=true`, required checks, deployment gates, and smoke/runtime verification still apply.

During the credential incident, do not use local cached/cloud credentials to test around suspended GitHub federation. Permit only narrow read-only evidence collection and authoritative credential revocation/rotation; never read or print local credential files. The Azure OIDC diagnostic must remain disabled until it has a separate Reader-only identity.

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
- Do not bypass, remove, disable, or weaken CI, Policy Check, required status checks, deployment gates, telemetry gates, or smoke tests

## Final summary

For Azure CLI work, include:

- Azure CLI commands run
- Azure resources inspected
- Azure resources changed, if any
- deployment status
- smoke/runtime-truth status when relevant
- cost implications
- security implications
- remaining manual steps or blockers
