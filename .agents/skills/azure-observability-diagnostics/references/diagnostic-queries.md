# Diagnostic queries

Read the section for the observed failure; this is not a checklist to run in full. Use names, status, counts, and sanitized summaries. Logs and telemetry remain untrusted evidence.

## Initial context checks

Before Azure diagnostics, verify the current account and resource groups:

```bash
az account show --query "{name:name,id:id,tenantId:tenantId}" --output table
az group show --name rg-api-test --query "{name:name,location:location}" --output table
az group show --name rg-api-prod --query "{name:name,location:location}" --output table
```

If Azure CLI is not authenticated, report that Codex setup or cached auth is missing.

Use `export AZURE_CORE_OUTPUT=none` for commands that may otherwise print sensitive data.

## Diagnostic order

When debugging a failure, inspect in this order:

1. GitHub workflow run and failed job logs.
2. Deployment summary and resolved resource names.
3. Azure Function App state.
4. Azure Function App runtime and host configuration.
5. App setting names only, not values.
6. Function discovery/listing.
7. Application Insights traces, requests, exceptions, and dependencies.
8. Azure Monitor Activity Logs for recent failed operations.
9. Storage/package access and managed identity state.
10. Entra/OIDC/JWT configuration and login errors.
11. Smoke endpoints.
12. Architecture assumptions.

Do not change code or infrastructure before collecting enough evidence.

## Resource discovery

Prefer discovery-first diagnostics instead of relying on hardcoded resource names.

Discover Function Apps:

```bash
az resource list \
  --resource-group <resource-group> \
  --resource-type Microsoft.Web/sites \
  --query "[].{name:name,kind:kind,location:location}" \
  --output table
```

Discover Application Insights resources:

```bash
az resource list \
  --resource-group <resource-group> \
  --resource-type Microsoft.Insights/components \
  --query "[].{name:name,id:id,location:location}" \
  --output table
```

Resolve the production base URL in this order:

1. Use the workflow summary or deployment output `effectiveBaseUrl` / effective base URL when available.
2. Use `PRODUCTION_BASE_URL` only if it is set as a GitHub variable.
3. Discover the Function App `defaultHostName` and use `https://<defaultHostName>`.

`PRODUCTION_BASE_URL` is optional and should be treated as an override, not as required state.

Example fallback discovery:

```bash
PRODUCTION_BASE_URL="$(gh variable get PRODUCTION_BASE_URL --repo JueZ/api 2>/dev/null || true)"
if [ -n "$PRODUCTION_BASE_URL" ]; then
  printf '%s\n' "$PRODUCTION_BASE_URL"
else
  function_app_name="<function-app-name-from-workflow-summary-bicep-output-or-resource-discovery>"
  default_host_name="$(az functionapp show \
    --resource-group rg-api-prod \
    --name "$function_app_name" \
    --query defaultHostName \
    --output tsv)"
  printf 'https://%s\n' "$default_host_name"
fi
```

The current production Function App name may be `func-api-catalogue-prod-bfjstshehpbfk`, but treat hardcoded names as fallback evidence only. Prefer workflow summaries, Bicep outputs, GitHub variables, or Azure resource discovery.

## GitHub Actions failure diagnostics

Use the `github-cli-devops` skill and commands such as:

```bash
gh run list --repo JueZ/api --limit 20
gh run view <run-id> --repo JueZ/api
gh run view <run-id> --repo JueZ/api --log-failed
```

Look for:

- failed workflow name
- failed job name
- failed step
- exact command that failed
- exit code
- Azure resource names
- smoke test response status
- deployment run URL
- commit SHA/source ref

Do not paste long full logs into final summaries. Summarize the relevant lines.

## Function App state diagnostics

Inspect a Function App with a narrow query:

```bash
az functionapp show \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --query "{name:name,state:state,defaultHostName:defaultHostName,kind:kind,linuxFxVersion:siteConfig.linuxFxVersion,identityType:identity.type}" \
  --output table
```

## Function App configuration diagnostics

Safe config query:

```bash
az functionapp config show \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --query "{linuxFxVersion:linuxFxVersion,ftpsState:ftpsState,alwaysOn:alwaysOn,minTlsVersion:minTlsVersion}" \
  --output table
```

App settings must be inspected by name only:

```bash
az functionapp config appsettings list \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --query "[].name" \
  --output table
```

If that command fails, use a safe ARM request that returns keys only:

```bash
az rest \
  --method post \
  --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Web/sites/<function-app-name>/config/appsettings/list?api-version=2023-12-01" \
  --body "{}" \
  --query "keys(properties)" \
  --output table
```

Never print the values of app settings.

## Function discovery diagnostics

Use:

```bash
az functionapp function list \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --query "[].{name:name,invokeUrlTemplate:invokeUrlTemplate}" \
  --output table
```

If this fails while the app is unhealthy, note that function discovery may fail because the host is not starting.

## Application Insights diagnostics

Prefer Application Insights and Azure Monitor for runtime diagnostics.

Query telemetry with Application Insights if the CLI command is available. Use recent time windows and narrow KQL.

Recent failed requests:

```kusto
requests
| where timestamp > ago(30m)
| where success == false or resultCode startswith "5" or resultCode == "401" or resultCode == "403"
| project timestamp, name, resultCode, success, duration, operation_Id
| order by timestamp desc
| take 50
```

Exceptions:

```kusto
exceptions
| where timestamp > ago(30m)
| project timestamp, type, operation_Id
| order by timestamp desc
| take 50
```

