#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/collect-azure-diagnostics.sh <test|prod>

Collect read-only Azure diagnostics without printing secrets, app setting values,
SAS URLs, connection strings, bearer tokens, or full environment dumps.
USAGE
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

environment_name="$1"
case "$environment_name" in
  test)
    resource_group="rg-api-test"
    ;;
  prod)
    resource_group="rg-api-prod"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

section() {
  printf '\n== %s ==\n' "$1"
}

run_required() {
  local description="$1"
  shift
  section "$description"
  "$@"
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf 'ERROR: %s failed with exit code %s.\n' "$description" "$status" >&2
    exit "$status"
  fi
}

run_optional() {
  local description="$1"
  shift
  section "$description"
  "$@"
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf 'WARN: %s unavailable or not configured (exit code %s). Continuing.\n' "$description" "$status" >&2
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'ERROR: required command not found: %s\n' "$1" >&2
    exit 127
  fi
}

require_command az

# Avoid accidental default JSON dumps from Azure CLI commands that omit --output.
export AZURE_CORE_OUTPUT=none

run_required "Azure account" \
  az account show --query "{name:name,id:id,tenantId:tenantId}" --output table

run_required "Resource group ${resource_group}" \
  az group show --name "$resource_group" --query "{name:name,location:location}" --output table

section "Discover Function App"
function_apps=$(az resource list \
  --resource-group "$resource_group" \
  --resource-type Microsoft.Web/sites \
  --query "sort([?contains(kind, 'functionapp')].name)" \
  --output tsv)
status=$?
if [[ $status -ne 0 ]]; then
  printf 'ERROR: failed to discover Function Apps (exit code %s).\n' "$status" >&2
  exit "$status"
fi

mapfile -t discovered_function_apps < <(printf '%s\n' "$function_apps" | sed '/^$/d')
function_app_override="${AZURE_FUNCTIONAPP_NAME:-${FUNCTION_APP_NAME:-}}"

