#!/usr/bin/env bash
set -euo pipefail

# Creates/configures a Microsoft Entra app-only OAuth client for service/e2e tests.
# The script intentionally creates no client secret. It uses a GitHub Actions
# federated credential so workflows can use OIDC instead of long-lived secrets.
#
# Required environment variables:
#   API_APP_ID              API app registration client/application ID.
# Optional environment variables:
#   REPOSITORY              GitHub repo owner/name. Default: JueZ/api.
#   GITHUB_ENVIRONMENT      GitHub Environment subject to trust. Default: test.
#   SERVICE_APP_DISPLAY_NAME Default: JueZ API Catalogue Service Test.
#   SERVICE_APP_ROLE_VALUES Comma-separated granular roles. Default: catalogue.read,reddit.read.
#   SERVICE_APP_ROLE_DISPLAY_NAME Prefix for created role display names.
#   SET_GITHUB_VARIABLES    true to set GitHub environment variables. Default: false.
#   OIDC_REQUIRED_SCOPES_VALUE Value to set when SET_GITHUB_VARIABLES=true.

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command az
require_command jq
require_command python3

repository="${REPOSITORY:-JueZ/api}"
github_environment="${GITHUB_ENVIRONMENT:-test}"
api_app_id="${API_APP_ID:?Set API_APP_ID to the API app registration client/application ID.}"
service_display_name="${SERVICE_APP_DISPLAY_NAME:-JueZ API Catalogue Service Test}"
role_values_csv="${SERVICE_APP_ROLE_VALUES:-${SERVICE_APP_ROLE_VALUE:-catalogue.read,reddit.read}}"
role_display_name="${SERVICE_APP_ROLE_DISPLAY_NAME:-API service access}"
set_github_variables="${SET_GITHUB_VARIABLES:-false}"
oidc_required_scopes_value="${OIDC_REQUIRED_SCOPES_VALUE:-catalogue.read,reddit.read,wlh.read,bring.read,bring.write,bring.complete,bring.remove}"

mapfile -t role_values < <(
  tr ',' '\n' <<<"$role_values_csv" |
    awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if ($0 != "" && !seen[$0]++) print $0 }'
)
if [ "${#role_values[@]}" -eq 0 ]; then
  echo "SERVICE_APP_ROLE_VALUES must contain at least one role." >&2
  exit 1