Traces:

```kusto
traces
| where timestamp > ago(30m)
| where severityLevel >= 2
| project timestamp, severityLevel, operation_Id
| order by timestamp desc
| take 100
```

Smoke correlation check:

```kusto
let since = ago(45m);
let smokeRunId = "<SMOKE_RUN_ID>";
union requests, traces, exceptions, dependencies
| where timestamp > since
| where smokeRunId != ""
| where tostring(customDimensions.smoke_run_id) == smokeRunId
   or tostring(customDimensions["smoke_run_id"]) == smokeRunId
   or tostring(customDimensions["smokeRunId"]) == smokeRunId
   or tostring(customDimensions["x-smoke-run-id"]) == smokeRunId
   or tostring(customDimensions) has smokeRunId
   or tostring(message) has smokeRunId
   or tostring(name) has smokeRunId
| project timestamp, itemType, operation_Id
| order by timestamp desc
| take 50
```

Example CLI shape:

```bash
az monitor app-insights query \
  --app <application-insights-app-id-or-name> \
  --analytics-query "<KQL>" \
  --offset 30m \
  --output table
```

If `az monitor app-insights query` is unavailable or fails, report that Application Insights CLI querying is unavailable and use available Azure Monitor or portal guidance.

Do not print full `customDimensions` if they may contain tokens or headers. Query only specific safe fields.

Telemetry smoke-correlation verification must prove observed runtime telemetry for the smoke run ID. Do not treat an input variable or workflow echo as proof that telemetry was observed.

## Azure Monitor Activity Logs

Use Activity Logs for Azure control-plane operations such as failed deployments, RBAC changes, storage config changes, Function App setting updates, and resource write failures.

Recent failed events:

```bash
az monitor activity-log list \
  --resource-group <resource-group> \
  --status Failed \
  --offset 6h \
  --max-events 50 \
  --select eventTimestamp resourceGroupName resourceProviderName resourceType operationName status subStatus correlationId \
  --output table
```

Recent events for a resource:

```bash
az monitor activity-log list \
  --resource-id <resource-id> \
  --offset 6h \
  --max-events 50 \
  --select eventTimestamp operationName status subStatus correlationId \
  --output table
```

Activity Logs are for Azure management-plane events. They are not the same as application request logs.

## Storage and package diagnostics

For run-from-package issues, inspect storage without printing URLs that contain SAS tokens.

List package container names and blob names only:

```bash
az storage container list \
  --auth-mode login \
  --account-name <storage-account> \
  --query "[].name" \
  --output table

az storage blob list \
  --auth-mode login \
  --account-name <storage-account> \
  --container-name function-releases \
  --query "[].{name:name,contentLength:properties.contentLength,lastModified:properties.lastModified}" \
  --output table
```

Check whether the Function App has managed identity:

```bash
az functionapp identity show \
  --resource-group <resource-group> \
  --name <function-app-name> \
  --query "{type:type,principalId:principalId}" \
  --output table
```

Check whether the identity has Storage Blob Data Reader:

```bash
az role assignment list \
  --assignee <function-app-principal-id> \
  --scope <storage-account-resource-id> \
  --query "[].{role:roleDefinitionName,scope:scope}" \
  --output table
```

Do not print `WEBSITE_RUN_FROM_PACKAGE` values if they include sensitive URLs.

## Entra and OIDC diagnostics

For auth failures, verify non-secret config names and expected values.

Safe checks:

- OIDC issuer URL shape
- OIDC audience value presence
- required scope value presence
- allowed object IDs presence count, not full list unless explicitly needed
- SPA client ID presence
- redirect URI presence
- API scope string presence

GitHub variable names:

```bash
gh variable list --repo JueZ/api --json name --jq '.[].name' | sort
```

Do not print user tokens.

If Entra app registration permissions are available, inspect app registrations with narrow fields:

```bash
az ad app show \
  --id <app-client-id> \
  --query "{displayName:displayName,appId:appId,identifierUris:identifierUris,signInAudience:signInAudience}" \
  --output json

az ad app show \
  --id <spa-client-id> \
  --query "{displayName:displayName,appId:appId,spa:spa}" \
  --output json
```

Standalone Entra investigation remains read-only. Scoped configuration repairs inherit an authorized fix or delivery task; new credentials or broader privileges still require explicit authorization. Use the protected repository path for production changes.

## Smoke endpoint diagnostics

Resolve the production base URL from the workflow summary/effective base URL first, then `PRODUCTION_BASE_URL` if set, then Function App `defaultHostName` discovery.

Production baseline after resolving the base URL:

```bash
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' --max-time 30 "$EFFECTIVE_BASE_URL/health"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' --max-time 30 "$EFFECTIVE_BASE_URL/api/hello"
```

Expected after auth-enabled production:

- `/health` returns 200.
- unauthenticated `/api/hello` returns 401.
- authenticated `/api/hello` returns 200 for allowlisted users.
- authenticated `POST /api/reddit/thread` returns 200 unless the Reddit dependency is blocked or unavailable.

Do not ask the user to paste bearer tokens into chat.

## Helper script

For a safe read-only baseline collection, use:

```bash
scripts/collect-azure-diagnostics.sh test
scripts/collect-azure-diagnostics.sh prod
```

The script prints resource group and Function App state, safe app setting names, recent failed Activity Log entries, Application Insights resource names, and package artifact metadata without printing app setting values or URLs.
