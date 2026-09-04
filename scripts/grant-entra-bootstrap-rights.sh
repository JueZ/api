#!/usr/bin/env bash
set -euo pipefail

AUTOMATION_APP_ID="${AUTOMATION_APP_ID:-}"
APPLY="${APPLY:-false}"

if [[ -z "$AUTOMATION_APP_ID" ]]; then
  echo 'AUTOMATION_APP_ID is required and must identify the automation service principal.' >&2
  exit 1
fi

for command_name in az jq; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required." >&2; exit 1; }
done

graph_sp_id="$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id --output tsv)"
automation_sp_id="$(az ad sp show --id "$AUTOMATION_APP_ID" --query id --output tsv)"
graph_roles="$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query appRoles --output json)"

for role_value in Application.Read.All AppRoleAssignment.ReadWrite.All DelegatedPermissionGrant.ReadWrite.All; do
  role_id="$(jq -r --arg value "$role_value" '.[] | select(.value == $value and .isEnabled == true) | .id' <<<"$graph_roles" | head -1)"
  [[ -n "$role_id" ]] || { echo "Microsoft Graph role not found: $role_value" >&2; exit 1; }
  assignment_id="$(az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/${automation_sp_id}/appRoleAssignments" \
    --query "value[?resourceId=='${graph_sp_id}' && appRoleId=='${role_id}'].id | [0]" --output tsv)"
  if [[ -n "$assignment_id" ]]; then
    echo "$role_value is already assigned."
  elif [[ "$APPLY" == true ]]; then
    az rest --method POST \
      --url "https://graph.microsoft.com/v1.0/servicePrincipals/${automation_sp_id}/appRoleAssignments" \
      --headers Content-Type=application/json \
      --body "$(jq -cn --arg principalId "$automation_sp_id" --arg resourceId "$graph_sp_id" \
        --arg appRoleId "$role_id" '{principalId:$principalId,resourceId:$resourceId,appRoleId:$appRoleId}')" \
      --output none
    echo "Assigned $role_value."
  else
    echo "Would assign $role_value."
  fi
done

if [[ "$APPLY" == true ]]; then
  echo 'Bootstrap rights assigned. Sign in again so the automation receives a new Microsoft Graph token.'
else
  echo 'Dry run only. A Privileged Role Administrator must rerun with APPLY=true.'
fi