fi
for role_value in "${role_values[@]}"; do
  if [[ ! "$role_value" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    echo "Each SERVICE_APP_ROLE_VALUES entry must contain only letters, numbers, dot, underscore, colon, or hyphen." >&2
    exit 1
  fi
  if [ "$role_value" = "bring.complete" ] || [ "$role_value" = "bring.remove" ]; then
    echo "Service identities must not receive destructive Bring roles." >&2
    exit 1
  fi
done

account_tenant_id="$(az account show --query tenantId -o tsv)"
echo "Using tenant: $account_tenant_id"

api_app_object_id="$(az ad app show --id "$api_app_id" --query id -o tsv)"
api_identifier_uri="$(az ad app show --id "$api_app_id" --query 'identifierUris[0]' -o tsv)"
if [ -z "$api_identifier_uri" ] || [ "$api_identifier_uri" = "None" ]; then
  api_identifier_uri="api://$api_app_id"
fi
api_sp_object_id="$(az ad sp show --id "$api_app_id" --query id -o tsv 2>/dev/null || true)"
if [ -z "$api_sp_object_id" ]; then
  api_sp_object_id="$(az ad sp create --id "$api_app_id" --query id -o tsv)"
fi

echo "API app object ID: $api_app_object_id"
echo "API service principal object ID: $api_sp_object_id"
echo "API identifier URI: $api_identifier_uri"

role_ids=()
for role_value in "${role_values[@]}"; do
  current_roles="$(az ad app show --id "$api_app_id" --query appRoles -o json)"
  role_id="$(jq -r --arg value "$role_value" '.[] | select(.value == $value and (.isEnabled // true)) | .id' <<<"$current_roles" | head -n 1)"
  if [ -z "$role_id" ]; then
    role_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
    updated_roles="$(jq \
      --arg id "$role_id" \
      --arg value "$role_value" \
      --arg displayName "$role_display_name ($role_value)" \
      '. + [{allowedMemberTypes:["Application"], description:("Allows trusted app-only clients to call protected API routes for " + $value + "."), displayName:$displayName, id:$id, isEnabled:true, value:$value}]' \
      <<<"$current_roles")"
    az ad app update --id "$api_app_id" --set appRoles="$updated_roles" -o none
    echo "Created API app role: $role_value ($role_id)"
  else
    echo "API app role already exists: $role_value ($role_id)"
  fi
  role_ids+=("$role_id")
done

service_app_json="$(az ad app list --display-name "$service_display_name" --query '[0].{appId:appId,id:id}' -o json)"
service_app_id="$(jq -r '.appId // empty' <<< "$service_app_json")"
service_app_object_id="$(jq -r '.id // empty' <<< "$service_app_json")"
if [ -z "$service_app_id" ]; then
  service_app_json="$(az ad app create --display-name "$service_display_name" --sign-in-audience AzureADMyOrg --query '{appId:appId,id:id}' -o json)"
  service_app_id="$(jq -r '.appId' <<< "$service_app_json")"
  service_app_object_id="$(jq -r '.id' <<< "$service_app_json")"
  echo "Created service app registration: $service_display_name"
else
  echo "Using existing service app registration: $service_display_name"
fi

service_sp_object_id="$(az ad sp show --id "$service_app_id" --query id -o tsv 2>/dev/null || true)"
if [ -z "$service_sp_object_id" ]; then
  service_sp_object_id="$(az ad sp create --id "$service_app_id" --query id -o tsv)"
fi

echo "Service client/application ID: $service_app_id"
echo "Service app object ID: $service_app_object_id"
echo "Service principal object ID: $service_sp_object_id"

for index in "${!role_ids[@]}"; do
  role_id="${role_ids[$index]}"
  role_value="${role_values[$index]}"
  existing_assignment="$(az rest \
    --method GET \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$service_sp_object_id/appRoleAssignments" \
    --query "value[?resourceId=='$api_sp_object_id' && appRoleId=='$role_id'] | [0].id" \
    -o tsv 2>/dev/null || true)"
  if [ -z "$existing_assignment" ]; then
    assignment_body="$(jq -n \
      --arg principalId "$service_sp_object_id" \
      --arg resourceId "$api_sp_object_id" \
      --arg appRoleId "$role_id" \
      '{principalId:$principalId, resourceId:$resourceId, appRoleId:$appRoleId}')"
    az rest \
      --method POST \
      --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$service_sp_object_id/appRoleAssignments" \
      --headers 'Content-Type=application/json' \
      --body "$assignment_body" \
      -o none
    echo "Assigned app role $role_value to service principal."
  else
    echo "App role assignment already exists for $role_value."
  fi
done

credential_name="github-${github_environment}-service-tests"
credential_subject="repo:${repository}:environment:${github_environment}"
existing_credential="$(az ad app federated-credential list --id "$service_app_object_id" --query "[?name=='$credential_name'] | [0].name" -o tsv 2>/dev/null || true)"
if [ -z "$existing_credential" ]; then
  credential_file="$(mktemp)"
  jq -n \
    --arg name "$credential_name" \
    --arg subject "$credential_subject" \
    '{name:$name, issuer:"https://token.actions.githubusercontent.com", subject:$subject, description:"GitHub Actions OIDC for service/e2e tests", audiences:["api://AzureADTokenExchange"]}' \
    > "$credential_file"
  az ad app federated-credential create --id "$service_app_object_id" --parameters "@$credential_file" -o none
  rm -f "$credential_file"
  echo "Created federated credential subject: $credential_subject"
else
  echo "Federated credential already exists: $credential_name"
fi

if [ "$set_github_variables" = "true" ]; then
  require_command gh
  service_var_prefix='TEST'
  if [ "$github_environment" = "production" ] || [ "$github_environment" = "prod" ]; then
    service_var_prefix='PROD'
  fi
  gh variable set "${service_var_prefix}_SERVICE_AUTH_CLIENT_ID" --env "$github_environment" --repo "$repository" --body "$service_app_id"
  gh variable set "${service_var_prefix}_SERVICE_AUTH_TENANT_ID" --env "$github_environment" --repo "$repository" --body "$account_tenant_id"
  gh variable set "${service_var_prefix}_SERVICE_AUTH_SCOPE" --env "$github_environment" --repo "$repository" --body "$api_identifier_uri/.default"
  gh variable set OIDC_ALLOWED_APP_OBJECT_IDS --env "$github_environment" --repo "$repository" --body "$service_sp_object_id"
  gh variable set OIDC_ALLOWED_CLIENT_IDS --env "$github_environment" --repo "$repository" --body "$service_app_id"
  gh variable set OIDC_REQUIRED_SCOPES --env "$github_environment" --repo "$repository" --body "$oidc_required_scopes_value"
  echo "Set GitHub environment variables for $repository/$github_environment."
else
  service_var_prefix='TEST'
  if [ "$github_environment" = "production" ] || [ "$github_environment" = "prod" ]; then
    service_var_prefix='PROD'
  fi
  cat <<VALUES

GitHub environment variables to set for $repository environment '$github_environment':
  ${service_var_prefix}_SERVICE_AUTH_CLIENT_ID=$service_app_id
  ${service_var_prefix}_SERVICE_AUTH_TENANT_ID=$account_tenant_id
  ${service_var_prefix}_SERVICE_AUTH_SCOPE=$api_identifier_uri/.default
  OIDC_ALLOWED_APP_OBJECT_IDS=$service_sp_object_id
  OIDC_ALLOWED_CLIENT_IDS=$service_app_id
  OIDC_REQUIRED_SCOPES=$oidc_required_scopes_value

Re-run with SET_GITHUB_VARIABLES=true to set them automatically when gh is authenticated.
VALUES
fi
