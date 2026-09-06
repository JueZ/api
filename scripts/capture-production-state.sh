#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-}"
allow_noncoherent="${2:-false}"
: "${output_dir:?Usage: capture-production-state.sh <output-directory> [allow-partial]}"
: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"
: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${AZURE_FUNCTIONAPP_NAME:?AZURE_FUNCTIONAPP_NAME is required}"
: "${PRODUCTION_BASE_URL:?PRODUCTION_BASE_URL is required}"
if [ "${ENVIRONMENT_NAME:-}" != "prod" ]; then
  echo "Production state capture may run only for prod." >&2
  exit 1
fi

mkdir -p "$output_dir"
# Resolve the existing deployment before reading its data plane. Repository
# variables can predate the current split between host, release and web storage.
deployment_outputs="$(az deployment group show --resource-group "$AZURE_RESOURCE_GROUP" --name main-prod --query properties.outputs -o json)"
deployed_function="$(jq -er '.functionAppResourceName.value | select(length > 0)' <<<"$deployment_outputs")"
static_storage="$(jq -er '.staticWebStorageAccountResourceName.value | select(length > 0)' <<<"$deployment_outputs")"
release_storage="$(jq -er '.releaseStorageAccountResourceName.value | select(length > 0)' <<<"$deployment_outputs")"
if [ "$deployed_function" != "$AZURE_FUNCTIONAPP_NAME" ]; then
  echo "Deployed Function resource does not match the configured production target." >&2
  exit 1
fi
frontend_url="$(az storage account show --resource-group "$AZURE_RESOURCE_GROUP" --name "$static_storage" --query primaryEndpoints.web -o tsv)"
: "${frontend_url:?Production static website endpoint is unavailable}"
settings_file="$output_dir/app-settings.json"
settings_url="https://management.azure.com/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Web/sites/$AZURE_FUNCTIONAPP_NAME/config/appsettings/list?api-version=2023-12-01"
az rest \
  --method post \
  --url "$settings_url" \
  --body '{}' \
  --output json \
  | jq '[.properties | to_entries[] | select(.key == "DEPLOYED_SOURCE_REF" or .key == "DEPLOYED_COMMIT_SHA" or .key == "DEPLOYMENT_RUN_ID" or .key == "DELIVERY_CORRELATION" or .key == "DELIVERY_MUTATION_RUN_ID" or .key == "DELIVERY_MUTATION_CORRELATION" or .key == "DELIVERY_MUTATION_CONTROLLER_SHA" or .key == "DELIVERY_MUTATION_KIND" or .key == "RELEASE_FUNCTION_SHA256" or .key == "RELEASE_FRONTEND_SHA256" or .key == "RELEASE_SBOM_SHA256" or .key == "WEBSITE_RUN_FROM_PACKAGE" or .key == "WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID") | {name:.key,value:.value}]' \
  > "$settings_file"

package_pointer="$(node scripts/production-state.mjs package-pointer --settings "$settings_file")"
package_storage="$(jq -r '.storageAccountName' <<<"$package_pointer")"
package_container="$(jq -r '.containerName' <<<"$package_pointer")"
package_blob="$(jq -r '.blobName' <<<"$package_pointer")"
package_version="$(jq -r '.versionId' <<<"$package_pointer")"
if [ "$package_storage" != "$release_storage" ]; then
  echo "Installed package pointer does not use the deployed release storage account." >&2
  exit 1
fi
package_file="$output_dir/functionapp.zip"
az storage blob download \
  --auth-mode login \
  --account-name "$package_storage" \
  --container-name "$package_container" \
  --name "$package_blob" \
  --version-id "$package_version" \
  --file "$package_file" \
  --overwrite true \
  -o none
package_digest="$(sha256sum "$package_file" | awk '{print $1}')"

frontend_dir="$output_dir/frontend"
mkdir -p "$frontend_dir"
# Azure's static-site container is literally named $web.
# shellcheck disable=SC2016
az storage blob download-batch \
  --auth-mode login \
  --account-name "$static_storage" \
  --source '$web' \
  --destination "$frontend_dir" \
  --overwrite true \
  -o none
frontend_metadata="$frontend_dir/assets/build-info.json"
[ -f "$frontend_metadata" ] || { echo "Installed frontend build metadata is missing." >&2; exit 1; }
frontend_inventory="$output_dir/frontend-inventory.json"
node scripts/frontend-inventory.mjs create "$frontend_dir" "$frontend_inventory"

health_file="$output_dir/health.json"
health_status="unavailable"
if curl --fail --show-error --silent --max-time 20 "${PRODUCTION_BASE_URL%/}/health" > "$health_file"; then
  health_status="available"
else
  rm -f -- "$health_file"
fi

resource_file="$output_dir/resource.json"
jq -n \
  --arg environmentName "$ENVIRONMENT_NAME" \
  --arg resourceGroup "$AZURE_RESOURCE_GROUP" \
  --arg functionAppName "$AZURE_FUNCTIONAPP_NAME" \
  --arg staticStorageAccountName "$static_storage" \
  --arg releaseStorageAccountName "$release_storage" \
  --arg apiBaseUrl "${PRODUCTION_BASE_URL%/}" \
  --arg frontendUrl "${frontend_url%/}" \
  '{environmentName:$environmentName,resourceGroup:$resourceGroup,functionAppName:$functionAppName,staticStorageAccountName:$staticStorageAccountName,releaseStorageAccountName:$releaseStorageAccountName,apiBaseUrl:$apiBaseUrl,frontendUrl:$frontendUrl}' \
  > "$resource_file"

args=(
  observe
  --settings "$settings_file"
  --frontend-metadata "$frontend_metadata"
  --frontend-inventory "$frontend_inventory"
  --health-status "$health_status"
  --package-digest "$package_digest"
  --resource "$resource_file"
  --json-output "$output_dir/observation.json"
  --allow-noncoherent "$allow_noncoherent"
)
if [ "$health_status" = "available" ]; then args+=(--health "$health_file"); fi
node scripts/production-state.mjs "${args[@]}"
