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
    prod_function_app="func-api-catalogue-prod-bfjstshehpbfk"
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
if [[ "$environment_name" == "prod" ]]; then
  function_app="$prod_function_app"
  printf '%s\n' "$function_app"
else
  function_apps=$(az resource list \
    --resource-group "$resource_group" \
    --resource-type Microsoft.Web/sites \
    --query "[?contains(kind, 'functionapp')].name" \
    --output tsv)
  status=$?
  if [[ $status -ne 0 ]]; then
    printf 'ERROR: failed to discover Function Apps (exit code %s).\n' "$status" >&2
    exit "$status"
  fi
  function_app=$(printf '%s\n' "$function_apps" | sed '/^$/d' | head -n 1)
  if [[ -z "$function_app" ]]; then
    printf 'ERROR: no Function App found in %s.\n' "$resource_group" >&2
    exit 1
  fi
  printf '%s\n' "$function_app"
fi

run_required "Function App state" \
  az functionapp show \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "{name:name,state:state,defaultHostName:defaultHostName,kind:kind,linuxFxVersion:siteConfig.linuxFxVersion,identityType:identity.type}" \
    --output table

run_required "Function App runtime configuration" \
  az functionapp config show \
    --resource-group "$resource_group" \
    --name "$function_app" \
    --query "{linuxFxVersion:linuxFxVersion,ftpsState:ftpsState,alwaysOn:alwaysOn,minTlsVersion:minTlsVersion}" \
    --output table

run_required "Function App app setting names only" \
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

section "Discover Storage account"
storage_accounts=$(az resource list \
  --resource-group "$resource_group" \
  --resource-type Microsoft.Storage/storageAccounts \
  --query "[].name" \
  --output tsv)
status=$?
if [[ $status -ne 0 ]]; then
  printf 'ERROR: failed to discover Storage accounts (exit code %s).\n' "$status" >&2
  exit "$status"
fi
storage_account=$(printf '%s\n' "$storage_accounts" | sed '/^$/d' | head -n 1)
if [[ -z "$storage_account" ]]; then
  printf 'WARN: no Storage account found in %s. Skipping package artifact diagnostics.\n' "$resource_group" >&2
else
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
