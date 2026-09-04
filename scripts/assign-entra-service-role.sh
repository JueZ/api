#!/usr/bin/env bash
set -euo pipefail

# Idempotently assign an enabled API application role to service principals.
# The Azure CLI identity needs Entra/Graph authority; subscription RBAC alone
# does not grant permission to create an app-role assignment.

API_APP_ID="${API_APP_ID:-}"
SERVICE_ROLE_VALUE="${SERVICE_ROLE_VALUE:-youtube.service.read}"
SERVICE_PRINCIPAL_CLIENT_IDS="${SERVICE_PRINCIPAL_CLIENT_IDS:-}"

for required_command in az jq; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

if [ -z "$API_APP_ID" ] || [ -z "$SERVICE_PRINCIPAL_CLIENT_IDS" ]; then
  cat >&2 <<'USAGE'
API_APP_ID and SERVICE_PRINCIPAL_CLIENT_IDS are required.

Example:
  API_APP_ID='<API application client ID>' \
  SERVICE_PRINCIPAL_CLIENT_IDS='<test smoke client ID>,<production smoke client ID>' \
  SERVICE_ROLE_VALUE='youtube.service.read' \
  ./scripts/assign-entra-service-role.sh
USAGE
  exit 1
fi

resource_object_id="$(az ad sp show --id "$API_APP_ID" --query id --output tsv)"
role_id="$(az ad app show --id "$API_APP_ID" \
  --query "appRoles[?value=='$SERVICE_ROLE_VALUE' && isEnabled].id | [0]" --output tsv)"

if [ -z "$resource_object_id" ] || [ -z "$role_id" ]; then
  echo "The API service principal or enabled '$SERVICE_ROLE_VALUE' role was not found." >&2
  exit 1
fi

IFS=',' read -r -a client_ids <<<"$SERVICE_PRINCIPAL_CLIENT_IDS"
for client_id in "${client_ids[@]}"; do
  client_id="${client_id//[[:space:]]/}"
  [ -n "$client_id" ] || continue
  principal_object_id="$(az ad sp show --id "$client_id" --query id --output tsv)"
  assignments_url="https://graph.microsoft.com/v1.0/servicePrincipals/$principal_object_id/appRoleAssignments"
  assignment_count="$(az rest --method GET --url "$assignments_url" \
    --query "length(value[?resourceId=='$resource_object_id' && appRoleId=='$role_id'])" --output tsv)"

  if [ "$assignment_count" = "0" ]; then
    assignment_body="$(jq -nc \
      --arg principalId "$principal_object_id" \
      --arg resourceId "$resource_object_id" \
      --arg appRoleId "$role_id" \
      '{principalId:$principalId, resourceId:$resourceId, appRoleId:$appRoleId}')"
    az rest --method POST --url "$assignments_url" \
      --headers Content-Type=application/json --body "$assignment_body" \
      --only-show-errors --output none
    echo "Assigned '$SERVICE_ROLE_VALUE' to service principal client ID '$client_id'."
  else
    echo "Verified '$SERVICE_ROLE_VALUE' on service principal client ID '$client_id'."
  fi
done