if [[ ${#discovered_function_apps[@]} -eq 0 ]]; then
  printf 'ERROR: no Function App found in %s.\n' "$resource_group" >&2
  exit 1
fi

if [[ -n "$function_app_override" ]]; then
  function_app=""
  for discovered_function_app in "${discovered_function_apps[@]}"; do
    if [[ "$discovered_function_app" == "$function_app_override" ]]; then
      function_app="$discovered_function_app"
      break
    fi
  done

  if [[ -z "$function_app" ]]; then
    printf 'ERROR: requested Function App override %q was not found in %s. Discovered Function Apps: %s\n' \
      "$function_app_override" \
      "$resource_group" \
      "$(printf '%s ' "${discovered_function_apps[@]}" | sed 's/ $//')" >&2
    exit 1
  fi
elif [[ ${#discovered_function_apps[@]} -eq 1 ]]; then
  function_app="${discovered_function_apps[0]}"
else
  printf 'ERROR: multiple Function Apps found in %s. Set AZURE_FUNCTIONAPP_NAME or FUNCTION_APP_NAME to one of: %s\n' \
    "$resource_group" \
    "$(printf '%s ' "${discovered_function_apps[@]}" | sed 's/ $//')" >&2
  exit 1
fi

printf '%s\n' "$function_app"

run_required "Function App state" \
  az resource show \
    --resource-group "$resource_group" \
    --resource-type Microsoft.Web/sites \
    --name "$function_app" \
    --api-version 2023-12-01 \
    --query "{name:name,state:properties.state,defaultHostName:properties.defaultHostName,kind:kind,linuxFxVersion:properties.siteConfig.linuxFxVersion,identityType:identity.type}" \
    --output table

run_required "Function App runtime configuration" \
  az functionapp config show \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "{linuxFxVersion:linuxFxVersion,ftpsState:ftpsState,alwaysOn:alwaysOn,minTlsVersion:minTlsVersion}" \
    --output table

run_optional "Function App app setting names only" \
  az functionapp config appsettings list \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "[].name" \
    --output table

run_optional "Function discovery" \
  az functionapp function list \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "[].{name:name,invokeUrlTemplate:invokeUrlTemplate}" \
    --output table

run_optional "Recent failed Activity Log entries" \
  az monitor activity-log list \
    --resource-group "$resource_group" \
    --status Failed \
    --offset 6h \
    --max-events 50 \
    --select eventTimestamp resourceGroupName resourceProviderName resourceType operationName status subStatus correlationId \
    --output table

run_optional "Application Insights resources" \
  az resource list \
    --resource-group "$resource_group" \
    --resource-type Microsoft.Insights/components \
    --query "[].{name:name,id:id,location:location}" \
    --output table

section "Safe aggregate Application Insights metrics (last 30 minutes)"
application_insights_resources=$(az resource list \
  --resource-group "$resource_group" \
  --resource-type Microsoft.Insights/components \
  --query "sort([].name)" \
  --output tsv)
status=$?
if [[ $status -ne 0 ]]; then
  printf 'WARN: failed to discover Application Insights resources (exit code %s). Skipping aggregate metrics.\n' "$status" >&2
else
  mapfile -t discovered_application_insights < <(printf '%s\n' "$application_insights_resources" | sed '/^$/d')
  if [[ ${#discovered_application_insights[@]} -eq 1 ]]; then
    application_insights_name="${discovered_application_insights[0]}"
    aggregate_query=$(cat <<'KQL'
let since = ago(30m);
print
  requestCount=toscalar(requests | where timestamp > since | count),
  failedRequestCount=toscalar(requests | where timestamp > since and success == false | count),
  serverErrorCount=toscalar(requests | where timestamp > since and toint(resultCode) between (500 .. 599) | count),
  exceptionCount=toscalar(exceptions | where timestamp > since | count),
  failedDependencyCount=toscalar(dependencies | where timestamp > since and success == false | count)
KQL
)
    run_optional "Application Insights aggregate health metrics" \
      az monitor app-insights query \
        --apps "$application_insights_name" \
        --resource-group "$resource_group" \
        --analytics-query "$aggregate_query" \
        --offset 30m \
        --query "{requestCount:tables[0].rows[0][0],failedRequestCount:tables[0].rows[0][1],serverErrorCount:tables[0].rows[0][2],exceptionCount:tables[0].rows[0][3],failedDependencyCount:tables[0].rows[0][4]}" \
        --output table
  else
    printf 'WARN: expected exactly one Application Insights resource in %s, found %s. Skipping aggregate metrics.\n' \
      "$resource_group" \
      "${#discovered_application_insights[@]}" >&2
  fi
fi

section "Discover immutable release package Storage account"
storage_accounts=$(az storage account list \
  --resource-group "$resource_group" \
  --query "sort([?tags.purpose=='immutable-release-packages'].name)" \
  --output tsv)
status=$?
if [[ $status -ne 0 ]]; then
  printf 'ERROR: failed to discover immutable release package Storage accounts (exit code %s).\n' "$status" >&2
  exit "$status"
fi
mapfile -t discovered_release_storage_accounts < <(printf '%s\n' "$storage_accounts" | sed '/^$/d')
if [[ ${#discovered_release_storage_accounts[@]} -ne 1 ]]; then
  printf 'WARN: expected exactly one Storage account tagged purpose=immutable-release-packages in %s, found %s. Skipping package artifact diagnostics.\n' \
    "$resource_group" \
    "${#discovered_release_storage_accounts[@]}" >&2
else
  storage_account="${discovered_release_storage_accounts[0]}"
  printf '%s\n' "$storage_account"

  run_optional "Storage container names" \
    az storage container list \
      --auth-mode login \
      --account-name "$storage_account" \
      --query "[].name" \
      --output table

  run_optional "Function package blob metadata" \
    az storage blob list \
      --auth-mode login \
      --account-name "$storage_account" \
      --container-name function-releases \
      --query "[].{name:name,contentLength:properties.contentLength,lastModified:properties.lastModified}" \
      --output table
fi

run_optional "Function App managed identity" \
  az functionapp identity show \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "{type:type,principalId:principalId}" \
    --output table
